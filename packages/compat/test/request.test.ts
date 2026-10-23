// DomNode → IslandRequest (packages/cli/skills/kinetograph/references/ENGINE.md §2): React's style and attribute rules, paths, text, native boxes, `<style>`.

import { describe, expect, it } from 'vitest';
import { attributesOf } from '../src/request/attrs.js';
import { buildIslandRequest, collectStyleElements } from '../src/request/build.js';
import { parseHtmlFragment } from '../src/request/html.js';
import { styleToCss } from '../src/request/style.js';
import type { DomNode } from '../src/types.js';

const el = (type: string, props: Record<string, any> = {}, children: DomNode[] = []): Extract<DomNode, { kind: 'element' }> => ({
  kind: 'element',
  type,
  props,
  children,
});
const text = (value: string): DomNode => ({ kind: 'text', text: value });

describe('style → CSS declaration text', () => {
  it('gives px to numbers except zero, custom properties and the unitless properties', () => {
    expect(styleToCss({ width: 10, height: 0, top: -4.5 })).toBe('width: 10px; height: 0; top: -4.5px');
    expect(styleToCss({ opacity: 0.5, zIndex: 3, flexGrow: 1, lineHeight: 1.4, fontWeight: 800, order: 2 })).toBe(
      'opacity: 0.5; z-index: 3; flex-grow: 1; line-height: 1.4; font-weight: 800; order: 2',
    );
    expect(styleToCss({ '--gap': 12, '--ratio': 1.5 })).toBe('--gap: 12; --ratio: 1.5');
    expect(styleToCss({ scale: 1.2, aspectRatio: 1.5, flex: 1, strokeWidth: 2 })).toBe('scale: 1.2; aspect-ratio: 1.5; flex: 1; stroke-width: 2');
  });

  it('writes camelCase as kebab-case and keeps vendor prefixes', () => {
    expect(styleToCss({ backgroundColor: 'red', WebkitMaskImage: 'none', msTransform: 'none', MozAppearance: 'none' })).toBe(
      'background-color: red; -webkit-mask-image: none; -ms-transform: none; -moz-appearance: none',
    );
    expect(styleToCss({ cssFloat: 'left' })).toBe('float: left');
    expect(styleToCss({ WebkitLineClamp: 3, WebkitFlexGrow: 2 })).toBe('-webkit-line-clamp: 3; -webkit-flex-grow: 2');
  });

  it('leaves out null, undefined, booleans and empty strings, and trims text', () => {
    expect(styleToCss({ color: null, width: undefined, height: false, top: '', left: '  4px ', right: true })).toBe('left: 4px');
    expect(styleToCss(undefined)).toBe('');
    expect(styleToCss('color: red')).toBe('color: red');
  });
});

describe('props → attributes', () => {
  it('renames className and htmlFor and writes HTML names in lower case', () => {
    expect(attributesOf({ className: 'a b', htmlFor: 'x', tabIndex: 1, id: 'k', src: 'a.png' }, false)).toEqual({
      class: 'a b',
      for: 'x',
      tabindex: '1',
      id: 'k',
      src: 'a.png',
    });
  });

  it('writes SVG presentation attributes with hyphens and keeps the camelCase ones', () => {
    expect(
      attributesOf(
        { viewBox: '0 0 10 10', strokeWidth: 2, fillOpacity: 0.5, clipPath: 'url(#a)', gradientUnits: 'userSpaceOnUse', stdDeviation: 3, xlinkHref: '#a' },
        true,
      ),
    ).toEqual({
      viewBox: '0 0 10 10',
      'stroke-width': '2',
      'fill-opacity': '0.5',
      'clip-path': 'url(#a)',
      gradientUnits: 'userSpaceOnUse',
      stdDeviation: '3',
      'xlink:href': '#a',
    });
  });

  it('drops handlers, refs, keys, children and values React drops; writes booleans as the DOM does', () => {
    const attrs = attributesOf(
      { onClick: () => {}, ref: {}, key: 'k', children: 'x', style: {}, a: undefined, b: null, muted: true, hidden: false, 'data-x': true, draggable: false, fn: () => {} },
      false,
    );
    expect(attrs).toEqual({ muted: '', 'data-x': 'true', draggable: 'false' });
  });
});

