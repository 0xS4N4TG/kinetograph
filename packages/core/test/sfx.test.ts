import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/font-files.js';
import * as sfx from '../src/sfx.js';
import { isSfxUrl, resolveSoundSource } from '../src/sound-source.js';
import { fixture } from './helpers.js';

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

function network(status = 200) {
  const requests: string[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    return { ok: status === 200, status, text: async () => '', arrayBuffer: async () => WAV.slice().buffer };
  };
  return { fetch, requests };
}

describe('@remotion/sfx', () => {
  it('exports the same names and URLs as the published package', () => {
    expect({ ...sfx }).toEqual(fixture('sfx.json'));
  });
});

describe('resolveSoundSource', () => {
  it('knows the URLs of the sounds and no others', () => {
    expect(isSfxUrl(sfx.whip)).toBe(true);
    expect(isSfxUrl(sfx.recordScratch)).toBe(true);
    expect(isSfxUrl('https://remotion.media/not-a-sound.wav')).toBe(false);
    expect(isSfxUrl('whip.wav')).toBe(false);
  });

  it('downloads a sound once and reads the cached copy after that', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kinetograph-sfx-test-'));
    const { fetch, requests } = network();
    const first = await resolveSoundSource(sfx.vineBoom, { fetch, cacheDir });
    expect(first.startsWith(cacheDir)).toBe(true);
    expect(first.endsWith('vine-boom.wav')).toBe(true);
    expect(new Uint8Array(await readFile(first))).toEqual(WAV);
    const second = await resolveSoundSource(sfx.vineBoom, { fetch, cacheDir });
    expect(second).toBe(first);
    expect(requests).toEqual([sfx.vineBoom]);
    // One file per sound.
    await resolveSoundSource(sfx.ding, { fetch, cacheDir });
    expect(await readdir(cacheDir)).toHaveLength(2);
  });

  it('leaves a path and any other URL as it is, without touching the network', async () => {
    const { fetch, requests } = network();
    expect(await resolveSoundSource('/p/public/boom.wav', { fetch })).toBe('/p/public/boom.wav');
    expect(await resolveSoundSource('https://example.com/a.wav', { fetch })).toBe('https://example.com/a.wav');
    expect(requests).toEqual([]);
  });

  it('says which sound it could not download', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kinetograph-sfx-test-'));
    await expect(resolveSoundSource(sfx.whoosh, { fetch: network(404).fetch, cacheDir })).rejects.toThrow(
      /cannot download the sound effect https:\/\/remotion\.media\/whoosh\.wav: HTTP status 404/,
    );
    expect(await readdir(cacheDir)).toEqual([]);
  });
});
