// `render --concurrency N` (docs/AUTHORING.md §9): N worker threads each run the composition's JS and draw frames with a
// renderer of their own, and this thread feeds the encoder in frame order. Rendering is a pure function of (project,
// frame), so a frame is the same whichever worker draws it.

import { Worker } from 'node:worker_threads';
import type { VideoWriter } from '@kinetograph/native';
import type { ArtifactRecord } from '@kinetograph/core';
import type { AudioClipJson, Unsupported } from '@kinetograph/scene';
import { CliError } from './errors.js';
import type { FromWorker, ToWorker, WorkerInit } from './render-worker.js';
import type { WorkerSpec } from './source.js';

/**
 * Frames in a chunk: the unit a worker takes. A worker keeps the composition's state, its video decoders and its layer
 * cache from one frame to the next, and a chunk is a run of frames it plays forward; a small chunk bounds the frames
 * waiting for the encoder (workers x chunk x 3 MB of YUV at 1080p), a large one saves the seeking and catching up a
 * worker does when its next chunk starts further on. Measured on the launch film: 8 frames cost about 15% more CPU
 * than 64, because every chunk start seeks each video back to a keyframe.
 */
export const CHUNK_FRAMES = 60;

export interface ParallelOptions {
  spec: WorkerSpec;
  draft: boolean;
  workers: number;
  first: number;
  last: number;
  writer: VideoWriter;
  /** Called for each frame in order, before it is pushed to the encoder; throwing stops the render. */
  onFrame(frame: number, audio: AudioClipJson[], unsupported: Unsupported[]): void;
  /** Called for each frame after it is pushed. */
  onPushed?(frame: number): void;
  shouldCancel?(): boolean;
}

/**
 * Draws frames `first..=last` with `workers` workers and pushes them to `writer` in order. Returns the `<Artifact>`
 * files the frames asked for (the one a later frame recorded wins, as it does in one run).
 */
export async function renderInParallel(options: ParallelOptions): Promise<ArtifactRecord[]> {
  const { first, last, writer, workers: count } = options;
  const chunks = Math.ceil((last - first + 1) / CHUNK_FRAMES);
  // Chunks handed out but not yet written. Past this the workers wait, which bounds the frames held in memory.
  const window = count + 1;

  const pool: Worker[] = [];
  return new Promise<ArtifactRecord[]>((resolve, reject) => {
    let settled = false;
    let nextChunk = 0; // next chunk to hand out
    let writtenChunks = 0; // chunks whose frames are all pushed
    let nextFrame = first; // next frame to push
    const arrived = new Map<number, Extract<FromWorker, { type: 'frame' }>>();
    const idle: Worker[] = [];
    const artifacts = new Map<string, ArtifactRecord>();
    let finished = 0;

    const stop = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      for (const worker of pool) void worker.terminate();
      if (error === undefined) resolve([...artifacts.values()]);
      else reject(error);
    };

    const give = (): void => {
      while (idle.length > 0 && nextChunk < chunks && nextChunk < writtenChunks + window) {
        const worker = idle.shift()!;
        const from = first + nextChunk * CHUNK_FRAMES;
        const to = Math.min(last, from + CHUNK_FRAMES - 1);
        nextChunk += 1;
        worker.postMessage({ type: 'chunk', first: from, last: to } satisfies ToWorker);
      }
    };

    const drain = (): void => {
      try {
        for (let message = arrived.get(nextFrame); message; message = arrived.get(nextFrame)) {
          if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
          arrived.delete(nextFrame);
          options.onFrame(nextFrame, message.audio, message.unsupported);
          writer.pushYuv(Buffer.from(message.yuv), nextFrame);
          options.onPushed?.(nextFrame);
          nextFrame += 1;
          writtenChunks = Math.floor((nextFrame - first) / CHUNK_FRAMES);
        }
        give();
        if (nextFrame > last) for (const worker of pool) worker.postMessage({ type: 'finish' } satisfies ToWorker);
      } catch (error) {
        stop(error);
      }
    };

    const onMessage = (worker: Worker, message: FromWorker): void => {
      if (settled) return;
      switch (message.type) {
        case 'ready':
          idle.push(worker);
          give();
          break;
        case 'frame':
          arrived.set(message.frame, message);
          drain();
          break;
        case 'chunk':
          idle.push(worker);
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
      const init: WorkerInit = { spec: options.spec, draft: options.draft };
      const worker = new Worker(new URL('./render-worker.js', import.meta.url), { workerData: init });
      worker.on('message', (message: FromWorker) => onMessage(worker, message));
      worker.on('error', (error) => stop(error));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) stop(new CliError('RENDER_FAILED', `a render worker exited with code ${code}`));
      });
      pool.push(worker);
    }
  });
}
