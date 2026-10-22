// A render worker (`render --concurrency N`, docs/AUTHORING.md §9): a worker thread that opens the composition itself,
// runs its JS for the chunks of frames it is given, draws them with a renderer of its own and posts the pixels back.

import { parentPort, workerData } from 'node:worker_threads';
import type { ArtifactRecord } from '@kinetograph/core';
import type { SceneJson, Unsupported, AudioClipJson } from '@kinetograph/scene';
import { native } from './native.js';
import { ProfileLog, now, profiling, takeAddon, takeJs } from './profile.js';
import { scaleScene } from './scenes.js';
import { openSource, type FrameOutput, type WorkerSpec } from './source.js';

export interface WorkerInit {
  spec: WorkerSpec;
  scale: number;
  /** The pixel format to convert drawn frames to (`resolveExport`'s `convertFormat`). */
  convertFormat: string;
  devReact: boolean;
  /** Index `i` of a chunk is frame `origin + i * step` of the composition (`step` is above 1 for a GIF's `--every-nth-frame`). */
  origin: number;
  step: number;
}

/** Main to worker. */
export type ToWorker =
  | { type: 'chunk'; first: number; last: number }
  /** Stop the running chunk before frame `at` if it has not got that far; answered with a `split`. */
  | { type: 'split'; at: number }
  | { type: 'finish' };

/** Worker to main. */
export type FromWorker =
  | { type: 'ready' }
  /** `repeated`: the frame was not drawn, being the same as the one before it in its chunk (docs/AUTHORING.md §9). */
  | { type: 'frame'; frame: number; yuv: ArrayBuffer; audio: AudioClipJson[]; unsupported: Unsupported[]; repeated: boolean }
  | { type: 'chunk'; first: number; last: number }
  /** The frames of the chunk it gave up, `first..=last` (empty when `first > last`). */
  | { type: 'split'; first: number; last: number }
  | { type: 'done'; artifacts: ArtifactRecord[] }
  | { type: 'error'; code: string | undefined; message: string };

const port = parentPort!;
const post = (message: FromWorker, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

const { spec, scale, convertFormat, devReact, origin, step } = workerData as WorkerInit;
// React reads this when the bundle imports it, which `openSource` below does.
process.env.NODE_ENV = devReact ? 'development' : 'production';

try {
  const source = await openSource(spec.entry, { comp: spec.comp, props: spec.props, bundleFile: spec.bundleFile });
  source.clearArtifacts?.();
  const renderer = new (native().Renderer)();
  const log = profiling ? new ProfileLog(false) : undefined;
  /** When the worker last finished a chunk (or became ready), to say how long it waited for the next. */
  let freeSince = log ? now() : 0;
  /** The chunk being drawn: the next frame to start and the last one. */
  let active: { next: number; end: number } | undefined;
  port.on('message', (message: ToWorker) => {
    if (message.type === 'split') {
      // Answered at once, between two frames of the running chunk: what it has begun it finishes.
      const had = active;
      const end = had ? Math.max(message.at - 1, had.next - 1) : -1;
      if (had && end < had.end) {
        post({ type: 'split', first: end + 1, last: had.end });
        had.end = end;
      } else post({ type: 'split', first: 1, last: 0 });
      return;
    }
    // Chunks queue behind each other: the handler returns at once and the work runs on a chain.
    chain = chain.then(() => handle(message)).catch(fail);
  });
  let chain: Promise<void> = Promise.resolve();

  const handle = async (message: Exclude<ToWorker, { type: 'split' }>): Promise<void> => {
    if (message.type === 'finish') {
      log?.flush();
      post({ type: 'done', artifacts: source.artifacts?.() ?? [] });
      source.dispose();
      return;
    }
    // The GPU draws a frame while this thread runs the JS of the next: a frame is started, and the one before it is
    // collected, converted and posted.
    let started: { index: number; out: FrameOutput; row?: Record<string, number> } | undefined;
    // The converted pixels of the frame before in this chunk, for a frame that repeats it.
    let last: Buffer | undefined;
    const collect = (): void => {
      const { index, out, row } = started!;
      const t0 = log ? now() : 0;
      const drawn = renderer.finishFrame();
      const t1 = log ? now() : 0;
      // The colour conversion the encoder does is done here, in parallel, so the encoder thread only has to send.
      // A frame the same as the one before (`repeated`) has that frame's pixels, so it has its conversion too.
      const pixels = drawn.repeated && last ? last : native().rgbaToYuv(drawn.data, drawn.width, drawn.height, convertFormat);
      last = pixels;
      const t2 = log ? now() : 0;
      // A copy, because it is moved to the main thread: the addon's buffer cannot be transferred.
      const yuv = new ArrayBuffer(pixels.byteLength);
      new Uint8Array(yuv).set(pixels);
      post({ type: 'frame', frame: index, yuv, audio: out.audio, unsupported: out.unsupported ?? [], repeated: drawn.repeated }, [yuv]);
      if (log && row) {
        const t3 = now();
        log.add({ ...row, finish: t1 - t0, yuv: t2 - t1, post: t3 - t2, t3, ...takeAddon() });
      }
    };
    // The order before the start had a thread of its own: start this frame, then collect the one before.
    const syncStart = process.env.KINETOGRAPH_SYNC_START !== undefined;
    const run = { next: message.first, end: message.last };
    active = run;
    const chunkStart = log ? now() : 0;
    if (log) log.add({ kind: 'chunk', first: message.first, last: message.last, t0: chunkStart, waited: chunkStart - freeSince });
    // A chunk's first frame is drawn, whatever this worker drew before: a frame is only ever taken from the frame
    // before it in the film, so the output does not depend on which worker drew what.
    renderer.forgetFrame();
    while (run.next <= run.end) {
      const index = run.next++;
      const frame = origin + index * step;
      const t0 = log ? now() : 0;
      const out = await source.frame(frame);
      const t1 = log ? now() : 0;
      const sceneJson = scale !== 1 ? JSON.stringify(scaleScene(JSON.parse(out.sceneJson) as SceneJson, scale)) : out.sceneJson;
      // The frame before is collected first: its start ran on the addon's own thread while this frame's JS did, and
      // the next start would take the GPU renderer from the collection.
      if (started && !syncStart) collect();
      const tStart = log ? now() : 0;
      renderer.startFrame(sceneJson, frame, source.baseDir);
      let row: Record<string, number> | undefined;
      if (log) {
        const t2 = now();
        // The addon's start stages and the JS ones are read now; `collect` adds the finish ones to the same row.
        row = { f: frame, t0, t1, t2, js: out.jsMs, stringify: out.stringifyMs, startFrame: t2 - tStart, ...takeJs(), ...takeAddon() };
      }
      if (started && syncStart) collect();
      started = { index, out, row };
    }
    if (started) collect();
    started = undefined;
    active = undefined;
    if (log) {
      freeSince = now();
      log.add({ kind: 'chunk-end', first: message.first, last: run.end, t1: freeSince });
      log.flush();
    }
    post({ type: 'chunk', first: message.first, last: run.end });
  };

  const fail = (error: unknown): void => {
    const e = error as { code?: string; stack?: string; message?: string } | undefined;
    post({ type: 'error', code: e?.code, message: e?.stack ?? e?.message ?? String(error) });
  };

  post({ type: 'ready' });
} catch (error) {
  const e = error as { code?: string; stack?: string; message?: string };
  post({ type: 'error', code: e?.code, message: e?.stack ?? e?.message ?? String(error) });
}
