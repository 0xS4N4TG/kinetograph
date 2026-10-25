import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TextLayoutRequest } from '@kinetographdev/native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addFace, installFontFace, NodeFontFace } from '../src/font-face.js';
import { fetchFileCachedSync, FontDownloadError, type FetchLike } from '../src/font-files.js';
import { clearFonts, getFonts, pendingFontLoads, setFontProblemHandler, waitForFonts } from '../src/font-registry.js';
import { loadFont } from '../src/fonts.js';
import { makeGoogleFont } from '../src/google-fonts.js';
import { measureText, setLayoutText } from '../src/layout-utils.js';

const problems: string[] = [];
beforeEach(() => {
  clearFonts();
  problems.length = 0;
  setFontProblemHandler((message) => problems.push(message));
});
afterEach(() => setFontProblemHandler(null));

const tmp = () => mkdtemp(join(tmpdir(), 'kg-remote-font-'));
const BYTES = new Uint8Array([9, 8, 7]);

describe('a remote FontFace', () => {
  it('downloads once into the cache on load(), and document.fonts.add registers the cached file', async () => {
    const cacheDir = await tmp();
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => BYTES.slice().buffer };
    };
    const face = new NodeFontFace('Web', 'url(https://example.com/web.woff2)', { weight: '700' }, { fetch, cacheDir });
    expect(face.path).toBe('');
    await face.load();
    expect(face.status).toBe('loaded');
    addFace(face);
    const path = getFonts()['Web:700']!;
    expect(path.startsWith(cacheDir)).toBe(true);
    expect([...(await readFile(path))]).toEqual([...BYTES]);
    // A second face for the same URL reads the cache.
    await new NodeFontFace('Web', 'url(https://example.com/web.woff2)', { weight: '400' }, { fetch, cacheDir }).load();
    expect(calls).toBe(1);
  });

  it('is downloaded by document.fonts.add when it was not loaded first (the thread blocks)', async () => {
    const cacheDir = await tmp();
    const fetchSync = () => BYTES;
    addFace(new NodeFontFace('Web', 'url(https://example.com/a.ttf)', {}, { fetchSync, cacheDir }));
    expect(getFonts().Web!.startsWith(cacheDir)).toBe(true);
    expect(problems).toEqual([]);
  });

  it('does not stop the project when the download fails: it is noted, and load() rejects with a code', async () => {
    const cacheDir = await tmp();
    const fetchSync = (url: string): Uint8Array => {
      throw new FontDownloadError(url, 404);
    };
    const face = new NodeFontFace('Gone', 'url(https://example.com/gone.ttf)', {}, { fetchSync, cacheDir });
    expect(() => addFace(face)).not.toThrow();
    expect(getFonts()).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/FontFace "Gone".*HTTP status 404.*not registered/);
    expect(face.status).toBe('error');

    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND example.com') });
    };
    const offline = new NodeFontFace('Offline', 'url(https://example.com/o.ttf)', {}, { fetch, cacheDir });
    const error = await offline.load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FontDownloadError);
    expect(error).toMatchObject({ code: 'FONT_DOWNLOAD', status: 0 });
    expect((error as Error).message).toMatch(/ENOTFOUND/);
  });
});

describe('the blocking download', () => {
  it('fetches with a child process and caches the file', async () => {
    const server = spawn(
      process.execPath,
      [
        '-e',
        `const s = require('node:http').createServer((q, r) => {
           if (q.url === '/missing.ttf') { r.statusCode = 404; r.end('no'); return; }
           r.end(Buffer.from([1, 2, 3, 4]));
         });
         s.listen(0, '127.0.0.1', () => console.log(s.address().port));`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const port = await new Promise<number>((resolve) => server.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString()))));
      const cacheDir = await tmp();
      const path = fetchFileCachedSync(`http://127.0.0.1:${port}/f.ttf`, { cacheDir });
      expect([...(await readFile(path))]).toEqual([1, 2, 3, 4]);
      expect(() => fetchFileCachedSync(`http://127.0.0.1:${port}/missing.ttf`, { cacheDir })).toThrow(/HTTP status 404/);
      expect(() => fetchFileCachedSync('http://127.0.0.1:1/x.ttf', { cacheDir })).toThrow(FontDownloadError);
    } finally {
      server.kill();
    }
  });
});