describe('the island request', () => {
  const base = {
    viewport: { width: 1080, height: 1920 },
    fonts: { 'Inter:400:normal': '/f/Inter.ttf' },
    baseDir: '/p',
    time: 1.5,
    stylesheets: ['.a { color: red }'],
  };

  it('carries the document-level fields and numbers the elements by host path', () => {
    const tree = el('div', { id: 'root', className: 'box', style: { width: 10 } }, [
      text('hello'),
      el('span', {}, [text('x')]),
      el('svg', { viewBox: '0 0 4 4', width: 4 }, [el('path', { d: 'M0 0', strokeWidth: 2 })]),
    ]);
    const { request } = buildIslandRequest(tree, { ...base, path: '$0.2', publicDir: '/p/public' });
    expect(request).toMatchObject({
      viewport: { width: 1080, height: 1920 },
      fonts: { 'Inter:400:normal': '/f/Inter.ttf' },
      baseDir: '/p',
      publicDir: '/p/public',
      time: 1.5,
      path: '$0.2',
      stylesheets: ['.a { color: red }'],
    });
    const root = request.root as any;
    expect(root).toMatchObject({ kind: 'element', tag: 'div', path: '$0.2', attrs: { id: 'root', class: 'box' }, style: 'width: 10px' });
    expect(root.children[0]).toEqual({ kind: 'text', text: 'hello' });
    expect(root.children[1]).toMatchObject({ tag: 'span', path: '$0.2.0' });
    expect(root.children[2]).toMatchObject({ tag: 'svg', path: '$0.2.1', attrs: { viewBox: '0 0 4 4', width: '4' } });
    expect(root.children[2].children[0]).toMatchObject({ tag: 'path', path: '$0.2.1.0', attrs: { d: 'M0 0', 'stroke-width': '2' } });
  });

  it('turns native elements into boxes and remembers them by path', () => {
    const rect = el('kg-rect', { width: 40, height: 20 });
    const layer = el('kg-layer', { layout: { width: [{ frame: 0, value: 7 }, { frame: 9, value: 9 }], height: 3 } });
    const tree = el('div', {}, [el('span'), rect, layer, el('kg-path', { d: 'M0 0' })]);
    const { request, natives } = buildIslandRequest(tree, {
      ...base,
      path: '$0',
      nativeSize: (n) => (n.type === 'kg-rect' ? { width: 40, height: 20 } : n.type === 'kg-layer' ? { width: 7, height: 3 } : { width: 0, height: 0 }),
    });
    const kids = (request.root as any).children;
    expect(kids[1]).toEqual({ kind: 'native', path: '$0.1', width: 40, height: 20 });
    expect(kids[2]).toEqual({ kind: 'native', path: '$0.2', width: 7, height: 3 });
    expect(natives.get('$0.1')).toBe(rect);
    expect(natives.get('$0.2')).toBe(layer);
    expect([...natives.keys()]).toEqual(['$0.1', '$0.2', '$0.3']);
  });

  it('keeps <style> out of the children and in the document-wide list', () => {
    const style = el('style', {}, [text('.x { color: blue }')]);
    const tree = el('div', {}, [style, el('p')]);
    expect(collectStyleElements([tree])).toEqual(['.x { color: blue }']);
    const { request } = buildIslandRequest(tree, { ...base, path: '$0' });
    const kids = (request.root as any).children;
    expect(kids[0]).toMatchObject({ tag: 'style', path: '$0.0', children: [] });
    expect(kids[1]).toMatchObject({ tag: 'p', path: '$0.1' });
  });

  it('reads <style dangerouslySetInnerHTML> and a local <link rel=stylesheet>', () => {
    const tree = el('div', {}, [
      el('style', { dangerouslySetInnerHTML: { __html: 'b { top: 1px }' } }),
      el('link', { rel: 'stylesheet', href: 'a.css' }),
    ]);
    expect(collectStyleElements([tree])).toEqual(['b { top: 1px }']);
    const { request } = buildIslandRequest(tree, {
      ...base,
      path: '$0',
      readStylesheet: (href) => (href === 'a.css' ? 'i { left: 2px }' : null),
    });
    expect(request.stylesheets).toEqual(['.a { color: red }', 'i { left: 2px }']);
  });

  it('parses dangerouslySetInnerHTML into children', () => {
    const tree = el('div', { dangerouslySetInnerHTML: { __html: '<p class="k">a &amp; b</p><svg viewBox="0 0 2 2"><linearGradient id="g"><stop offset="0"/></linearGradient></svg>' } });
    const { request } = buildIslandRequest(tree, { ...base, path: '$0' });
    const kids = (request.root as any).children;
    expect(kids[0]).toMatchObject({ tag: 'p', path: '$0.0', attrs: { class: 'k' }, children: [{ kind: 'text', text: 'a & b' }] });
    expect(kids[1]).toMatchObject({ tag: 'svg', attrs: { viewBox: '0 0 2 2' } });
    expect(kids[1].children[0]).toMatchObject({ tag: 'linearGradient', path: '$0.1.0' });
    expect(kids[1].children[0].children[0]).toMatchObject({ tag: 'stop', attrs: { offset: '0' } });
  });
});

