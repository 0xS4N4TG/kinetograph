// Remote pictures of a HyperFrames page: collected from every place a picture is named, downloaded by `fetch-deps` under the
// script rules, read from the cache (hash checked) by the plan, and a note with the exact fix when one is not there.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HfNode } from '@kinetographdev/core/hyperframes';
import { dataCachePath, fetchCdnData } from '../src/hyperframes/deps.js';
import { MAX_IMAGE_BYTES, pickSrcset, remoteImage, rewriteCssImages } from '../src/hyperframes/images.js';
import { buildPlan } from '../src/hyperframes/plan.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kg-hf-img-'));
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fakeFetch = (bytes: Uint8Array = PNG) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});

const savedCache = process.env.KINETOGRAPH_CDN_CACHE;
const withCache = async <T>(run: (cache: string) => Promise<T>): Promise<T> => {
  const cache = mkdtempSync(join(tmpdir(), 'kg-hf-img-cache-'));
  process.env.KINETOGRAPH_CDN_CACHE = cache;
  try {
    return await run(cache);
  } finally {
    if (savedCache === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
    else process.env.KINETOGRAPH_CDN_CACHE = savedCache;
  }
};

const GRAIN = 'https://www.transparenttextures.com/patterns/natural-paper.png';
const IMG = 'https://img.example.com/a.png';
const IMG2X = 'https://img.example.com/a@2x.png';
const POSTER = 'https://img.example.com/poster.jpg';
const SVGIMG = 'https://img.example.com/s.png';
const INLINE = 'https://img.example.com/inline.png';
const SHEET = 'https://img.example.com/sheet.png';
const MASK = 'https://img.example.com/mask.png';
const BORDER = 'https://img.example.com/border.png';
const LIST = 'https://img.example.com/bullet.png';
const PROTO = 'https://img.example.com/proto.png';

const page = (extra = ''): string => `<!doctype html><html><head>
<style>
  body { background: url(${GRAIN}); }
  .m { -webkit-mask-image: url('${MASK}'); border-image: url("${BORDER}") 30 round; }
  ul { list-style: url(${LIST}) disc; }
  @font-face { font-family: X; src: url(https://img.example.com/x.woff2); }
  .c { cursor: url(https://img.example.com/cursor.png), auto; }
</style></head><body>
<div data-composition-id="m" data-duration="1" style="background-image: url(${INLINE})">
  <img src="${IMG}">
  <img srcset="a-small.png 480w, ${IMG2X} 2x, ${IMG} 1x">
  <img src="//img.example.com/proto.png">
  <img src="data:image/png;base64,iVBORw0KGgo=">
  <img src="http://img.example.com/insecure.png">
  <img src="local.png">
  <video src="v.mp4" poster="${POSTER}" data-start="0"></video>
  <svg width="10" height="10"><image href="${SVGIMG}" width="10" height="10"></image></svg>
  ${extra}
</div></body></html>`;

describe('which pictures are collected', () => {
  it('finds https pictures in <img src|srcset>, CSS, inline style, SVG <image> and <video poster>, and nothing else', async () => {
    await withCache(async () => {
      const dir = project({ 'index.html': page(), 'sheet.css': '', 'local.png': 'x' });
      const built = await buildPlan(join(dir, 'index.html'), { discoverOnly: true });
      expect(new Set(built.imageUrls)).toEqual(new Set([GRAIN, MASK, BORDER, LIST, INLINE, IMG, PROTO, POSTER, SVGIMG]));
      // a font-face src and a cursor are not pictures; data:, http: and relative paths are never downloaded
      expect(built.imageUrls.join()).not.toMatch(/woff2|cursor|insecure|local\.png|data:/);
    });
  });

  it('finds the pictures of a linked stylesheet, resolved beside it, and ignores a relative url()', async () => {
    await withCache(async () => {
      const dir = project({
        'index.html': '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><div data-composition-id="m" data-duration="1"></div></body></html>',
        'css/site.css': `.a { background: url(${SHEET}) } .b { background: url(tex.png) }`,
        'css/tex.png': 'x',
      });
      const built = await buildPlan(join(dir, 'index.html'), { discoverOnly: true });
      expect(built.imageUrls).toEqual([SHEET]);
    });
  });

  it('picks the srcset candidate the browser would: 1x, else the smallest density above 1, else the first', () => {
    expect(pickSrcset('a.png 1x, b.png 2x')).toBe('a.png');
    expect(pickSrcset('b.png 3x, a.png 2x')).toBe('a.png');
    expect(pickSrcset('only.png')).toBe('only.png');
    expect(pickSrcset('s.png 480w, l.png 960w')).toBe('s.png');
    expect(pickSrcset('https://r.example.com/i?w=1,h=2 1x, https://r.example.com/j 2x')).toBe('https://r.example.com/i?w=1,h=2');
    expect(pickSrcset('')).toBeNull();
  });

  it('takes only https, and //host as https', () => {
    expect(remoteImage('https://a.example.com/x.png')).toEqual({ url: 'https://a.example.com/x.png' });
    expect(remoteImage('//a.example.com/x.png')).toEqual({ url: 'https://a.example.com/x.png' });
    expect(remoteImage('http://a.example.com/x.png')).toEqual({ refused: 'http://a.example.com/x.png' });
    expect(remoteImage('data:image/png;base64,AAAA')).toBeNull();
    expect(remoteImage('img/x.png')).toBeNull();
    expect(remoteImage('/abs/x.png')).toBeNull();
  });

  it('leaves a property that is not a picture, and a url that is not remote, as written', () => {
    const css = '.a{cursor:url(https://x.example.com/c.png),auto;filter:url(#f);background:url(data:image/png;base64,AAAA);src:url(https://x.example.com/f.woff2)}';
    expect(rewriteCssImages(css, () => '/cache/x')).toBe(css);
    expect(rewriteCssImages('a{background:#fff url(https://x.example.com/p.png) no-repeat}', () => '/c/p.png')).toBe('a{background:#fff url("/c/p.png") no-repeat}');
  });
});

describe('fetch-deps downloads pictures under the script rules', () => {
  it('downloads from an allowed host with a hash recorded, and refuses a host nobody allowed', async () => {
    await withCache(async () => {
      const refused = await fetchCdnData([IMG], { maxBytes: MAX_IMAGE_BYTES, fetchImpl: fakeFetch() });
      expect(refused[0]).toMatchObject({ status: 'failed' });
      expect(refused[0]!.error).toContain('--allow-host img.example.com');
      const ok = await fetchCdnData([IMG], { allowHosts: ['img.example.com'], maxBytes: MAX_IMAGE_BYTES, fetchImpl: fakeFetch() });
      expect(ok[0]).toMatchObject({ status: 'fetched', file: dataCachePath(IMG) });
      expect(dataCachePath(IMG)).toMatch(/\.png$/);
    });
  });

  it('refuses a picture over the size limit and a redirect to another host', async () => {
    await withCache(async () => {
      const big = await fetchCdnData([IMG], { allowHosts: ['img.example.com'], maxBytes: 4, fetchImpl: fakeFetch() });
      expect(big[0]!.error).toContain('over the 4 byte limit');
      const redirect = async () => ({ ok: false, status: 302, headers: { get: (n: string) => (n === 'location' ? 'https://evil.example.net/a.png' : null) }, arrayBuffer: async () => new ArrayBuffer(0) });
      const moved = await fetchCdnData([IMG], { allowHosts: ['img.example.com'], fetchImpl: redirect });
      expect(moved[0]).toMatchObject({ status: 'failed' });
      expect(moved[0]!.error).toContain('evil.example.net is not an allowed host');
    });
  });
});

describe('the render reads the pictures from the cache', () => {
  it('draws a cached picture from its file in every place, and keeps the ones that are not cached as written', async () => {
    await withCache(async () => {
      const dir = project({ 'index.html': page(), 'local.png': 'x' });
      const entry = join(dir, 'index.html');
      const before = await buildPlan(entry);
      expect(before.plan.notes.join('\n')).toContain(`kinetograph fetch-deps`);
      expect(before.plan.notes.join('\n')).toContain(`--allow-host www.transparenttextures.com`);
      expect(before.plan.stylesheets.map((s) => s.css).join('')).toContain(GRAIN);

      await fetchCdnData(before.imageUrls, { allowHosts: ['www.transparenttextures.com', 'img.example.com'], maxBytes: MAX_IMAGE_BYTES, fetchImpl: fakeFetch() });
      const after = await buildPlan(entry);
      const css = after.plan.stylesheets.map((s) => s.css).join('');
      expect(css).toContain(`url("${dataCachePath(GRAIN)}")`);
      expect(css).toContain(`url("${dataCachePath(MASK)}")`);
      expect(css).toContain(`url("${dataCachePath(BORDER)}")`);
      expect(css).toContain(`url("${dataCachePath(LIST)}")`);
      expect(css).toContain('https://img.example.com/x.woff2');
      expect(css).toContain('https://img.example.com/cursor.png');
      const imgs: string[] = [];
      const walk = (nodes: HfNode[]): void => {
        for (const n of nodes) if (n.t === 'el') { if (n.tag === 'img') imgs.push(attr(n, 'src') ?? ''); walk(n.children); }
      };
      walk(after.plan.body);
      expect(imgs.slice(0, 3)).toEqual([dataCachePath(IMG), dataCachePath(IMG), dataCachePath(PROTO)]);
      expect(imgs[4]).toBe('http://img.example.com/insecure.png');
      expect(attr(find(after.plan.body, (n) => n.tag === 'video')!, 'poster')).toBe(dataCachePath(POSTER));
      expect(attr(find(after.plan.body, (n) => n.tag === 'image')!, 'href')).toBe(dataCachePath(SVGIMG));
      expect(attr(find(after.plan.body, (n) => n.tag === 'div' && attr(n, 'data-composition-id') === 'm')!, 'style')).toContain(dataCachePath(INLINE));
      expect(after.plan.notes.join('\n')).not.toContain('is not cached');
      expect(after.plan.notes.join('\n')).toContain('only https');
    });
  });

  it('does not draw a cached picture whose file was changed, and says so', async () => {
    await withCache(async () => {
      const dir = project({ 'index.html': `<!doctype html><html><body><div data-composition-id="m" data-duration="1"><img src="${IMG}"></div></body></html>` });
      const entry = join(dir, 'index.html');
      await fetchCdnData([IMG], { allowHosts: ['img.example.com'], maxBytes: MAX_IMAGE_BYTES, fetchImpl: fakeFetch() });
      expect(attr(find((await buildPlan(entry)).plan.body, (n) => n.tag === 'img')!, 'src')).toBe(dataCachePath(IMG));
      writeFileSync(dataCachePath(IMG), 'tampered');
      const tampered = await buildPlan(entry);
      expect(attr(find(tampered.plan.body, (n) => n.tag === 'img')!, 'src')).toBe(IMG);
      expect(tampered.plan.notes.join('\n')).toContain('does not match the hash');
    });
  });

  it('names the host to allow only when it is not one of the default CDNs', async () => {
    await withCache(async () => {
      const cdn = 'https://cdn.jsdelivr.net/npm/x@1/p.png';
      const dir = project({ 'index.html': `<!doctype html><html><body><div data-composition-id="m" data-duration="1"><img src="${cdn}"><img src="${IMG}"></div></body></html>` });
      const notes = (await buildPlan(join(dir, 'index.html'))).plan.notes;
      expect(notes.find((n) => n.includes(cdn))).not.toContain('--allow-host');
      expect(notes.find((n) => n.includes(IMG))).toContain('--allow-host img.example.com');
    });
  });
});
