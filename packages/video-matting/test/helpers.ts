import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatteVideoOptions, MattingAddon, ModelSpec } from '../src/testing.js';

/** A small stand-in model: 20 KiB of a pattern. */
export const BYTES = Buffer.from(Array.from({ length: 20 * 1024 }, (_, i) => (i * 31 + 7) % 251));
export const SHA = createHash('sha256').update(BYTES).digest('hex');

export function fakeModels(bytes: Buffer = BYTES, sha256 = SHA): ModelSpec[] {
  return [
    { name: 'modnet', modelId: 'test/modnet', purpose: 'People', license: 'Apache-2.0', revision: 'a'.repeat(40), file: 'onnx/model.onnx', size: bytes.length, sha256 },
    { name: 'ben2-base', modelId: 'test/ben2', purpose: 'General foreground subjects', license: 'MIT', revision: 'b'.repeat(40), file: 'onnx/model_fp16.onnx', size: bytes.length, sha256 },
  ];
}

export interface FetchLog {
  urls: string[];
  ranges: (string | null)[];
}

/**
 * A fetch that serves `bytes` in 4 KiB chunks. `failAfter` makes the body error after that many bytes; `ignoreRange`
 * answers a range request with the whole file and a 200; `status` answers with that status and no body.
 */
export function serve(bytes: Buffer, log: FetchLog, options: { failAfter?: number; ignoreRange?: boolean; status?: number; stall?: AbortController } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    log.urls.push(String(input));
    const range = new Headers(init?.headers).get('range');
    log.ranges.push(range);
    if (options.status !== undefined) return new Response(null, { status: options.status });
    const start = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const body = bytes.subarray(start);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (options.failAfter !== undefined && start + sent >= options.failAfter) {
          controller.error(new Error('connection reset'));
          return;
        }
        if (options.stall && sent >= 8192) {
          options.stall.abort(new Error('stopped by the test'));
          await new Promise((r) => setTimeout(r, 5));
        }
        if (sent >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(body.subarray(sent, Math.min(sent + 4096, body.length))));
        sent += 4096;
      },
    });
    const partial = start > 0 && !options.ignoreRange;
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: partial ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {},
    });
  }) as typeof fetch;
}

export function tempDir(prefix = 'kt-matting-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FakeAddon extends MattingAddon {
  calls: MatteVideoOptions[];
}

/**
 * An addon that "mattes" by writing marker bytes to the outputs. `frames` of progress are reported; `fail` rejects the
 * job; `hold` keeps the job running until the returned function is called.
 */
export function fakeAddon(options: { available?: boolean; frames?: number; fail?: string; hold?: Promise<void>; backend?: 'cpu' | 'coreml' } = {}): FakeAddon {
  const calls: MatteVideoOptions[] = [];
  const frames = options.frames ?? 4;
  return {
    calls,
    mattingSupport: () => ({ available: options.available ?? true, backend: options.backend ?? 'cpu', ...(options.available === false ? { reason: 'no backend here' } : {}) }),
    probeMedia: () => ({ width: 640, height: 360, durationInSeconds: 2, fps: 2, frames, hasAudio: true }),
    async matteVideo(request, onProgress) {
      calls.push(request);
      for (let i = 1; i <= frames; i++) onProgress?.(i, frames);
      await options.hold;
      if (options.fail) throw new Error(options.fail);
      writeFileSync(request.foreground, Buffer.from('FOREGROUND-ALPHA'));
      if (request.base) writeFileSync(request.base, Buffer.from('BASE'));
      return { foreground: request.foreground, ...(request.base ? { base: request.base } : {}), frames, backend: options.backend ?? 'cpu' };
    },
  };
}