describe('the HTML fragment parser', () => {
  it('handles void tags, comments, entities, raw text and unclosed tags', () => {
    const nodes = parseHtmlFragment('<br><!-- c --><i>&lt;&#65;&#x42;</i><style>a > b { }</style><p>open');
    expect(nodes.map((n) => (n.kind === 'element' ? n.type : n.text))).toEqual(['br', 'i', 'style', 'p']);
    expect((nodes[1] as any).children[0].text).toBe('<AB');
    expect((nodes[2] as any).children[0].text).toBe('a > b { }');
    expect((nodes[3] as any).children[0].text).toBe('open');
  });
});

describe('remote files', () => {
  const opts = { path: '$0', viewport: { width: 100, height: 100 }, fonts: {}, baseDir: '/p', time: 0, stylesheets: [] };

  it('are the local files they were downloaded to, in src, href, poster and CSS url(), looked up once each', async () => {
    const { setRemoteAssetResolver } = await import('../src/environment.js');
    const asked: string[] = [];
    setRemoteAssetResolver((url) => {
      asked.push(url);
      return url.includes('gone') ? null : `/cache/${url.split('/').pop()}`;
    });
    try {
      const { request } = buildIslandRequest(
        el('div', { style: { backgroundImage: 'url(https://x.test/bg.png), url("https://x.test/gone.png")' } }, [
          el('img', { src: 'https://x.test/a.png', style: { maskImage: "url('https://x.test/a.png')" } }),
          el('video', { src: 'https://x.test/v.mp4', poster: 'https://x.test/p.jpg' }),
          el('img', { src: 'local.png' }),
          el('a', { href: 'https://x.test/page' }),
          el('svg', {}, [el('image', { href: 'https://x.test/s.png' })]),
        ]),
        opts,
      );
      const root = request.root as any;
      expect(root.style).toBe('background-image: url("/cache/bg.png"), url("https://x.test/gone.png")');
      const [img, video, local, anchor, svg] = root.children;
      expect(img.attrs.src).toBe('/cache/a.png');
      expect(img.style).toBe('mask-image: url("/cache/a.png")');
      expect(video.attrs).toMatchObject({ src: '/cache/v.mp4', poster: '/cache/p.jpg' });
      expect(local.attrs.src).toBe('local.png');
      // A link is not a file the engine reads.
      expect(anchor.attrs.href).toBe('https://x.test/page');
      expect(svg.children[0].attrs.href).toBe('/cache/s.png');
      expect(asked.filter((u) => u.endsWith('a.png'))).toHaveLength(1);
    } finally {
      setRemoteAssetResolver(null);
    }
  });

  it('are left as they are with no resolver', () => {
    const { request } = buildIslandRequest(el('img', { src: 'https://x.test/a.png' }), opts);
    expect((request.root as any).attrs.src).toBe('https://x.test/a.png');
  });
});
