import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FontDownloadError } from '../src/font-files.js';
import { readLock } from '../src/lock.js';
import { lockedFontFile, makeRemoteAssetResolver, prefetchRemoteAssets, prefetchStylesheetFonts, verifyLocked } from '../src/remote-assets.js';

async function fetchFileCachedFor(url: string, cacheDir: string): Promise<void> {
  const { fetchFileCached } = await import('../src/font-files.js');
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([7]).buffer, text: async () => '' });
  await fetchFileCached(url, { cacheDir, fetch: fetch as never });
}

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

  it('pre-downloads into the cache and the lock, and a render then reads the cache only', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const url = 'https://x.test/img/a.png';
    const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => '', headers: { get: () => null } });
    const done = await prefetchRemoteAssets([url], { cacheDir, lockFile, fetch: fetch as never });
    expect(done.fetched).toEqual([url]);
    expect(readLock(lockFile).files[url]!.size).toBe(3);

    const notes: string[] = [];
    const fetchSync = (): Uint8Array => {
      throw new Error('the render must not download');
    };
    const path = makeRemoteAssetResolver((m) => notes.push(m), { fetchSync, cacheDir, lockFile })(url);
    expect(path).not.toBeNull();
    expect(notes).toEqual([]);
    expect((await prefetchRemoteAssets([url], { cacheDir, lockFile, fetch: fetch as never })).cached).toEqual([url]);
  });

  it('pre-downloads the font files a downloaded stylesheet names, into the font cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const fontCacheDir = await mkdtemp(join(tmpdir(), 'kg-fonts-'));
    const sheet = 'https://fonts.googleapis.com/css2?family=Inter:wght@500';
    const css = `@font-face { font-family: 'Inter'; font-weight: 500; src: url(https://fonts.gstatic.com/s/inter/v20/inter-500.ttf) format('truetype'); }`;
    const requested: string[] = [];
    const fetch = async (url: string) => {
      requested.push(url);
      const bytes = url === sheet ? new TextEncoder().encode(css) : new Uint8Array([9, 9]);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer, text: async () => css, headers: { get: () => null } };
    };
    await prefetchRemoteAssets([sheet], { cacheDir, fetch: fetch as never });
    const done = await prefetchStylesheetFonts([sheet], { cacheDir, fontCacheDir, fetch: fetch as never });
    expect(done).toEqual({ fetched: 1, failed: [] });
    expect(requested).toEqual([sheet, 'https://fonts.gstatic.com/s/inter/v20/inter-500.ttf']);
    expect((await readdir(fontCacheDir)).length).toBe(1);
  });

  it('locks the fonts and nested stylesheets a stylesheet names, and a render checks a font against the lock', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const fontCacheDir = await mkdtemp(join(tmpdir(), 'kg-fonts-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const top = 'https://fonts.example/css/top.css';
    const nested = 'https://fonts.example/css/nested.css';
    const texts: Record<string, string> = {
      [top]: `@import "nested.css";\n@font-face { font-family: A; src: url(../f/a.ttf); }\n@font-face { font-family: B; src: url(http://plain.test/b.ttf); }`,
      [nested]: '@font-face { font-family: C; src: url(c.ttf); }',
    };
    const requested: string[] = [];
    const fetch = async (url: string) => {
      requested.push(url);
      const bytes = new TextEncoder().encode(texts[url] ?? `font ${url}`);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer, text: async () => '', headers: { get: () => null } };
    };
    await prefetchRemoteAssets([top], { cacheDir, lockFile, fetch: fetch as never });
    const done = await prefetchStylesheetFonts([top], { cacheDir, fontCacheDir, lockFile, fetch: fetch as never });
    expect(done).toEqual({ fetched: 2, failed: [] });
    // The plain-http font is not followed; the nested stylesheet is downloaded and locked.
    expect(requested).toEqual([top, nested, 'https://fonts.example/f/a.ttf', 'https://fonts.example/css/c.ttf']);
    expect(Object.keys(readLock(lockFile).files).sort()).toEqual([nested, top, 'https://fonts.example/css/c.ttf', 'https://fonts.example/f/a.ttf'].sort());
    const font = 'https://fonts.example/f/a.ttf';
    const file = (await import('../src/font-files.js')).fileCachePath(font, { cacheDir: fontCacheDir });
    expect(() => verifyLocked(font, file, { lockFile })).not.toThrow();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'changed');
    expect(() => verifyLocked(font, file, { lockFile })).toThrow(/does not match/);
  });

  it('a render finds a remote stylesheet font only when it is cached and locked, and never downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const fontCacheDir = await mkdtemp(join(tmpdir(), 'kg-fonts-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const sheet = 'https://fonts.example/css/s.css';
    const font = 'https://fonts.example/f/a.ttf';
    const fetch = async (url: string) => {
      const bytes = new TextEncoder().encode(url === sheet ? '@font-face { font-family: A; src: url(../f/a.ttf); }' : 'font');
      return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer, text: async () => '', headers: { get: () => null } };
    };
    // Cached in the font cache by another route, but not in the lock: not used.
    await fetchFileCachedFor(font, fontCacheDir);
    expect(lockedFontFile(font, { fontCacheDir, lockFile })).toBeNull();
    await prefetchRemoteAssets([sheet], { cacheDir, lockFile, fetch: fetch as never });
    await prefetchStylesheetFonts([sheet], { cacheDir, fontCacheDir, lockFile, fetch: fetch as never });
    expect(lockedFontFile(font, { fontCacheDir, lockFile })).not.toBeNull();
    expect(lockedFontFile('https://fonts.example/f/other.ttf', { fontCacheDir, lockFile })).toBeNull();
  });

  it('with cachedOnly answers only a file that is cached and locked, and never downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const url = 'https://fonts.example/css/s.css';
    const fetchSync = (): Uint8Array => {
      throw new Error('the render must not download');
    };
    const notes: string[] = [];
    const resolve = makeRemoteAssetResolver((m) => notes.push(m), { fetchSync, cacheDir, lockFile, cachedOnly: true });
    expect(resolve(url)).toBeNull();
    expect(notes[0]).toMatch(/not downloaded and locked.*fetch-deps/);
    const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer, text: async () => '', headers: { get: () => null } });
    await prefetchRemoteAssets([url], { cacheDir, lockFile, fetch: fetch as never });
    expect(makeRemoteAssetResolver(() => {}, { fetchSync, cacheDir, lockFile, cachedOnly: true })(url)).not.toBeNull();
  });

  it('stops when the cached file no longer matches the lock', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const url = 'https://x.test/img/b.png';
    const resolve = makeRemoteAssetResolver(() => {}, { fetchSync: () => new Uint8Array([9]), cacheDir, lockFile });
    const path = resolve(url)!;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, new Uint8Array([8, 8]));
    expect(() => makeRemoteAssetResolver(() => {}, { cacheDir, lockFile })(url)).toThrow(/kinetograph\.lock\.json.*--update/);
  });

  it('adds a file first requested mid-render to the lock and says so; offline downloads nothing', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kg-assets-'));
    const lockFile = join(cacheDir, 'kinetograph.lock.json');
    const notes: string[] = [];
    const fetchSync = (): Uint8Array => new Uint8Array([4, 4]);
    expect(makeRemoteAssetResolver((m) => notes.push(m), { fetchSync, cacheDir, lockFile })('https://x.test/late.png')).not.toBeNull();
    expect(notes[0]).toMatch(/first requested during the render/);
    expect(readLock(lockFile).files['https://x.test/late.png']!.size).toBe(2);

    const offlineNotes: string[] = [];
    const offline = makeRemoteAssetResolver((m) => offlineNotes.push(m), { fetchSync, cacheDir, lockFile, offline: true });
    expect(offline('https://x.test/other.png')).toBeNull();
    expect(offlineNotes[0]).toMatch(/--offline/);
  });
});
