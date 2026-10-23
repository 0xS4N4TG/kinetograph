import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FontDownloadError, type FetchLike } from '../src/font-files.js';
import { clearFonts, FALLBACK_FONT_KEY, getFonts, pendingFontLoads, registerFont, setFallbackFont, waitForFonts } from '../src/font-registry.js';
import { loadFont } from '../src/fonts.js';
import {
  familyFromModuleName,
  googleFontsCssUrl,
  makeGoogleFont,
  parseFontFaces,
} from '../src/google-fonts.js';

beforeEach(() => {
  clearFonts();
  setFallbackFont(null);
});

describe('font registry', () => {
  it('offers the built-in fallback only while the project has registered no font', () => {
    expect(getFonts()).toEqual({});
    setFallbackFont('/cli/DMSans-Medium.ttf');
    expect(getFonts()).toEqual({ [FALLBACK_FONT_KEY]: '/cli/DMSans-Medium.ttf' });
    registerFont({ family: 'Inter', path: '/f/Inter-Regular.ttf' });
    expect(getFonts()).toEqual({ Inter: '/f/Inter-Regular.ttf' });
  });

  it('keys fonts by fontKey and stores absolute paths', () => {
    registerFont({ family: 'Inter', path: '/f/Inter-Regular.ttf' });
    registerFont({ family: 'Inter', path: '/f/Inter-Bold.ttf', weight: 700 });
    registerFont({ family: 'Inter', path: '/f/Inter-Italic.ttf', weight: 'normal', style: 'italic' });
    registerFont({ family: 'DM Sans', path: 'fonts/dm.ttf', weight: '500' });
    expect(getFonts()).toEqual({
      Inter: '/f/Inter-Regular.ttf',
      'Inter:700': '/f/Inter-Bold.ttf',
      'Inter:400i': '/f/Inter-Italic.ttf',
      'DM Sans:500': resolve('fonts/dm.ttf'),
    });
  });

  it('returns a copy and replaces a font registered twice', () => {
    registerFont({ family: 'A', path: '/one.ttf' });
    getFonts().A = 'changed';
    expect(getFonts().A).toBe('/one.ttf');
    registerFont({ family: 'A', path: '/two.ttf' });
    expect(getFonts().A).toBe('/two.ttf');
  });

  it('rejects an incomplete registration', () => {
    expect(() => registerFont({ family: '', path: '/x.ttf' })).toThrow(/family/);
    expect(() => registerFont({ family: 'A', path: '' })).toThrow(/path/);
  });
});

describe('loadFont (@remotion/fonts)', () => {
  it('registers a local file at once', async () => {
    await loadFont({ family: 'Brand', url: '/p/brand.otf', weight: '700' });
    expect(getFonts()).toEqual({ 'Brand:700': '/p/brand.otf' });
  });

  it('takes file:// URLs and weight ranges', async () => {
    await loadFont({ family: 'Brand', url: 'file:///p/var.ttf', weight: '300 800' });
    expect(getFonts()).toEqual({ 'Brand:300': '/p/var.ttf' });
  });

  it('downloads an http font once, through the cache, and tracks it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kg-fonts-'));
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const done = loadFont({ family: 'Web', url: 'https://example.com/web.ttf' }, { fetch, cacheDir: dir });
    expect(pendingFontLoads()).toBe(1);
    await done;
    await loadFont({ family: 'Web', url: 'https://example.com/web.ttf', weight: 700 }, { fetch, cacheDir: dir });
    expect(calls).toBe(1);
    const path = getFonts().Web!;
    expect(path.startsWith(dir)).toBe(true);
    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
    expect(getFonts()['Web:700']).toBe(path);
  });
});

describe('familyFromModuleName', () => {
  it.each([
    ['Inter', 'Inter'],
    ['PlayfairDisplay', 'Playfair Display'],
    ['OpenSans', 'Open Sans'],
    ['RobotoMono', 'Roboto Mono'],
    ['EBGaramond', 'EB Garamond'],
    ['IBMPlexSans', 'IBM Plex Sans'],
    ['PTSerif', 'PT Serif'],
    ['DMSans', 'DM Sans'],
    ['NotoSansJP', 'Noto Sans JP'],
    ['SourceSans3', 'Source Sans 3'],
    ['MPLUS1', 'M PLUS 1'],
    ['PressStart2P', 'Press Start 2P'],
    ['JetBrainsMono', 'JetBrains Mono'],
    ['VT323', 'VT323'],
    ['Playfair Display', 'Playfair Display'],
    ['DM Sans', 'DM Sans'],
    ['Noto Sans JP', 'Noto Sans JP'],
    ['Exo 2', 'Exo 2'],
    ['Exo2', 'Exo 2'],
  ])('%s -> %s', (module, family) => {
    expect(familyFromModuleName(module)).toBe(family);
  });
});

const CSS = (family: string, faces: [number, string, string?][]) =>
  faces
    .map(
      ([weight, url, style]) => `@font-face {
  font-family: '${family}';
  font-style: ${style ?? 'normal'};
  font-weight: ${weight};
  font-display: swap;
  src: url(${url}) format('truetype');
}`,
    )
    .join('\n');

function fakeNetwork(handler: (url: string) => { status: number; body: string | Uint8Array }) {
  const requests: { url: string; headers?: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: init?.headers });
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
      arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body).slice().buffer,
    };
  };
  return { fetch, requests };
}

