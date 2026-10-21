// A render worker (`render --concurrency N`, docs/AUTHORING.md §9): a worker thread that opens the composition itself,
// runs its JS for the chunks of frames it is given, draws them with a renderer of its own and posts the pixels back.

import { parentPort, workerData } from 'node:worker_threads';
import type { ArtifactRecord } from '@kinetograph/core';
import type { SceneJson, Unsupported, AudioClipJson } from '@kinetograph/scene';
import { native } from './native.js';
import { draftScene } from './scenes.js';
import { openSource, type FrameOutput, type WorkerSpec } from './source.js';

export interface WorkerInit {
  spec: WorkerSpec;
  draft: boolean;
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
  | { type: 'frame'; frame: number; yuv: ArrayBuffer; audio: AudioClipJson[]; unsupported: Unsupported[] }
  | { type: 'chunk'; first: number; last: number }
  /** The frames of the chunk it gave up, `first..=last` (empty when `first > last`). */
  | { type: 'split'; first: number; last: number }
  | { type: 'done'; artifacts: ArtifactRecord[] }
  | { type: 'error'; code: string | undefined; message: string };

const port = parentPort!;
const post = (message: FromWorker, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

const { spec, draft } = workerData as WorkerInit;

try {
  const source = await openSource(spec.entry, { comp: spec.comp, props: spec.props, bundleFile: spec.bundleFile });
  source.clearArtifacts?.();
  const renderer = new (native().Renderer)();
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
      post({ type: 'done', artifacts: source.artifacts?.() ?? [] });
      source.dispose();
      return;
    }
    // The GPU draws a frame while this thread runs the JS of the next: a frame is started, and the one before it is
    // collected, converted and posted.
    let started: { frame: number; out: FrameOutput } | undefined;
    const collect = (): void => {
      const { frame, out } = started!;
      const drawn = renderer.finishFrame();
      // The colour conversion the encoder does is done here, in parallel, so the encoder thread only has to send.
      const pixels = native().rgbaToYuv(drawn.data, drawn.width, drawn.height);
      // A copy, because it is moved to the main thread: the addon's buffer cannot be transferred.
      const yuv = new ArrayBuffer(pixels.byteLength);
      new Uint8Array(yuv).set(pixels);
      post({ type: 'frame', frame, yuv, audio: out.audio, unsupported: out.unsupported ?? [] }, [yuv]);
    };
    const run = { next: message.first, end: message.last };
    active = run;
    while (run.next <= run.end) {
      const frame = run.next++;
      const out = await source.frame(frame);
      const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
      renderer.startFrame(sceneJson, frame, source.baseDir);
      if (started) collect();
      started = { frame, out };
    }
    if (started) collect();
    active = undefined;
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
