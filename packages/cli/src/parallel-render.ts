// `render --concurrency N` (packages/cli/skills/kinetograph/references/AUTHORING.md §9): N worker threads each run the composition's JS and draw frames with a
// renderer of their own, and this thread feeds the encoder in frame order. Rendering is a pure function of (project,
// frame), so a frame is the same whichever worker draws it.

import { Worker } from 'node:worker_threads';
import type { ArtifactRecord } from '@kinetographdev/core';
import type { AudioClipJson, Unsupported } from '@kinetographdev/scene';
import { CliError } from './errors.js';
import type { ImageFormat } from './image-sequence.js';
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

/** Frames each worker draws, on average and after its chunk's first, before the workers are judged (`gpuBound`, `adaptive`). */
const JUDGE_FRAMES = 8;

/**
 * Workers that wait for the GPU more than this share of their time are held up by the GPU they share, not their own
 * work (`KINETOGRAPH_GPU_BOUND`: 0 hands every render back to the main thread, above 1 none).
 */
const GPU_BOUND = process.env.KINETOGRAPH_GPU_BOUND === undefined ? 0.5 : Number(process.env.KINETOGRAPH_GPU_BOUND);

/**
 * Whether workers that spent `busyMs` on frames, `gpuWaitMs` of it waiting for the GPU (`takeGpuWaitMs`), were held up
 * by it. Each worker has a GPU device of its own, which the GPU switches between, and draws a frame with less overlap
 * than the main thread's writer, so a render held up by the GPU is no faster with workers, and often slower.
 */
export function gpuBound(gpuWaitMs: number, busyMs: number): boolean {
  return gpuWaitMs > GPU_BOUND * busyMs;
}

export interface ParallelOptions {
  spec: WorkerSpec;
  /** `render --scale`: the factor the scenes are drawn at (1 for full size). */
  scale: number;
  /** The pixel format the workers convert to, which the writer's encoder takes (`resolveExport`'s `convertFormat`); unused with `sequence`. */
  convertFormat: string;
  /** Draw each frame as an image file of this format (`render --sequence`) instead of converting it for an encoder. */
  sequence?: ImageFormat;
  /** Run React's development build in the workers. */
  devReact: boolean;
  preferredEffectBackend?: string;
  workers: number;
  /**
   * Judge the workers once they have drawn `JUDGE_FRAMES` frames each past the first (`gpuBound`): held up by the GPU,
   * they stop after the frames they have begun, and the caller draws the rest (after the last frame `onPushed` saw).
   * For a worker count the user did not set.
   */
  adaptive?: boolean;
  /** The frames drawn are numbered `0..count-1` here; index `i` is frame `origin + i * step` of the composition. */
  origin: number;
  step: number;
  count: number;
  /** Takes frame `index` once, in order: its converted pixels, or with `sequence` the bytes of its image file. */
  push(index: number, data: Buffer): void;
  /**
   * Called for each frame (by its index) in order, before it is pushed; throwing stops the render.
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
  /** When its chunk was given, and how many frames the chunk's start plays through to reach it (`playedTo`). */
  givenAt: number;
  played: number;
  /** When the last frame of its chunk reached this thread; NaN before the first. */
  lastAt: number;
}

/** The frames a worker whose last chunk ended at `lastEnd` (-2 for none) plays through to start a chunk at `first`. */
function playedTo(lastEnd: number, first: number): number {
  if (lastEnd >= 0 && first === lastEnd + 1) return 0;
  // Forward it plays from where it is; back, or with nothing drawn yet, the composition starts over.
  return lastEnd >= 0 && first > lastEnd ? first - lastEnd - 1 : first;
}

/**
 * Draws frames `first..=last` with `workers` workers and pushes them in order. Returns the `<Artifact>`
 * files the frames asked for (the one a later frame recorded wins, as it does in one run).
 *
 * Chunks are handed out in frame order, none starting further than a window of frames past the next frame the encoder
 * needs. A worker with nothing it may take splits the chunk of a busy one: the tail of that chunk, not yet started,
 * goes to the idle worker. So the heavy stretches of a film are shared and the render does not wait on one chunk.
 */