describe('google fonts', () => {
  it('accepts the family name with spaces, as the CLI passes it', () => {
    const font = makeGoogleFont('DM Sans');
    expect(font.fontFamily).toBe('DM Sans');
    expect(font.getInfo()).toMatchObject({ fontFamily: 'DM Sans', importName: 'DMSans' });
    expect(makeGoogleFont('Exo 2').fontFamily).toBe('Exo 2');
  });

  it('builds the CSS API URL with sorted weights and the italic axis', () => {
    expect(googleFontsCssUrl('Playfair Display', 'normal', ['700', '400'])).toBe(
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
    );
    expect(googleFontsCssUrl('Inter', 'italic', ['400', '700'])).toBe(
      'https://fonts.googleapis.com/css2?family=Inter:ital,wght@1,400;1,700&display=swap',
    );
  });

  it('parses @font-face blocks', () => {
    const css = CSS('Inter', [
      [400, 'https://fonts.gstatic.com/s/inter/a.ttf'],
      [700, 'https://fonts.gstatic.com/s/inter/b.ttf', 'italic'],
    ]);
    expect(parseFontFaces(css)).toEqual([
      { family: 'Inter', style: 'normal', weight: '400', url: 'https://fonts.gstatic.com/s/inter/a.ttf' },
      { family: 'Inter', style: 'italic', weight: '700', url: 'https://fonts.gstatic.com/s/inter/b.ttf' },
    ]);
  });

  it('downloads each weight once, registers it, and reads from the cache after that', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kg-gf-'));
    const net = fakeNetwork((url) =>
      url.startsWith('https://fonts.googleapis.com/')
        ? {
            status: 200,
            body: CSS('Playfair Display', [
              [400, 'https://fonts.gstatic.com/s/pf/regular.ttf'],
              [700, 'https://fonts.gstatic.com/s/pf/bold.ttf'],
            ]),
          }
        : { status: 200, body: new Uint8Array([7, 7, 7]) },
    );
    const font = makeGoogleFont('PlayfairDisplay', { fetch: net.fetch, cacheDir: dir });
    expect(font.fontFamily).toBe('Playfair Display');

    const loaded = font.loadFont('normal', { weights: ['700', '400'], subsets: ['latin'] });
    expect(loaded.fontFamily).toBe('Playfair Display');
    expect(pendingFontLoads()).toBe(1);
    await loaded.waitUntilDone();
    await waitForFonts();

    expect(Object.keys(getFonts()).sort()).toEqual(['Playfair Display', 'Playfair Display:700']);
    expect(getFonts()['Playfair Display']!.startsWith(dir)).toBe(true);
    expect(net.requests.map((r) => r.url)).toEqual([
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
      'https://fonts.gstatic.com/s/pf/regular.ttf',
      'https://fonts.gstatic.com/s/pf/bold.ttf',
    ]);
    expect(net.requests[0]!.headers?.['User-Agent']).toBeTruthy();
    expect((await readdir(dir)).length).toBe(3);

    // A second load in the same process asks for nothing; a new module (a new process) reads the cache. Both are
    // awaited: a load left running registers its fonts after the next test has cleared the registry.
    await font.loadFont('normal', { weights: ['400', '700'] }).waitUntilDone();
    const again = makeGoogleFont('PlayfairDisplay', { fetch: net.fetch, cacheDir: dir });
    await again.loadFont('normal', { weights: ['400', '700'] }).waitUntilDone();
    expect(net.requests).toHaveLength(3);
  });

  it('loads every weight by default, falling back to one request per weight when the family lacks some', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kg-gf-'));
    const net = fakeNetwork((url) => {
      if (url.includes('fonts.googleapis.com')) {
        const weights = /wght@([\d;]+)/.exec(url)![1]!.split(';');
        if (weights.length > 1) return { status: 400, body: 'bad' };
        if (weights[0] !== '400' && weights[0] !== '700') return { status: 400, body: 'bad' };
        return { status: 200, body: CSS('Lobster Two', [[Number(weights[0]), `https://fonts.gstatic.com/s/l/${weights[0]}.ttf`]]) };
      }
      return { status: 200, body: new Uint8Array([1]) };
    });
    const font = makeGoogleFont('LobsterTwo', { fetch: net.fetch, cacheDir: dir });
    await font.loadFont().waitUntilDone();
    expect(Object.keys(getFonts()).sort()).toEqual(['Lobster Two', 'Lobster Two:700']);
  });

  it('registers italics with their key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kg-gf-'));
    const net = fakeNetwork((url) =>
      url.includes('googleapis')
        ? { status: 200, body: CSS('Inter', [[400, 'https://fonts.gstatic.com/s/i/it.ttf', 'italic']]) }
        : { status: 200, body: new Uint8Array([1]) },
    );
    await makeGoogleFont('Inter', { fetch: net.fetch, cacheDir: dir }).loadFont('italic', { weights: ['400'] }).waitUntilDone();
    expect(Object.keys(getFonts())).toEqual(['Inter:400i']);
  });

  it('fails the frame loop wait when a download fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kg-gf-'));
    const net = fakeNetwork(() => ({ status: 404, body: 'nope' }));
    const font = makeGoogleFont('NoSuchFont', { fetch: net.fetch, cacheDir: dir });
    const done = font.loadFont('normal', { weights: ['400'] }).waitUntilDone();
    await expect(done).rejects.toBeInstanceOf(FontDownloadError);
    await expect(waitForFonts()).rejects.toThrow(/HTTP status 404/);
    await waitForFonts();
  });
});
