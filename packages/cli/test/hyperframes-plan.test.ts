// The HyperFrames loader: HTML read into a plan (parse5), compositions mounted, CSS scoped, scripts resolved.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HfNode } from '@kinetographdev/core/hyperframes';
import { buildPlan } from '../src/hyperframes/plan.js';
import { crossingRules, parseGoogleFontsUrl, rewriteDocumentSelectors, scopeToComposition } from '../src/hyperframes/css.js';
import { FONT_ALIASES, parseFamilyList } from '../src/hyperframes/fonts.js';
import { resolveEntry } from '../src/hyperframes/entry.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hf-nyt');

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kg-hf-plan-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const find = (nodes: HfNode[], test: (n: HfNode & { t: 'el' }) => boolean): (HfNode & { t: 'el' }) | null => {
  for (const n of nodes) {
    if (n.t !== 'el') continue;
    if (test(n)) return n;
    const inner = find(n.children, test);
    if (inner) return inner;
  }
  return null;
};
const attr = (n: HfNode & { t: 'el' }, name: string): string | undefined => n.attrs.find(([a]) => a === name)?.[1];
const noNetwork = () => ({ error: 'offline' }) as const;
const fakeScript = (url: string) => ({ file: join(fixture, 'index.html'), via: 'cache' as const, url });

describe('entries', () => {
  it('a directory is its index.html', () => {
    expect(resolveEntry(fixture)).toBe(join(fixture, 'index.html'));
  });
});

describe('the HyperFrames sample project', () => {
  it('reads the root composition, mounts the file and scopes its CSS', async () => {
    const { plan, scriptUrls } = await buildPlan(join(fixture, 'index.html'), {
      resolveScriptUrl: (url) => ({ ...fakeScript(url), file: join(fixture, 'compositions', 'nyt-chart.html') }),
    });
    expect([plan.compositionId, plan.width, plan.height, plan.fps, plan.durationSeconds]).toEqual(['main', 1920, 1080, 30, 15]);
    expect(scriptUrls).toEqual(['https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js']);
    const host = find(plan.body, (n) => attr(n, 'id') === 'nyt-chart-comp')!;
    expect(attr(host, 'data-composition-src')).toBeUndefined();
    expect(find(host.children, (n) => n.tag === 'svg')!.svg).toBe(true);
    expect(find(host.children, (n) => attr(n, 'class') === 'headline')).not.toBeNull();
    const css = plan.stylesheets.map((s) => s.css).join('\n');
    expect(css).toContain('[data-composition-id="nyt-chart"] .headline');
    expect(css).toContain('.kg-hf-body');
    // The scripts: the library, the page's own, the composition's (scoped to it).
    expect(plan.scripts.map((s) => s.scope)).toEqual([null, 'nyt-chart', null]);
    expect(plan.svgRules.some((r) => r.selector.includes('.bar'))).toBe(true);
  });

  it('fails clearly, naming the URL and fetch-deps, when a script is not available', async () => {
    await expect(buildPlan(join(fixture, 'index.html'), { resolveScriptUrl: noNetwork })).rejects.toThrow(/offline/);
    await expect(buildPlan(join(fixture, 'index.html'))).resolves.toBeDefined();
  });
});

