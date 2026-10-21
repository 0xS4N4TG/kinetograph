import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Native } from '../src/native.js';

/** A PNG (8-bit RGBA, filter 0) of `rgba`, so tests need no image library. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function solidPng(width: number, height: number, [r, g, b, a]: [number, number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return encodePng(width, height, data);
}

/** `10..40` is 10 to 39, `10..=40` is 10 to 40, either end may be left out: the addon's rules. */
export function fakeParseRange(range: string, duration: number): [number, number] {
  const m = /^(\d*)\.\.(=?)(\d*)$/.exec(range);
  if (!m) throw Object.assign(new Error(`bad range "${range}"`), { code: 'INVALID_ARG' });
  const first = m[1] === '' ? 0 : Number(m[1]);
  const last = m[3] === '' ? duration - 1 : Number(m[3]) - (m[2] === '=' ? 0 : 1);
  return [first, last];
}

export interface Calls {
  still: { scene: unknown; frame: number; baseDir?: string | null }[];
  render: { scene: unknown; output: string; options: unknown }[];
  bench: { scene: unknown; options: unknown }[];
  pushed: { scene: unknown; frame: number }[];
  begun: { output: string; options: unknown }[];
  finished: unknown[];
  aborted: number;
}

/** A stand-in for the addon that records its calls and opens no GPU. */
export function fakeNative(overrides: Partial<Record<string, unknown>> = {}): { native: Native; calls: Calls } {
  const calls: Calls = { still: [], render: [], bench: [], pushed: [], begun: [], finished: [], aborted: 0 };
  const summary = (output: string, over: object = {}) => ({
    output, encoder: 'libx264', codec: 'h264', pixelFormat: 'yuv420p', width: 64, height: 36, fps: 30, frames: 3, first: 0, last: 2, ms: 10, msPerFrame: 3.3, audio: false,
    ...over,
  });
  class Writer {
    constructor(private output: string) {}
    pushFrame(scene: string, frame: number): void {
      calls.pushed.push({ scene: JSON.parse(scene), frame });
    }
    finish(audio?: unknown) {
      calls.finished.push(audio);
      return summary(this.output, { audio: audio !== undefined });
    }
    abort(): void {
      calls.aborted++;
    }
  }
  class Renderer {
    still(scene: string, frame: number, baseDir?: string | null): Buffer {
      calls.still.push({ scene: JSON.parse(scene), frame, baseDir });
      return solidPng(4, 4, [frame % 256, 0, 0, 255]);
    }
    render(scene: string, output: string, options: unknown) {
      calls.render.push({ scene: JSON.parse(scene), output, options });
      return summary(output);
    }
    bench(scene: string, options: unknown) {
      calls.bench.push({ scene: JSON.parse(scene), options });
      const s = (mean: number) => ({ mean, min: mean - 0.1, max: mean + 0.1 });
      return {
        runs: 10,
        stages: { handoff: s(0.2), resolve: s(0.5), raster: s(10), composite: s(8), readback: s(2), total: s(20) },
      };
    }
    beginVideo(output: string, options: unknown) {
      calls.begun.push({ output, options });
      return new Writer(output);
    }
  }
  const native = {
    version: () => '0.0.0-test',
    validateScene: (text: string) => {
      const s = JSON.parse(text) as { width: number; height: number; fps: number; durationInFrames: number };
      return { width: s.width, height: s.height, fps: s.fps, durationInFrames: s.durationInFrames, margin: 0 };
    },
    inspect: () => {
      throw new Error('inspect not stubbed');
    },
    parseRange: fakeParseRange,
    resolveExport: () => ({
      codec: 'h264', encoder: 'libx264', container: 'mp4', pixelFormat: 'yuv420p', convertFormat: 'yuv420p', audioCodec: 'aac',
    }),
    Renderer,
    ...overrides,
  } as unknown as Native;
  return { native, calls };
}

export function sine(freq: number, amplitude: number, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate));
  return out;
}

/** A mono 16-bit WAV file in a fresh temp directory. */
export function writeWav(samples: Float32Array, sampleRate: number, name = 'clip.wav'): { dir: string; name: string } {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-cli-wav-'));
  writeFileSync(join(dir, name), Buffer.concat([header, data]));
  return { dir, name };
}
