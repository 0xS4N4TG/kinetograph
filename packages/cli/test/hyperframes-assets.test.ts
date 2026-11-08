import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addHyperframes, HYPERFRAMES_PINNED_REF, openHyperframes } from '../src/registry/hyperframes.js';
import { Localizer } from '../src/registry/hyperframes-assets.js';

const BASE = `https://raw.githubusercontent.com/heygen-com/hyperframes/${HYPERFRAMES_PINNED_REF}/registry`;
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Instrument+Serif:ital@0;1&display=swap';
const GSTATIC = 'https://fonts.gstatic.com/s';

const face = (family: string, style: string, weight: number, file: string): string =>
  `@font-face {\n  font-family: '${family}';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(${GSTATIC}/${file}) format('truetype');\n}\n`;

const GOOGLE_CSS =
  face('Instrument Serif', 'italic', 400, 'instrumentserif/v5/ital.ttf') +
  face('Instrument Serif', 'normal', 400, 'instrumentserif/v5/norm.ttf') +
  face('Space Mono', 'normal', 400, 'spacemono/v17/regular.ttf') +
  face('Space Mono', 'normal', 700, 'spacemono/v17/bold.ttf');

function served(): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>();
  files.set(CSS_URL, GOOGLE_CSS);
  for (const f of ['instrumentserif/v5/ital.ttf', 'instrumentserif/v5/norm.ttf', 'spacemono/v17/regular.ttf', 'spacemono/v17/bold.ttf']) files.set(`${GSTATIC}/${f}`, new Uint8Array([1, 2, 3, f.length]));
  files.set('https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-500-normal.woff2', new Uint8Array([9, 9]));
  files.set('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json', '{"type":"Topology"}');
  return files;
}

type Handler = (url: string) => Response | undefined;

function mockFetch(files: Map<string, string | Uint8Array>, handler?: Handler): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const custom = handler?.(url);
    if (custom !== undefined) return custom;
    const body = files.get(url);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
  };
  return Object.assign(impl, { calls }) as typeof fetch & { calls: string[] };
}

describe('Localizer: Google Fonts', () => {
  it('turns an @import whose URL holds semicolons into @font-face rules with local files', async () => {
    const fetch = mockFetch(served());
    const localizer = new Localizer({ fetch });
    const html = `<style>\n@import url("${CSS_URL}");\nbody{font-family:'Space Mono'}\n</style>`;
    const out = await localizer.localize(html, 'compositions/card.html', 'html');
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).toContain('font-family: "Space Mono";');
    expect(out).toContain('src: url("../public/fonts/space-mono/space-mono-700-normal.ttf") format("truetype");');
    expect(out).toContain('src: url("../public/fonts/instrument-serif/instrument-serif-400-italic.ttf")');
    expect(out).toContain("body{font-family:'Space Mono'}");
    expect([...localizer.assets.keys()].sort()).toEqual([
      'public/fonts/instrument-serif/instrument-serif-400-italic.ttf',
      'public/fonts/instrument-serif/instrument-serif-400-normal.ttf',
      'public/fonts/space-mono/space-mono-400-normal.ttf',
      'public/fonts/space-mono/space-mono-700-normal.ttf',
    ]);
    expect(localizer.warnings).toEqual([]);
  });

  it('replaces a <link> to Google Fonts with a <style> and writes paths relative to the page', async () => {
    const localizer = new Localizer({ fetch: mockFetch(served()) });
    const out = await localizer.localize(`<head><link rel="preconnect" href="https://fonts.gstatic.com"><link href="${CSS_URL.replace(/&/g, '&amp;')}" rel="stylesheet"></head>`, 'index.html', 'html');
    expect(out).toContain('<link rel="preconnect" href="https://fonts.gstatic.com">');
    expect(out).toContain('<style>');
    expect(out).toContain('src: url("public/fonts/space-mono/space-mono-400-normal.ttf")');
    expect(out).not.toContain('fonts.googleapis.com');
  });

  it('keeps the original reference and says so when a download fails', async () => {
    const files = served();
    files.delete(`${GSTATIC}/spacemono/v17/bold.ttf`);
    const localizer = new Localizer({ fetch: mockFetch(files) });
    const html = `<style>@import url("${CSS_URL}");</style>`;
    expect(await localizer.localize(html, 'a.html', 'html')).toBe(html);
    expect(localizer.warnings.join('\n')).toContain('was not stored in the project');
  });
});

