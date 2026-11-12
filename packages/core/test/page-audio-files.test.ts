// The bytes a page decodes are kept in the user's own cache, checked before use: a file or link planted at the name
// they would get is never read as the sound and never written through.

import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDeterminism, resetVirtualClock, setVirtualFrame, uninstallDeterminism } from '../src/determinism.js';
import { setAudioDecoder } from '../src/media-utils.js';
import { installPageAudio, resetPageAudio } from '../src/page-audio.js';

const g = globalThis as any;
const realHome = process.env.HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kg-page-audio-home-'));
  process.env.HOME = home;
  installDeterminism();
  resetVirtualClock();
  resetPageAudio();
  installPageAudio();
  // The decoder reads the file it is given: one sample per byte, so what was read shows in the length.
  setAudioDecoder((path) => ({ sampleRate: 48000, channels: [Float32Array.from(readFileSync(path), (b) => b / 255)] }));
});
afterEach(() => {
  process.env.HOME = realHome;
  setAudioDecoder(null);
  uninstallDeterminism();
});

const bytes = Buffer.from('the sound the page decoded');
const arrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const dir = (): string => join(home, '.cache', 'kinetograph', 'page-audio');
const name = (b: Buffer): string => join(dir(), `${createHash('sha256').update(b).digest('hex')}.bin`);

describe('decodeAudioData bytes', () => {
  it('keeps them in a private folder of the user, the same file for the same bytes', async () => {
    setVirtualFrame(0, 30);
    const ctx = new g.AudioContext();
    const first = await ctx.decodeAudioData(arrayBuffer(bytes));
    const again = await ctx.decodeAudioData(arrayBuffer(bytes));
    expect(first.file).toBe(name(bytes));
    expect(again.file).toBe(first.file);
    expect(first.length).toBe(bytes.length);
    expect(lstatSync(dir()).mode & 0o077).toBe(0);
    expect(readdirSync(dir())).toEqual([`${createHash('sha256').update(bytes).digest('hex')}.bin`]);
  });

  it('replaces a file planted at the name, and does not write through a link there', async () => {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'not for the engine to touch');
    symlinkSync(victim, name(bytes));
    setVirtualFrame(0, 30);
    const buffer = await new g.AudioContext().decodeAudioData(arrayBuffer(bytes));
    expect(readFileSync(victim, 'utf8')).toBe('not for the engine to touch');
    expect(lstatSync(name(bytes)).isSymbolicLink()).toBe(false);
    expect(readFileSync(name(bytes))).toEqual(bytes);
    expect(buffer.length).toBe(bytes.length);

    const planted = Buffer.from('somebody else wrote these');
    writeFileSync(name(planted), 'different bytes under the name of the others');
    const decoded = await new g.AudioContext().decodeAudioData(arrayBuffer(planted));
    expect(decoded.length).toBe(planted.length);
    expect(readFileSync(name(planted))).toEqual(planted);
    expect(() => readlinkSync(name(planted))).toThrow();
  });

  it('refuses a folder that is a link', async () => {
    mkdirSync(join(home, '.cache', 'kinetograph'), { recursive: true });
    mkdirSync(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), dir());
    setVirtualFrame(0, 30);
    await expect(new g.AudioContext().decodeAudioData(arrayBuffer(bytes))).rejects.toThrow(/not a folder of this user/);
  });
});