describe('measureText while a font is downloading', () => {
  const fake = (request: TextLayoutRequest) => ({ width: request.text.length * request.size, height: request.size, lines: [], glyphs: [] });
  beforeEach(() => setLayoutText(fake));
  afterEach(() => setLayoutText(null));

  it('finishes the download with the thread blocked, so a measurement at module load has its font', async () => {
    const cacheDir = await tmp();
    // The async fetch never answers in time; the blocking one does.
    const fetch: FetchLike = () => new Promise(() => {});
    const fetchSync = () => BYTES;
    void loadFont({ family: 'Late', url: 'https://example.com/late.ttf' }, { fetch, fetchSync, cacheDir });
    expect(pendingFontLoads()).toBe(1);
    expect(measureText({ text: 'abc', fontFamily: 'Late', fontSize: 10 }).width).toBe(30);
    expect(pendingFontLoads()).toBe(0);
    expect(getFonts().Late!.startsWith(cacheDir)).toBe(true);
    // The frame loop has nothing left to wait for.
    await waitForFonts();
  });

  it('does the same for a Google font', () => {
    return (async () => {
      const cacheDir = await tmp();
      const fetch: FetchLike = () => new Promise(() => {});
      const fetchSync = (url: string): Uint8Array =>
        url.includes('googleapis')
          ? new TextEncoder().encode(
              `@font-face { font-family: 'Lobster'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/lobster/v30/a.ttf) format('truetype'); }`,
            )
          : BYTES;
      void makeGoogleFont('Lobster', { fetch, fetchSync, cacheDir }).loadFont('normal', { weights: ['400'] });
      expect(measureText({ text: 'ab', fontFamily: 'Lobster', fontSize: 10 }).width).toBe(20);
    })();
  });

  it('still says so when a download has no blocking way', async () => {
    const cacheDir = await tmp();
    const fetch: FetchLike = () => new Promise(() => {});
    void loadFont({ family: 'Stuck', url: 'https://example.com/s.ttf' }, { fetch, cacheDir });
    expect(() => measureText({ text: 'x', fontFamily: 'Stuck', fontSize: 10 })).toThrow(/synchronously/);
  });
});

describe('Google font getInfo().fonts', () => {
  const css = (subset: string, weight: number, range: string, file: string) => `/* ${subset} */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/${file}.woff2) format('woff2');
  unicode-range: ${range};
}`;

  it('maps weight and subset to the file URL of the cached download, fetched when read', async () => {
    const cacheDir = await tmp();
    const requested: string[] = [];
    const fetchSync = (url: string, userAgent: string): Uint8Array => {
      requested.push(url);
      if (url.includes('googleapis')) {
        if (url.includes('ital,wght')) throw new FontDownloadError(url, 400);
        expect(userAgent).toMatch(/Mozilla/);
        return new TextEncoder().encode(
          [css('cyrillic', 500, 'U+0400-045F', 'cyr500'), css('latin', 500, 'U+0000-00FF', 'lat500'), css('latin', 700, 'U+0000-00FF', 'lat700')].join('\n'),
        );
      }
      return BYTES;
    };
    const info = makeGoogleFont('Inter', { fetch: () => Promise.reject(new Error('offline')), fetchSync, cacheDir }).getInfo();
    expect(info.fontFamily).toBe('Inter');
    expect(requested).toEqual([]);
    expect(info.subsets).toEqual(['cyrillic', 'latin']);
    expect(info.version).toBe('v20');
    expect(info.unicodeRanges.latin).toBe('U+0000-00FF');
    expect(info.url).toContain('family=Inter:wght@500;700');
    expect(Object.keys(info.fonts.normal)).toEqual(['500', '700']);
    expect(info.fonts.italic).toEqual({});
    // No font file was fetched until one is read.
    expect(requested.filter((u) => u.includes('gstatic'))).toEqual([]);
    const url = info.fonts.normal['500']!.latin!;
    expect(url.startsWith('file://')).toBe(true);
    expect([...(await readFile(fileURLToPath(url)))]).toEqual([...BYTES]);
    expect(requested.filter((u) => u.includes('gstatic'))).toEqual(['https://fonts.gstatic.com/s/inter/v20/lat500.woff2']);
  });
});

describe('document.fonts as a event target', () => {
  it('accepts listeners that never fire (GSAP SplitText listens for loadingdone)', () => {
    installFontFace();
    const fonts = (globalThis as unknown as { document: { fonts: { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } } }).document.fonts;
    const listener = () => {};
    expect(() => {
      fonts.addEventListener('loadingdone', listener);
      fonts.removeEventListener('loadingdone', listener);
    }).not.toThrow();
  });
});