describe('Localizer: what it never fetches', () => {
  it('leaves other hosts, other paths and other schemes alone', async () => {
    const fetch = mockFetch(served());
    const localizer = new Localizer({ fetch });
    const css = [
      '@import url("https://evil.example/css2?family=Inter");',
      '@import url("http://fonts.googleapis.com/css2?family=Inter");',
      '@import url("https://fonts.googleapis.com/other?family=Inter");',
      '@import url("https://fonts.googleapis.com:8443/css2?family=Inter");',
      '@import url("https://user:pw@fonts.googleapis.com/css2?family=Inter");',
      '@font-face{src:url(https://fonts.gstatic.com/other/a.ttf)}',
      '@font-face{src:url(https://cdn.jsdelivr.net/npm/pkg@1/a.woff2)}',
      '@font-face{src:url(https://evil.example/s/a.ttf)}',
    ].join('\n');
    expect(await localizer.localize(css, 'x.css', 'css')).toBe(css);
    expect(await localizer.dataFile('https://cdn.jsdelivr.net/npm/pkg@1/run.js')).toBeNull();
    expect(await localizer.dataFile('https://evil.example/npm/pkg@1/a.json')).toBeNull();
    expect(fetch.calls).toEqual([]);
  });

  it('refuses a redirect to another host, or to a path of another kind', async () => {
    const files = served();
    const handler: Handler = (url) => (url === `${GSTATIC}/spacemono/v17/bold.ttf` ? new Response(null, { status: 302, headers: { location: 'https://evil.example/bold.ttf' } }) : undefined);
    const fetch = mockFetch(files, handler);
    const localizer = new Localizer({ fetch });
    const html = `<style>@import url("${CSS_URL}");</style>`;
    expect(await localizer.localize(html, 'a.html', 'html')).toBe(html);
    expect(fetch.calls).not.toContain('https://evil.example/bold.ttf');
    expect(localizer.warnings.join('\n')).toContain('not on an allowed host');

    const sameHost = mockFetch(files, (url) => (url === `${GSTATIC}/spacemono/v17/bold.ttf` ? new Response(null, { status: 302, headers: { location: 'https://fonts.gstatic.com/x/not-a-font-path.ttf' } }) : undefined));
    const second = new Localizer({ fetch: sameHost });
    expect(await second.localize(html, 'a.html', 'html')).toBe(html);
    expect(sameHost.calls).not.toContain('https://fonts.gstatic.com/x/not-a-font-path.ttf');
    expect(second.warnings.join('\n')).toContain('not a file this download may read');
  });

  it('stops a font that is larger than the limit while it streams', async () => {
    const files = served();
    files.set(`${GSTATIC}/spacemono/v17/bold.ttf`, 'x'.repeat(26 * 1024 * 1024));
    const localizer = new Localizer({ fetch: mockFetch(files) });
    const html = `<style>@import url("${CSS_URL}");</style>`;
    expect(await localizer.localize(html, 'a.html', 'html')).toBe(html);
    expect(localizer.warnings.join('\n')).toContain('larger than the 25 MB limit');
  });

  it('sends no headers of its own', async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers);
      return mockFetch(served())(input);
    }) as typeof fetch;
    await new Localizer({ fetch: impl }).localize(`@import url("${CSS_URL}");`, 'x.css', 'css');
    expect(seen.length).toBeGreaterThan(3);
    for (const headers of seen) expect(Object.keys(headers ?? {})).toEqual([]);
  });
});

describe('Localizer: font files and data files', () => {
  it('stores a fontsource file named in CSS, relative to the file', async () => {
    const localizer = new Localizer({ fetch: mockFetch(served()) });
    const out = await localizer.localize('<style>@font-face{font-family:Inter;src:url(https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-500-normal.woff2)}</style>', 'compositions/a.html', 'html');
    expect(out).toContain('src:url(../public/fonts/inter/latin-500-normal.woff2)');
    expect([...localizer.assets.keys()]).toEqual(['public/fonts/inter/latin-500-normal.woff2']);
  });

  it('stores a JSON file a script fetches, under public/data, and points fetch at it', async () => {
    const localizer = new Localizer({ fetch: mockFetch(served()) });
    const html = `<script>fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").then((r) => r.json());</script><style>/* https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json */</style>`;
    const out = await localizer.localize(html, 'compositions/map.html', 'html');
    expect(out).toContain('fetch("public/data/us-atlas-3/states-10m.json")');
    // a style block is not a script: its text is left alone
    expect(out).toContain('/* https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json */');
    expect(localizer.assets.get('public/data/us-atlas-3/states-10m.json')).toMatchObject({ keep: false });
  });
});

