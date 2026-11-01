import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextLayoutRequest } from '@kinetographdev/native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FontDownloadError, type FetchLike, type FontDownloadOptions } from '../src/font-files.js';
import { clearFonts, getFonts, waitForFonts } from '../src/font-registry.js';
import { makeWebFont as makeFromFonts } from '../src/fonts.js';
import { measureText, setLayoutText } from '../src/layout-utils.js';
import { makeWebFont, parseWebFontFaces } from '../src/web-fonts.js';

beforeEach(() => clearFonts());

const CSS_URL = 'https://api.example.com/v2/css?f[]=switzer@400,401,700,701&display=swap';
const WEIGHTS: [string, string][] = [['400', 'normal'], ['400', 'italic'], ['700', 'normal'], ['700', 'italic']];

/** A Fontshare-style answer: three formats per face, protocol-relative links, `release` in the file names. */
const stylesheet = (release: string, family = 'Switzer'): string =>
  WEIGHTS.map(
    ([weight, style]) => `@font-face {
  font-family: '${family}';
  src: url('//cdn.example.com/wf/${release}/${weight}-${style}.woff2') format('woff2'),
       url('//cdn.example.com/wf/${release}/${weight}-${style}.woff') format('woff'),
       url('//cdn.example.com/wf/${release}/${weight}-${style}.ttf') format('truetype');
  font-weight: ${weight};
  font-display: swap;
  font-style: ${style};
}`,
  ).join('\n');

