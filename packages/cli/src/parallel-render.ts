// `render --concurrency N` (packages/cli/skills/kinetograph/references/AUTHORING.md §9): N worker threads each run the composition's JS and draw frames with a
// renderer of their own, and this thread feeds the encoder in frame order. Rendering is a pure function of (project,
// frame), so a frame is the same whichever worker draws it.

import { Worker } from 'node:worker_threads';
import type { VideoWriter } from '@kinetograph/native';
import type { ArtifactRecord } from '@kinetograph/core';
import type { AudioClipJson, Unsupported } from '@kinetograph/scene';
import { CliError } from './errors.js';
import { ProfileLog, now, profiling, stage } from './profile.js';
import type { FromWorker, ToWorker, WorkerInit } from './render-worker.js';
import type { WorkerSpec } from './source.js';
import { nowMs } from './time.js';

/**
 * Frames in a chunk: the unit a worker takes. A worker keeps the composition's state, its video decoders and its layer
 * cache from one frame to the next, and a chunk is a run of frames it plays forward; a chunk start costs a worker the
 * frames of CSS-transition history and a seek of each video it shows, so small chunks cost CPU. Frames are not equally
 * dear (a motion-blur stretch costs several times a plain one), so a chunk that turns out heavy is split while it runs
 * (below) and the size is only where a chunk starts.
 */
export const CHUNK_FRAMES = Number(process.env.KINETOGRAPH_CHUNK) || 60;

/**
 * Frames the encoder may be behind the frontmost frame being drawn. A frame waiting for the encoder holds its YUV
 * (3 MB at 1080p), so this bounds the memory: a worker takes no chunk that starts further on.
 */
const windowFrames = (workers: number): number => Number(process.env.KINETOGRAPH_WINDOW) || (workers + 1) * CHUNK_FRAMES;

/**
 * Milliseconds the main thread spends pushing buffered frames before it yields to the event loop (0: never, the old
 * behaviour). A long run of in-order frames (a whole chunk arrives at once when the frame it waited on lands) used to
 * block this thread for a second or more, and a worker that had finished its chunk sat idle until the run ended.
 */
const DRAIN_SLICE_MS = process.env.KINETOGRAPH_DRAIN_MS === undefined ? 2 : Number(process.env.KINETOGRAPH_DRAIN_MS);

/** A running chunk with fewer than twice this many frames left is not split: the new chunk's start would cost more than it saves. */
const MIN_SPLIT = Number(process.env.KINETOGRAPH_MINSPLIT) || 8;

export interface ParallelOptions {
  spec: WorkerSpec;
  /** `render --scale`: the factor the scenes are drawn at (1 for full size). */
  scale: number;
  /** The pixel format the workers convert to, which the writer's encoder takes (`resolveExport`'s `convertFormat`). */
  convertFormat: string;
  /** Run React's development build in the workers. */
  devReact: boolean;
  workers: number;
  /** The frames drawn are numbered `0..count-1` here; index `i` is frame `origin + i * step` of the composition. */
  origin: number;
  step: number;
  count: number;
  writer: VideoWriter;
  /**
   * Called for each frame (by its index) in order, before it is pushed to the encoder; throwing stops the render.
   * `repeated`: the frame was not drawn, being the same as the one before it.
   */
  onFrame(index: number, audio: AudioClipJson[], unsupported: Unsupported[], repeated: boolean): void;
  /** Called for each frame (by its index) after it is pushed. */
  onPushed?(index: number): void;
  shouldCancel?(): boolean;
}

interface Job {
  first: number;
  last: number;
}

interface Lane {
  worker: Worker;
  /** The chunk it is drawing, `last` lowered when part of it is given to another worker. */
  job?: Job;
  /** The last frame of the chunk before, so a chunk that follows it can go to the worker that has the state for it. */
  lastEnd: number;
  /** The highest frame of its chunk that has reached this thread. */
  progress: number;
}

/**
 * Draws frames `first..=last` with `workers` workers and pushes them to `writer` in order. Returns the `<Artifact>`
 * files the frames asked for (the one a later frame recorded wins, as it does in one run).
 *
 * Chunks are handed out in frame order, none starting further than a window of frames past the next frame the encoder
 * needs. A worker with nothing it may take splits the chunk of a busy one: the tail of that chunk, not yet started,
 * goes to the idle worker. So the heavy stretches of a film are shared and the render does not wait on one chunk.
 */