describe('addHyperframes with fonts and data', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinetograph-hf-assets-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  });

  const registry = (): Map<string, string | Uint8Array> => {
    const files = served();
    const put = (path: string, body: string): void => void files.set(`${BASE}/${path}`, body);
    put('registry.json', JSON.stringify({ items: [{ name: 'card', type: 'hyperframes:block' }, { name: 'other', type: 'hyperframes:block' }] }));
    const item = (name: string) =>
      JSON.stringify({ name, type: 'hyperframes:block', files: [{ path: `${name}.html`, target: `compositions/${name}.html` }] });
    put('blocks/card/registry-item.json', item('card'));
    put('blocks/card/card.html', `<style>@import url("${CSS_URL}");</style><script>fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json")</script>`);
    put('blocks/other/registry-item.json', item('other'));
    put('blocks/other/other.html', `<link rel="stylesheet" href="${CSS_URL}">`);
    return files;
  };
  const open = (files = registry()) => {
    const fetch = mockFetch(files);
    return { fetch, source: openHyperframes({ fetch, cacheDir: mkdtempSync(join(tmpdir(), 'kinetograph-hf-cache-')) }) };
  };

  it('stores fonts and data in the project, and points the item at them', async () => {
    const { source } = open();
    const result = await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    const card = result.added[0]!;
    expect(card.written).toContain('public/fonts/space-mono/space-mono-400-normal.ttf');
    expect(card.written).toContain('public/data/us-atlas-3/states-10m.json');
    const page = readFileSync(join(dir, 'compositions/card.html'), 'utf8');
    expect(page).toContain('url("../public/fonts/space-mono/space-mono-700-normal.ttf")');
    expect(page).toContain('fetch("public/data/us-atlas-3/states-10m.json")');
    expect(page).not.toContain('googleapis');
    expect(readFileSync(join(dir, 'public/data/us-atlas-3/states-10m.json'), 'utf8')).toBe('{"type":"Topology"}');
  });

  it('leaves the item as written with localize: false, without any font request', async () => {
    const { fetch, source } = open();
    await addHyperframes({ names: ['card'], dir, source, overwrite: false, localize: false });
    expect(readFileSync(join(dir, 'compositions/card.html'), 'utf8')).toContain('fonts.googleapis.com');
    expect(existsSync(join(dir, 'public'))).toBe(false);
    expect(fetch.calls.filter((u) => u.includes('googleapis') || u.includes('gstatic'))).toEqual([]);
  });

  it('shares a font between items, keeps one already in the project, and installing again changes nothing', async () => {
    const { source } = open();
    await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    // a font the user replaced is theirs: it is neither compared nor overwritten
    writeFileSync(join(dir, 'public/fonts/space-mono/space-mono-400-normal.ttf'), 'mine');
    const second = await addHyperframes({ names: ['card', 'other'], dir, source, overwrite: false });
    expect(readFileSync(join(dir, 'public/fonts/space-mono/space-mono-400-normal.ttf'), 'utf8')).toBe('mine');
    expect(second.added.find((a) => a.name === 'card')!.written).toEqual([]);
    expect(second.added.find((a) => a.name === 'other')!.written).toEqual(['compositions/other.html']);
    expect(second.added.find((a) => a.name === 'other')!.unchanged).toContain('public/fonts/space-mono/space-mono-400-normal.ttf');
  });

  it('refuses nothing outside the folders: stored files stay under public/fonts and public/data', async () => {
    const { source } = open();
    const result = await addHyperframes({ names: ['card', 'other'], dir, source, overwrite: false });
    for (const added of result.added) for (const file of added.written) expect(file).toMatch(/^(compositions|public\/fonts|public\/data)\//);
  });
});
