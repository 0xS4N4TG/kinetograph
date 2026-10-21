import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FontDownloadError } from '../src/font-files.js';
import { makeRemoteAssetResolver } from '../src/remote-assets.js';

describe('the remote asset resolver', () => {
  it('downloads a file once into the cache and answers from memory and then from disk', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    let calls = 0;
    const fetchSync = () => {
      calls++;
      return new Uint8Array([5, 6, 7]);
    };
    const resolve = makeRemoteAssetResolver(() => {}, { fetchSync, cacheDir });
    const path = resolve('https://x.test/img/a.png')!;
    expect(path.startsWith(cacheDir)).toBe(true);
    expect(path.endsWith('a.png')).toBe(true);
    expect([...(await readFile(path))]).toEqual([5, 6, 7]);
    expect(resolve('https://x.test/img/a.png')).toBe(path);
    // A new resolver (a new process) reads the file that is there.
    expect(makeRemoteAssetResolver(() => {}, { fetchSync, cacheDir })('https://x.test/img/a.png')).toBe(path);
    expect(calls).toBe(1);
  });

  it('notes a download that fails once, and answers null', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const notes: string[] = [];
    const fetchSync = (url: string): Uint8Array => {
      throw new FontDownloadError(url, 404);
    };
    const resolve = makeRemoteAssetResolver((m) => notes.push(m), { fetchSync, cacheDir });
    expect(resolve('https://x.test/gone.png')).toBeNull();
    expect(resolve('https://x.test/gone.png')).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/gone\.png.*HTTP status 404/);
  });
});