/** A web host with a stylesheet that changes, files that disappear, and a log of every request. */
function host(initialRelease: string) {
  const state = { release: initialRelease, gone: new Set<string>(), log: [] as string[], family: 'Switzer' };
  const answer = (url: string): string | Uint8Array => {
    state.log.push(url);
    if (url === CSS_URL) return stylesheet(state.release, state.family);
    if (state.gone.has(url) || !url.includes(`/wf/${state.release}/`)) {
      throw new FontDownloadError(url, 404);
    }
    return new TextEncoder().encode(url);
  };
  const fetch: FetchLike = async (url) => {
    try {
      const body = answer(url);
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return { ok: true, status: 200, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    } catch (error) {
      return { ok: false, status: (error as FontDownloadError).status, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
  };
  const fetchSync = (url: string): Uint8Array => {
    const body = answer(url);
    return typeof body === 'string' ? new TextEncoder().encode(body) : body;
  };
  const files = () => state.log.filter((url) => url !== CSS_URL);
  const sheets = () => state.log.filter((url) => url === CSS_URL).length;
  return { state, fetch, fetchSync, files, sheets };
}

const tmp = () => mkdtemp(join(tmpdir(), 'kg-web-font-'));
const options = async (h: ReturnType<typeof host>): Promise<FontDownloadOptions> => ({
  fetch: h.fetch,
  fetchSync: h.fetchSync,
  cacheDir: await tmp(),
});

describe('parseWebFontFaces', () => {
  it('lists every source, resolving // links against the stylesheet', () => {
    const [face] = parseWebFontFaces(stylesheet('r1'), CSS_URL);
    expect(face).toMatchObject({ family: 'Switzer', weight: '400', style: 'normal' });
    expect(face!.sources.map((s) => [s.url, s.format])).toEqual([
      ['https://cdn.example.com/wf/r1/400-normal.woff2', 'woff2'],
      ['https://cdn.example.com/wf/r1/400-normal.woff', 'woff'],
      ['https://cdn.example.com/wf/r1/400-normal.ttf', 'truetype'],
    ]);
  });
});

describe('makeWebFont', () => {
  it('registers the TrueType file of each face, with the stylesheet family, weight and style', async () => {
    const h = host('r1');
    const opts = await options(h);
    const font = makeWebFont(CSS_URL, opts);
    const { fontFamily, waitUntilDone } = font.loadFont('normal');
    expect(fontFamily).toBe('Switzer');
    await waitUntilDone();
    await waitForFonts();
    expect(h.files().sort()).toEqual([
      'https://cdn.example.com/wf/r1/400-normal.ttf',
      'https://cdn.example.com/wf/r1/700-normal.ttf',
    ]);
    const fonts = getFonts();
    expect(Object.keys(fonts).sort()).toEqual(['Switzer', 'Switzer:700']);
    expect((await readFile(fonts['Switzer:700']!, 'utf8'))).toBe('https://cdn.example.com/wf/r1/700-normal.ttf');
  });

  it('keeps only the style and weights asked for', async () => {
    const h = host('r1');
    const font = makeWebFont(CSS_URL, await options(h));
    await font.loadFont('italic', { weights: ['700'] }).waitUntilDone();
    expect(h.files()).toEqual(['https://cdn.example.com/wf/r1/700-italic.ttf']);
    expect(Object.keys(getFonts())).toEqual(['Switzer:700i']);
  });

  it('takes the family from the stylesheet, not the URL', async () => {
    const h = host('r1');
    h.state.family = 'Some Other Name';
    const font = makeWebFont(CSS_URL, await options(h));
    expect(font.fontFamily).toBe('Some Other Name');
    await font.loadFont('normal', { weights: ['400'] }).waitUntilDone();
    expect(Object.keys(getFonts())).toEqual(['Some Other Name']);
  });

  it('says what the stylesheet has when nothing matches', async () => {
    const h = host('r1');
    const font = makeWebFont(CSS_URL, await options(h));
    await expect(font.loadFont('normal', { weights: ['100'] }).waitUntilDone()).rejects.toThrow(/no normal face of weight 100.*400 normal/);
    // The tracked load failed too (a render's wait would fail); take that error here so it does not reach the next test.
    await expect(waitForFonts()).rejects.toThrow(/weight 100/);
  });

  it('downloads a file once and loads a repeated request once', async () => {
    const h = host('r1');
    const opts = await options(h);
    const font = makeWebFont(CSS_URL, opts);
    await font.loadFont('normal', { weights: ['400'] }).waitUntilDone();
    await font.loadFont('normal', { weights: ['400'] }).waitUntilDone();
    // A second module on the same cache (the next render) reads it all from disk.
    await makeWebFont(CSS_URL, opts).loadFont('normal', { weights: ['400'] }).waitUntilDone();
    expect(h.files()).toEqual(['https://cdn.example.com/wf/r1/400-normal.ttf']);
    expect(h.sheets()).toBe(1);
  });

  it('asks for the stylesheet again when a file is gone (404) and takes the new link', async () => {
    const h = host('r1');
    const opts = await options(h);
    // r1 is cached: its stylesheet, and the 400 normal file.
    await makeWebFont(CSS_URL, opts).loadFont('normal', { weights: ['400'] }).waitUntilDone();
    expect(h.sheets()).toBe(1);

    // The host moves to r2 and removes the r1 files; the cached stylesheet still points at r1.
    h.state.release = 'r2';
    h.state.log.length = 0;
    const font = makeWebFont(CSS_URL, opts);
    await font.loadFont('normal').waitUntilDone();
    // 400 was cached, so it is used as is; 700 was not, so its r1 link failed, and one fresh stylesheet gave the r2 link.
    expect(h.sheets()).toBe(1);
    expect(h.files()).toEqual([
      'https://cdn.example.com/wf/r1/700-normal.ttf',
      'https://cdn.example.com/wf/r2/700-normal.ttf',
    ]);
    expect(await readFile(getFonts()['Switzer:700']!, 'utf8')).toBe('https://cdn.example.com/wf/r2/700-normal.ttf');
    expect(await readFile(getFonts().Switzer!, 'utf8')).toBe('https://cdn.example.com/wf/r1/400-normal.ttf');

    // The fresh stylesheet replaced the cached one: the next load needs no second refresh.
    h.state.log.length = 0;
    clearFonts();
    await makeWebFont(CSS_URL, opts).loadFont('italic', { weights: ['400'] }).waitUntilDone();
    expect(h.sheets()).toBe(0);
    expect(h.files()).toEqual(['https://cdn.example.com/wf/r2/400-italic.ttf']);
  });

  it('fails with the 404 when the fresh stylesheet has no other link', async () => {
    const h = host('r1');
    const opts = await options(h);
    h.state.gone.add('https://cdn.example.com/wf/r1/400-normal.ttf');
    const failed = await makeWebFont(CSS_URL, opts).loadFont('normal', { weights: ['400'] }).waitUntilDone().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FontDownloadError);
    expect(failed).toMatchObject({ status: 404 });
    expect(h.sheets()).toBe(2);
    await expect(waitForFonts()).rejects.toThrow(/404/);
  });

  it('takes the first file when a face lists no TrueType or OpenType', async () => {
    const css = `@font-face { font-family: 'W'; font-weight: 400; font-style: normal; src: url(https://x.example.com/w.woff2) format('woff2'), url(https://x.example.com/w.woff) format('woff'); }`;
    const fetched: string[] = [];
    const fetchSync = (url: string): Uint8Array => {
      fetched.push(url);
      return new TextEncoder().encode(url.endsWith('.css') ? css : 'bytes');
    };
    await makeWebFont('https://x.example.com/w.css', { fetchSync, fetch: async (url) => {
      const bytes = fetchSync(url);
      return { ok: true, status: 200, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    }, cacheDir: await tmp() }).loadFont().waitUntilDone();
    expect(fetched.filter((u) => !u.endsWith('.css'))).toEqual(['https://x.example.com/w.woff2']);
  });
});

describe('the blocking path', () => {
  const fake = (request: TextLayoutRequest) => ({ width: request.text.length * request.size, height: request.size, lines: [], glyphs: [] });
  beforeEach(() => setLayoutText(fake));
  afterEach(() => setLayoutText(null));

  it('finishes the download with the thread blocked, so a measurement at module load has its font', async () => {
    const h = host('r1');
    const opts = await options(h);
    // The async fetch never answers; the blocking one does.
    const font = makeFromFonts(CSS_URL, { ...opts, fetch: () => new Promise(() => {}) });
    font.loadFont('normal', { weights: ['400'] });
    expect(measureText({ text: 'abc', fontFamily: 'Switzer', fontSize: 10 }).width).toBe(30);
    expect(await readFile(getFonts().Switzer!, 'utf8')).toBe('https://cdn.example.com/wf/r1/400-normal.ttf');
    await waitForFonts();
  });

  it('prefers a face with a plain font file over WOFF2 here too, and recovers from a 404 with a fresh stylesheet', async () => {
    const h = host('r1');
    const opts = await options(h);
    // Cache the r1 stylesheet, then move the host on.
    makeWebFont(CSS_URL, opts).fontFamily;
    h.state.release = 'r2';
    h.state.log.length = 0;
    const font = makeWebFont(CSS_URL, { ...opts, fetch: () => new Promise(() => {}) });
    font.loadFont('normal', { weights: ['700'] });
    measureText({ text: 'a', fontFamily: 'Switzer', fontWeight: 700, fontSize: 10 });
    expect(h.files()).toEqual([
      'https://cdn.example.com/wf/r1/700-normal.ttf',
      'https://cdn.example.com/wf/r2/700-normal.ttf',
    ]);
    expect(h.sheets()).toBe(1);
    expect(await readFile(getFonts()['Switzer:700']!, 'utf8')).toBe('https://cdn.example.com/wf/r2/700-normal.ttf');
  });
});
