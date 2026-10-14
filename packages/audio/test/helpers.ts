import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A mono 16-bit PCM WAV file. */
export function wav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Writes `samples` as a WAV file in a fresh temp directory and returns the directory and the file name. */
export function writeWav(samples: Float32Array, sampleRate: number, name = 'clip.wav'): { dir: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-audio-test-'));
  writeFileSync(join(dir, name), wav(samples, sampleRate));
  return { dir, name };
}

export function sine(freq: number, amplitude: number, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate));
  return out;
}

/** Peak magnitude of `channel` between `from` and `to` seconds. */
export function peakBetween(channel: Float32Array, sampleRate: number, from: number, to: number): number {
  let peak = 0;
  const end = Math.min(channel.length, Math.round(to * sampleRate));
  for (let i = Math.round(from * sampleRate); i < end; i++) peak = Math.max(peak, Math.abs(channel[i]!));
  return peak;
}
