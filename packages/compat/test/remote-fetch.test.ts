import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setRemoteStylesheetResolver } from '../src/environment.js';
import { installDomGlobals, setRefusedFetchHandler, setRemoteFiles, whenFetchesSettle } from '../src/shim/index.js';

installDomGlobals();
afterEach(() => {
  setRemoteFiles({});
  setRefusedFetchHandler(null);
  setRemoteStylesheetResolver(null);
});

describe('fetch of a remote URL', () => {
  it('reads the file a project cached for exactly that URL, and refuses any other, saying which', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-remote-'));
    const file = join(dir, 'atlas.json');
    writeFileSync(file, '{"objects":{"land":1}}');
    const url = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
    const refused: string[] = [];
    setRemoteFiles({ [url]: file });
    setRefusedFetchHandler((u) => refused.push(u));
    const response = await fetch(url);
    expect(await response.json()).toEqual({ objects: { land: 1 } });
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(fetch(`${url}?x=1`)).rejects.toThrow(/remote URLs are not available/);
    expect(refused).toEqual([`${url}?x=1`]);
  });

  it('reads a file the host has cached for the URL (fetch-deps of a Remotion project), and refuses what it cannot find', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-remote-'));
    const file = join(dir, 'track.mp3');
    writeFileSync(file, 'ID3-bytes');
    const url = 'https://remotion.media/music-visualization-demo-track.mp3';
    const refused: string[] = [];
    setRefusedFetchHandler((u) => refused.push(u));
    setRemoteStylesheetResolver((u) => (u === url ? file : null));
    const response = await fetch(url);
    expect(await response.text()).toBe('ID3-bytes');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    await expect(fetch('https://remotion.media/other.mp3')).rejects.toThrow(/remote URLs are not available/);
    expect(refused).toEqual(['https://remotion.media/other.mp3']);
    // A request that is not a plain GET is not answered with the file's bytes.
    await expect(fetch(url, { method: 'POST', body: 'x' })).rejects.toThrow(/remote URLs are not available/);
    await expect(fetch(url, { method: 'GET', body: 'x' })).rejects.toThrow();
    expect(refused).toContain(url);
    // Nor is an http URL.
    setRemoteStylesheetResolver(() => file);
    await expect(fetch('http://remotion.media/a.mp3')).rejects.toThrow(/remote URLs are not available/);
  });

  it('settles when what a page fetched at load has been drawn, including what that started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-remote-'));
    const file = join(dir, 'a.json');
    writeFileSync(file, '{}');
    setRemoteFiles({ 'https://cdn.jsdelivr.net/a.json': file, 'https://cdn.jsdelivr.net/b.json': file });
    const order: string[] = [];
    void fetch('https://cdn.jsdelivr.net/a.json')
      .then((r) => r.json())
      .then(() => {
        order.push('a');
        return fetch('https://cdn.jsdelivr.net/b.json');
      })
      .then(() => order.push('b'));
    await whenFetchesSettle();
    expect(order).toEqual(['a', 'b']);
  });
});