describe('mounting compositions', () => {
  const index = `<!doctype html><html><head><style>body{background:#000}</style></head><body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="8" data-width="640" data-height="360">
      <div id="a" data-composition-id="card" data-composition-src="compositions/card.html" data-start="1" data-duration="3" data-variable-values='{"title":"Pro"}'></div>
      <div id="b" data-composition-id="card2" data-composition-src="compositions/card.html" data-start="a" data-duration="3"></div>
      <video id="v" src="assets/clip.mp4" data-start="0" muted></video>
    </div></body></html>`;
  const card = `<template><style>.title{color:red} #inner{margin:1px} body{margin:0}</style>
    <div id="inner" data-composition-id="card" data-width="640" data-height="360" data-composition-variables='[{"id":"title","type":"string","default":"Fallback"}]'>
      <h1 class="title">Hi</h1></div>
    <script>window.__timelines = window.__timelines || {}; window.__timelines["card"] = 1;</script></template>`;

  it('puts the file content in the host, scopes style and script, merges variables', async () => {
    const dir = project({ 'index.html': index, 'compositions/card.html': card, 'assets/clip.mp4': 'x' });
    const { plan } = await buildPlan(join(dir, 'index.html'), { probeDuration: () => 4 });
    const a = find(plan.body, (n) => attr(n, 'id') === 'a')!;
    expect(find(a.children, (n) => n.tag === 'h1')).not.toBeNull();
    // The root element of the file is not a node of its own: the host takes its place.
    expect(find(a.children, (n) => attr(n, 'id') === 'inner')).toBeNull();
    const card1 = plan.stylesheets.find((s) => s.file.endsWith('card.html'))!;
    expect(card1.css).toContain('[data-composition-id="card"] .title');
    expect(card1.css).toMatch(/\[data-composition-id="card"\]\s*\{\s*margin:1px/);
    expect(plan.scripts.find((s) => s.scope === 'card')!.sourceFile).toMatch(/card\.html$/);
    expect(plan.variables.card).toEqual({ title: 'Pro' });
    expect(plan.variables.card2).toEqual({ title: 'Fallback' });
    const video = find(plan.body, (n) => n.tag === 'video')!;
    expect(attr(video, 'src')).toBe(join(dir, 'assets', 'clip.mp4'));
    expect(plan.mediaDurations[join(dir, 'assets', 'clip.mp4')]).toBe(4);
  });

  it('a missing composition file is a note, not a failure', async () => {
    const dir = project({ 'index.html': index.replace('compositions/card.html', 'compositions/none.html') });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    expect(plan.notes.join('\n')).toContain('none.html');
  });

  it('notes what it cannot run: an import map, Three.js', async () => {
    const dir = project({
      'index.html': `<html><body><div data-composition-id="m" data-duration="1"></div>
        <script type="importmap">{"imports":{}}</script>
        <script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js"></script></body></html>`,
    });
    const { plan } = await buildPlan(join(dir, 'index.html'), { resolveScriptUrl: (url) => ({ ...fakeScript(url) }) });
    expect(plan.usesThree).toBe(true);
    expect(plan.notes.join('\n')).toContain('import maps');
    expect(plan.notes.join('\n')).toContain('Three.js');
  });
});

describe('script integrity', () => {
  const page = (integrity: string) =>
    `<html><body><div data-composition-id="m" data-duration="1"></div><script src="lib/a.js" integrity="${integrity}"></script></body></html>`;

  it('checks a local script, and a resolved CDN one, against the integrity attribute every time', async () => {
    const good = `sha256-${createHash('sha256').update('var a=1;').digest('base64')}`;
    const dir = project({ 'index.html': page(good), 'lib/a.js': 'var a=1;' });
    await expect(buildPlan(join(dir, 'index.html'))).resolves.toBeDefined();
    const bad = project({ 'index.html': page(`sha256-${createHash('sha256').update('x').digest('base64')}`), 'lib/a.js': 'var a=1;' });
    await expect(buildPlan(join(bad, 'index.html'))).rejects.toThrow(/integrity/);
    const cdn = project({
      'index.html': `<html><body><div data-composition-id="m"></div><script src="https://cdn.jsdelivr.net/npm/x@1.0.0/a.js" integrity="sha256-AAAA"></script></body></html>`,
      'lib/a.js': 'var a=1;',
    });
    await expect(buildPlan(join(cdn, 'index.html'), { resolveScriptUrl: () => ({ file: join(cdn, 'lib', 'a.js'), via: 'node_modules' }) })).rejects.toThrow(/integrity/);
  });
});

describe('CSS rewriting', () => {
  it('scopes selectors to the composition and leaves keyframes alone', () => {
    const css = scopeToComposition('.a, .b > c { x: 1 } body { y: 2 } [data-composition-id="k"] .z { z: 3 } @keyframes f { from { a: 1 } }', 'k');
    expect(css).toContain('[data-composition-id="k"] .a');
    expect(css).toContain('[data-composition-id="k"] .b > c');
    expect(css).toContain('[data-composition-id="k"] { y: 2 }');
    expect(css).toContain('[data-composition-id="k"] .z');
    expect(css).not.toContain('[data-composition-id="k"] from');
  });

  it('maps the page html and body to the wrapper elements', () => {
    expect(rewriteDocumentSelectors('html, body { a: 1 } body .x { b: 2 } .body { c: 3 }')).toBe(
      '.kg-hf-html, .kg-hf-body { a: 1 } .kg-hf-body .x { b: 2 } .body { c: 3 }',
    );
  });

  it('reads the families and weights of a Google Fonts URL', () => {
    expect(parseGoogleFontsUrl('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Inter:ital,wght@0,400;1,700&family=Roboto')).toEqual([
      { family: 'Libre Baskerville', variants: ['400', '700'] },
      { family: 'Inter', variants: ['400', '700i'] },
      { family: 'Roboto', variants: ['400'] },
    ]);
  });
});

describe('fonts HyperFrames embeds', () => {
  const page = (head: string, body = '') =>
    `<!doctype html><html><head>${head}</head><body><div data-composition-id="m" data-duration="1" ${body}></div></body></html>`;

  it('reads the family lists of a font-family value', () => {
    expect(parseFamilyList(`'Helvetica Neue', "Segoe UI", -apple-system, sans-serif`)).toEqual(['Helvetica Neue', 'Segoe UI', '-apple-system', 'sans-serif']);
    expect(FONT_ALIASES.arial).toBe('inter');
    expect(FONT_ALIASES.consolas).toBe('jetbrains-mono');
    expect(FONT_ALIASES['jetbrains mono']).toBe('jetbrains-mono');
  });

  it('loads the bundled family a stylesheet, an inline style or a variable names, from the cache only, and maps the aliases', async () => {
    const dir = project({
      'index.html': page(
        `<style>:root { --ui: Consolas, monospace } .a { font-family: "Inter", sans-serif } .b { font-family: var(--ui) } .c { font-family: Georgia }</style>`,
        `style="font-family: Arial"`,
      ),
    });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    const byFamily = Object.fromEntries(plan.googleFonts.map((f) => [f.family, f]));
    expect(byFamily.Inter).toMatchObject({ variants: ['100', '200', '300', '400', '500', '600', '700', '800', '900'], as: ['Arial'], cacheOnly: true });
    expect(byFamily['JetBrains Mono']).toMatchObject({ as: ['Consolas'], cacheOnly: true });
    expect(byFamily['EB Garamond']).toMatchObject({ as: ['Georgia'] });
  });

  it('leaves a family the page loads or declares itself', async () => {
    const dir = project({
      'index.html': page(
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300">
         <style>@font-face { font-family: Inter; src: url(a.woff2) } .a { font-family: Inter } .b { font-family: Roboto }</style>`,
      ),
    });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    expect(plan.googleFonts).toEqual([{ family: 'Roboto', variants: ['300'] }]);
  });

  it('gives a fragment index.html the document HyperFrames wraps it in: Inter, black, margins reset', async () => {
    const dir = project({ 'index.html': '<div data-composition-id="m" data-duration="1"><p>hi</p></div>' });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    expect(plan.stylesheets[0]!.css).toContain('font-family:"Inter",sans-serif');
    expect(plan.googleFonts.map((f) => f.family)).toEqual(['Inter']);
  });
});

describe('page features', () => {
  it('keeps a page <template> out of the document and gives its content to a script', async () => {
    const dir = project({
      'index.html': `<html><body><div data-composition-id="m" data-duration="1"></div><template id="t"><b class="x">hi</b></template></body></html>`,
    });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    const template = find(plan.body, (n) => n.tag === 'template')!;
    expect(template.children).toEqual([]);
    expect(template.content).toMatchObject([{ t: 'el', tag: 'b' }]);
  });

  it('reads the svg-crossing rules inside @media with their conditions', () => {
    const rules = crossingRules('.a .b { fill: red } @media (min-width: 600px) { [data-composition-id="x"] .bar { fill: blue } } @media print { .c .d { fill: green } }', 0);
    expect(rules.map((r) => [r.selector, r.media ?? []])).toEqual([
      ['.a .b', []],
      ['[data-composition-id="x"] .bar', ['(min-width: 600px)']],
      ['.c .d', ['print']],
    ]);
  });
});

describe('what a page fetches and plays from the web', () => {
  const savedCache = process.env.KINETOGRAPH_CDN_CACHE;
  const withCache = async <T>(run: (cache: string) => Promise<T>): Promise<T> => {
    const cache = mkdtempSync(join(tmpdir(), 'kg-hf-cache-'));
    process.env.KINETOGRAPH_CDN_CACHE = cache;
    try {
      return await run(cache);
    } finally {
      if (savedCache === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
      else process.env.KINETOGRAPH_CDN_CACHE = savedCache;
    }
  };
  const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
  const page = `<html><body><div data-composition-id="m" data-duration="1"></div>
    <script>d3.json("${ATLAS}").then(draw); var lib = "https://cdn.jsdelivr.net/npm/x@1/dist/x.min.js";</script></body></html>`;

  it('finds the data URLs a script names, serves the cached ones to fetch, and notes the ones that are not cached', async () => {
    await withCache(async () => {
      const dir = project({ 'index.html': page });
      const missing = await buildPlan(join(dir, 'index.html'));
      expect(missing.dataUrls).toEqual([ATLAS]);
      expect(missing.plan.remoteData).toEqual({});
      expect(missing.plan.notes.join('\n')).toContain('fetch-deps');
      const { fetchCdnData, dataCachePath } = await import('../src/hyperframes/deps.js');
      await fetchCdnData([ATLAS], { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('{}').buffer as ArrayBuffer }) });
      const cached = await buildPlan(join(dir, 'index.html'));
      expect(cached.plan.remoteData).toEqual({ [ATLAS]: dataCachePath(ATLAS) });
      expect(cached.plan.notes.join('\n')).not.toContain('is not cached');
    });
  });

  it('plays a remote video from the cache and says on every frame that it cannot when it is not there', async () => {
    await withCache(async () => {
      const url = 'https://media.example.com/a.mp4';
      const dir = project({ 'index.html': `<html><body><div data-composition-id="m" data-duration="1"><video src="${url}" data-start="0"></video></div></body></html>` });
      const missing = await buildPlan(join(dir, 'index.html'));
      expect(missing.mediaUrls).toEqual([url]);
      expect(missing.plan.notes.join('\n')).toContain('is not drawn');
      const { fetchCdnData, dataCachePath } = await import('../src/hyperframes/deps.js');
      await fetchCdnData([url], { allowHosts: ['media.example.com'], fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(4).buffer as ArrayBuffer }) });
      const cached = await buildPlan(join(dir, 'index.html'));
      expect(attr(find(cached.plan.body, (n) => n.tag === 'video')!, 'src')).toBe(dataCachePath(url));
    });
  });

  it('notes a local media file that is not there, and not a page that uses WebGPU (it is drawn)', async () => {
    const dir = project({
      'index.html': `<html><body><div data-composition-id="m" data-duration="1"><video src="gone.mp4" data-start="0"></video></div>
        <script>if (navigator.gpu) { start(); }</script></body></html>`,
    });
    const { plan } = await buildPlan(join(dir, 'index.html'));
    expect(plan.notes.join('\n')).toContain('gone.mp4');
    expect(plan.notes.join('\n')).not.toContain('WebGPU');
  });
});