export async function renderInParallel(options: ParallelOptions): Promise<ArtifactRecord[]> {
  const { workers: count } = options;
  const first = 0;
  let last = options.count - 1;
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
    /**
     * What frames have cost so far, as they reach this thread: a frame drawn, and a frame a chunk start plays through
     * (its JS runs, nothing is drawn; a page with GSAP plays every frame it jumps). A split is judged by them.
     */
    const cost = { drawn: 0, drawMs: 0, played: 0, playMs: 0 };
    const artifacts = new Map<string, ArtifactRecord>();
    let finished = 0;
    let finishing = false;
    /** Until the workers are judged (`adaptive`): their time on frames, and of that, waiting for the GPU. */
    let judged = !options.adaptive;
    const gpu = { frames: 0, busyMs: 0, waitMs: 0 };
    /** Split answers still to come once the workers are found held up by the GPU and told to stop (`judge`). */
    let cutting = 0;

    /** The last frame from the next one to push on that has arrived or is still to come from a worker's chunk. */
    const frontier = (): number => {
      let frame = nextFrame;
      const coming = (f: number): boolean => [...lanes.values()].some((lane) => lane.job && lane.job.first <= f && f <= lane.job.last);
      while (frame <= last && (arrived.has(frame) || coming(frame))) frame += 1;
      return frame - 1;
    };

    /**
     * Held up by the GPU, the workers stop after the frames they have begun and give out no more chunks; the frames
     * up to the first gap are pushed, and the caller draws the rest.
     */
    const judge = (): void => {
      judged = true;
      const bound = gpuBound(gpu.waitMs, gpu.busyMs);
      if (log) log.add({ kind: 'judged', share: gpu.waitMs / gpu.busyMs, bound: bound ? 1 : 0, t: now() });
      if (!bound) return;
      last = Math.min(last, nextStart - 1);
      returned.length = 0;
      // An answer to a split asked for before is still to come too.
      cutting = splitting ? 1 : 0;
      splitting = true;
      for (const lane of lanes.values()) {
        if (!lane.job) continue;
        lane.worker.postMessage({ type: 'split', at: lane.progress + 1 } satisfies ToWorker);
        cutting += 1;
      }
      if (cutting === 0) {
        last = frontier();
        drain();
      }
    };

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

    /**
     * Asks a busy worker with enough left to give up the tail of its chunk to the idle worker `thief`. Once frames have
     * been timed, the tail is the one that ends the pair's work soonest counting what the thief's start plays through,
     * and a split that would not end it sooner than the busy worker alone is not made; before, the worker furthest back
     * gives up the second half.
     */
    const split = (thief: Lane): void => {
      if (splitting) return;
      const drawMs = cost.drawn > 0 ? cost.drawMs / cost.drawn : undefined;
      const playMs = cost.played > 0 ? cost.playMs / cost.played : undefined;
      let best: { lane: Lane; at: number; gain: number } | undefined;
      for (const lane of lanes.values()) {
        if (!lane.job) continue;
        const left = lane.job.last - lane.progress;
        if (left < 2 * MIN_SPLIT) continue;
        let at = Math.floor((lane.progress + lane.job.last) / 2) + 1;
        let gain = -lane.job.first;
        if (drawMs !== undefined && playMs !== undefined) {
          // The busy worker draws `keep` frames while the thief plays to the tail and draws the rest: as even as can be.
          const keep = Math.round((left + (playedTo(thief.lastEnd, at) * playMs) / drawMs) / 2);
          if (left - keep < MIN_SPLIT) continue;
          at = lane.progress + 1 + keep;
          const pair = Math.max(keep * drawMs, playedTo(thief.lastEnd, at) * playMs + (left - keep) * drawMs);
          gain = left * drawMs - pair;
          if (gain <= 0) continue;
        }
        if (!best || gain > best.gain) best = { lane, at, gain };
      }
      if (!best) return;
      splitting = true;
      best.lane.worker.postMessage({ type: 'split', at: best.at } satisfies ToWorker);
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
        lane.givenAt = nowMs();
        lane.played = playedTo(lane.lastEnd, next.job.first);
        lane.lastAt = Number.NaN;
        lane.worker.postMessage({ type: 'chunk', first: next.job.first, last: next.job.last } satisfies ToWorker);
      }
      if (idle.length > 0) split(idle[0]!);
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
          options.push(nextFrame, Buffer.from(message.data));
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
        if (nextFrame > last && !finishing) {
          finishing = true;
          for (const worker of pool) worker.postMessage({ type: 'finish' } satisfies ToWorker);
        }
      } catch (error) {
        stop(error);
      }
    };

    /** Counts what the frame of `lane` that has just arrived cost: the first of a chunk includes the chunk's start. */
    const timeFrame = (lane: Lane): void => {
      const at = nowMs();
      const first = Number.isNaN(lane.lastAt);
      const ms = at - (first ? lane.givenAt : lane.lastAt);
      lane.lastAt = at;
      if (!first || lane.played === 0) {
        cost.drawn += 1;
        cost.drawMs += ms;
        return;
      }
      // A chunk's first frame: what it took past one drawn frame is the frames its start played through.
      const drawMs = cost.drawn > 0 ? cost.drawMs / cost.drawn : ms / (lane.played + 1);
      cost.played += lane.played;
      cost.playMs += Math.max(0, ms - drawMs);
      lane.played = 0;
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
          timeFrame(lane);
          if (message.busyMs > 0) {
            gpu.busyMs += message.busyMs;
            gpu.waitMs += message.gpuWaitMs;
            gpu.frames += 1;
          }
          arrived.set(message.frame, message);
          if (!judged && gpu.frames >= count * JUDGE_FRAMES) judge();
          drain();
          break;
        case 'split':
          if (cutting > 0) {
            if (lane.job && message.first <= message.last) lane.job.last = message.first - 1;
            cutting -= 1;
            if (cutting === 0) {
              splitting = false;
              last = frontier();
              drain();
            }
            break;
          }
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
        sequence: options.sequence,
        devReact: options.devReact,
        preferredEffectBackend: options.preferredEffectBackend,
        origin: options.origin,
        step: options.step,
      };
      const worker = new Worker(new URL('./render-worker.js', import.meta.url), { workerData: init });
      lanes.set(worker, { worker, lastEnd: -2, progress: -1, givenAt: 0, played: 0, lastAt: Number.NaN });
      worker.on('message', (message: FromWorker) => onMessage(worker, message));
      worker.on('error', (error) => stop(error));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) stop(new CliError('RENDER_FAILED', `a render worker exited with code ${code}`));
      });
      pool.push(worker);
    }
  });
}