export async function renderInParallel(options: ParallelOptions): Promise<ArtifactRecord[]> {
  const { writer, workers: count } = options;
  const first = 0;
  const last = options.count - 1;
  const window = windowFrames(count);

  const pool: Worker[] = [];
  const log = profiling ? new ProfileLog(true) : undefined;
  let pushMs = 0;
  const started = log ? now() : 0;
  return new Promise<ArtifactRecord[]>((resolve, reject) => {
    let settled = false;
    let nextStart = first; // first frame of the next new chunk
    let nextFrame = first; // next frame to push
    const arrived = new Map<number, Extract<FromWorker, { type: 'frame' }>>();
    const lanes = new Map<Worker, Lane>();
    const idle: Lane[] = [];
    /** Tails given up by a split, not yet taken, by first frame. */
    const returned: Job[] = [];
    let splitting = false; // a split has been asked for and not answered
    const artifacts = new Map<string, ArtifactRecord>();
    let finished = 0;

    const stop = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (log) {
        log.add({ kind: 'main', pushYuv: pushMs, wall: now() - started });
        log.flush();
      }
      for (const worker of pool) void worker.terminate();
      if (error === undefined) resolve([...artifacts.values()]);
      else reject(error);
    };

    /** The chunk to hand out next, if one may start yet: a returned tail, else a new chunk. */
    const peek = (): { job: Job; fresh: boolean } | undefined => {
      const tail = returned[0];
      if (tail) return tail.first < nextFrame + window ? { job: tail, fresh: false } : undefined;
      if (nextStart > last || nextStart >= nextFrame + window) return undefined;
      return { job: { first: nextStart, last: Math.min(last, nextStart + CHUNK_FRAMES - 1) }, fresh: true };
    };

    /** Asks the busy worker furthest back with enough left to give up the second half of its chunk. */
    const split = (): void => {
      if (splitting) return;
      let victim: Lane | undefined;
      for (const lane of lanes.values()) {
        if (!lane.job || lane.job.last - lane.progress < 2 * MIN_SPLIT) continue;
        if (!victim || lane.job.first < victim.job!.first) victim = lane;
      }
      if (!victim) return;
      splitting = true;
      const at = Math.floor((victim.progress + victim.job!.last) / 2) + 1;
      victim.worker.postMessage({ type: 'split', at } satisfies ToWorker);
    };

    const give = (): void => {
      for (let next = peek(); next && idle.length > 0; next = peek()) {
        // The worker that drew the frame before the chunk has its state in place.
        const at = idle.findIndex((lane) => lane.lastEnd + 1 === next.job.first);
        const lane = idle.splice(at === -1 ? 0 : at, 1)[0]!;
        if (next.fresh) nextStart = next.job.last + 1;
        else returned.shift();
        lane.job = next.job;
        lane.progress = next.job.first - 1;
        lane.worker.postMessage({ type: 'chunk', first: next.job.first, last: next.job.last } satisfies ToWorker);
      }
      if (idle.length > 0) split();
    };

    let drainScheduled = false;
    /** Pushes the in-order frames that have arrived, in slices so the messages behind them (a worker's finished chunk) are handled between. */
    const drain = (): void => {
      if (drainScheduled) return;
      try {
        const sliceStart = nowMs();
        let pushed = 0;
        for (let message = arrived.get(nextFrame); message; message = arrived.get(nextFrame)) {
          if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
          arrived.delete(nextFrame);
          options.onFrame(nextFrame, message.audio, message.unsupported, message.repeated);
          const t = log ? now() : 0;
          writer.pushYuv(Buffer.from(message.yuv), nextFrame);
          if (log) pushMs += now() - t;
          options.onPushed?.(nextFrame);
          nextFrame += 1;
          pushed += 1;
          if (DRAIN_SLICE_MS > 0 && nowMs() - sliceStart >= DRAIN_SLICE_MS && arrived.has(nextFrame)) {
            // The window moved: hand out what it now allows, then let queued messages run before the next slice.
            give();
            drainScheduled = true;
            setImmediate(() => {
              drainScheduled = false;
              drain();
            });
            if (log) log.add({ kind: 'drain', t0: sliceStart, t1: now(), pushed, more: 1 });
            return;
          }
        }
        if (log && pushed > 0) log.add({ kind: 'drain', t0: sliceStart, t1: now(), pushed, more: 0 });
        give();
        if (nextFrame > last) for (const worker of pool) worker.postMessage({ type: 'finish' } satisfies ToWorker);
      } catch (error) {
        stop(error);
      }
    };

    const onMessage = (worker: Worker, message: FromWorker): void => {
      if (settled) return;
      const lane = lanes.get(worker)!;
      switch (message.type) {
        case 'ready':
          stage('worker ready');
          idle.push(lane);
          give();
          break;
        case 'frame':
          if (log && message.frame === 0) stage('first frame arrived');
          lane.progress = Math.max(lane.progress, message.frame);
          arrived.set(message.frame, message);
          drain();
          break;
        case 'split':
          splitting = false;
          if (lane.job && message.first <= message.last) {
            lane.job.last = message.first - 1;
            returned.push({ first: message.first, last: message.last });
            returned.sort((a, b) => a.first - b.first);
          }
          give();
          break;
        case 'chunk':
          if (log) log.add({ kind: 'chunk-msg', first: message.first, last: message.last, t: now() });
          lane.lastEnd = lane.job?.last ?? lane.lastEnd;
          lane.job = undefined;
          idle.push(lane);
          give();
          break;
        case 'done':
          for (const record of message.artifacts) {
            const have = artifacts.get(record.filename);
            if (!have || record.frame >= have.frame) artifacts.set(record.filename, record);
          }
          finished += 1;
          if (finished === pool.length) stop();
          break;
        case 'error':
          stop(new CliError(message.code && /^[A-Z_]+$/.test(message.code) ? message.code : 'RENDER_FAILED', message.message));
          break;
      }
    };

    for (let i = 0; i < count; i++) {
      const init: WorkerInit = {
        spec: options.spec,
        scale: options.scale,
        convertFormat: options.convertFormat,
        devReact: options.devReact,
        origin: options.origin,
        step: options.step,
      };
      const worker = new Worker(new URL('./render-worker.js', import.meta.url), { workerData: init });
      lanes.set(worker, { worker, lastEnd: -2, progress: -1 });
      worker.on('message', (message: FromWorker) => onMessage(worker, message));
      worker.on('error', (error) => stop(error));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) stop(new CliError('RENDER_FAILED', `a render worker exited with code ${code}`));
      });
      pool.push(worker);
    }
  });
}
