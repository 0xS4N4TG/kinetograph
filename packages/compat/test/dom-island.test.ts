// mapDomIsland on the addon's renderDomIsland (packages/cli/skills/kinetograph/references/ENGINE.md §2), with a stand-in addon: what is sent, and how the
// answer is turned into layers (native placeholders filled and placed, top-level layers made absolute).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayerJson } from '@kinetographdev/scene';
import {
  beginSamplePass,
  breakSamplePasses,
  currentSamplePass,
  endSamplePass,
  mapDomIsland,
  noteIslandState,
  registerStylesheet,
  resetStylesheets,
  setCssFontFaceHandler,
  setDomAddon,
  setDomEnvironment,
} from '../src/dom/index.js';
import type { DomNode } from '../src/types.js';

const node = (type: string, props: Record<string, any> = {}, children: DomNode[] = []): DomNode => ({ kind: 'element', type, props, children });

let sent: any[] = [];
let answer: unknown = { layers: [], unsupported: [], camera: null };

beforeEach(() => {
  sent = [];
  setDomEnvironment({ baseDir: '/proj/src', publicDir: '/proj/public' });
  setDomAddon({
    renderDomIsland(json: string) {
      sent.push(JSON.parse(json));
      return JSON.stringify(answer);
    },
  });
});
afterEach(() => {
  setDomAddon(null);
  resetStylesheets();
});

const context = (extra = {}) => ({
  path: '$1',
  viewport: { width: 1080, height: 1920 },
  fonts: { 'Inter:400:normal': '/f.ttf' },
  emitNative: () => null,
  ...extra,
});

describe('mapDomIsland', () => {
  it('sends the island with the environment, the clock and the imported stylesheets', () => {
    registerStylesheet('.a { color: red }');
    mapDomIsland(node('div', { style: { width: 5 } }), context({ time: 2.5 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      path: '$1',
      time: 2.5,
      baseDir: '/proj/src',
      publicDir: '/proj/public',
      stylesheets: ['.a { color: red }'],
      viewport: { width: 1080, height: 1920 },
      root: { kind: 'element', tag: 'div', path: '$1', style: 'width: 5px' },
    });
  });

  it('puts the native elements’ layers where Rust placed their boxes, at any depth', () => {
    const rect = node('kg-rect', { width: 30, height: 10, transform: undefined });
    const nested = node('kg-rect', { width: 4, height: 4, x: 5, anchorX: 2 });
    answer = {
      layers: [
        {
          id: '$1',
          type: 'group',
          children: [
            { type: 'native', path: '$1.0', x: 12, y: 7, width: 30, height: 10 },
            { id: '$1.1.bg', type: 'group', children: [{ type: 'native', path: '$1.1', x: 100, y: 200, width: 4, height: 4 }] },
            { type: 'native', path: '$1.2', x: 0, y: 0, width: 0, height: 0 },
          ],
        },
      ],
      unsupported: [],
      camera: null,
    };
    const emitted: string[] = [];
    const result = mapDomIsland(node('div', {}, [rect, nested, node('kg-camera')]), {
      ...context(),
      emitNative: (n: DomNode, path: string) => {
        emitted.push(path);
        if (n.kind !== 'element' || n.type === 'kg-camera') return null;
        return { id: path === '$1.0' ? 'r' : 'n', type: 'shape', shape: { kind: 'rect', width: 1, height: 1 }, ...(n.props.x ? { transform: { x: n.props.x, anchorX: n.props.anchorX } } : {}) } as LayerJson;
      },
    });
    expect(emitted).toEqual(['$1.0', '$1.1', '$1.2']);
    const root = result.layers[0] as Extract<LayerJson, { type: 'group' }>;
    expect(root.layoutItem).toEqual({ position: 'absolute' });
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ id: 'r', transform: { x: 12, y: 7 } });
    const inner = root.children[1] as Extract<LayerJson, { type: 'group' }>;
    // The layer's own x (5) is an offset from the box (100), and its anchor (2) shifts it too.
    expect(inner.children[0]).toMatchObject({ id: 'n', transform: { x: 107, y: 200, anchorX: 2 } });
  });

  it('measures native boxes from the layer props', () => {
    mapDomIsland(
      node('div', {}, [
        node('kg-rect', { width: 40, height: 20 }),
        node('kg-layer', { layout: { width: 7, height: 3 } }),
        node('kg-layer', {}),
        node('kg-image', { src: 'a.png', width: 9, height: 8 }),
        node('kg-path', { d: 'M0 0' }),
      ]),
      context(),
    );
    const kids = sent[0].root.children;
    expect(kids.map((k: any) => [k.width, k.height])).toEqual([[40, 20], [7, 3], [0, 0], [9, 8], [0, 0]]);
  });

  it('passes unsupported items and the camera through, and keeps a layer’s own layoutItem', () => {
    answer = {
      layers: [{ id: '$1', type: 'group', children: [], layoutItem: { position: 'relative' } }],
      unsupported: [{ path: '$1 <div>', element: 'div', property: 'filter', value: 'url(#x)', reason: 'not drawn' }],
      camera: { perspective: 800 },
    };
    const result = mapDomIsland(node('div'), context());
    expect(result.unsupported).toHaveLength(1);
    expect(result.camera).toEqual({ perspective: 800 });
    expect((result.layers[0] as any).layoutItem).toEqual({ position: 'relative' });
  });

  it('passes the margin the island needs through, only when there is one', () => {
    answer = { layers: [], unsupported: [], camera: null, margin: 24 };
    expect(mapDomIsland(node('div'), context()).margin).toBe(24);
    answer = { layers: [], unsupported: [], camera: null };
    expect('margin' in mapDomIsland(node('div'), context())).toBe(false);
  });

  it('passes the blend space the painter asks for', () => {
    answer = { layers: [], unsupported: [], camera: null, blendSpace: 'srgb' };
    expect(mapDomIsland(node('div'), context()).blendSpace).toBe('srgb');
    answer = { layers: [], unsupported: [], camera: null };
    expect('blendSpace' in mapDomIsland(node('div'), context())).toBe(false);
  });

  it('draws nothing for a <style> root without asking the addon, and needs an element', () => {
    expect(mapDomIsland(node('style', {}, [{ kind: 'text', text: 'a{}' }]), context()).layers).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(() => mapDomIsland({ kind: 'text', text: 'x' }, context())).toThrow('needs a DOM element');
    expect(() => mapDomIsland(node('kg-layer'), context())).toThrow('needs a DOM element');
  });

  it('says what is missing when the addon has no renderDomIsland', () => {
    setDomAddon({});
    expect(() => mapDomIsland(node('div'), context())).toThrow('no renderDomIsland()');
  });
});

describe('a pass of island renders', () => {
  const leaf = (id: string, x: number) => ({ id, type: 'shape', shape: { kind: 'rect', width: 1, height: 1 }, transform: { x } });
  const first = { id: '$1', type: 'group', transform: { x: 1 }, children: [leaf('a', 0), leaf('b', 0), leaf('c', 0)] };
  /** The pass and base of each render the addon was asked for. */
  let calls: { pass?: number; base?: number }[] = [];
  beforeEach(() => {
    calls = [];
    setDomAddon({
      renderDomIsland(_json: string, pass?: number, base?: number) {
        calls.push({ pass, base });
        return JSON.stringify(answer);
      },
    });
  });
  afterEach(() => endSamplePass());
  const full = (layers: unknown[]) => ({ layers, unsupported: [], camera: null });
  const changes = (layers: unknown[], delta: number) => ({ layers, unsupported: [], camera: null, delta });

  it('builds a later render from what it shares with the first, sharing those layers', () => {
    beginSamplePass();
    answer = full([first, leaf('d', 0)]);
    const a = mapDomIsland(node('div'), context()).layers as any[];
    const pass = calls[0]!.pass!;
    // The group moved and its second child changed; the rest is as it was.
    answer = changes([{ id: '$1', type: 'group', transform: { x: 2 }, $base: 0, children: [{ $same: 0 }, leaf('b', 5), { $same: 2 }] }, { $same: 1 }], pass);
    const b = mapDomIsland(node('div'), context()).layers as any[];
    expect(b[0]).toMatchObject({ id: '$1', type: 'group', transform: { x: 2 }, children: [leaf('a', 0), leaf('b', 5), leaf('c', 0)] });
    expect(b[0]).not.toHaveProperty('$base');
    expect(b[0].children[0]).toBe(a[0].children[0]);
    expect(b[0].children[2]).toBe(a[0].children[2]);
    expect(b[1]).toEqual(a[1]);
    // Both renders are of one pass; the first had no base, the second names the first's pass.
    expect(pass).toBeTypeOf('number');
    expect(calls).toEqual([{ pass, base: undefined }, { pass, base: pass }]);
  });

  it("writes the next pass against the last pass's first render, then against its own first", () => {
    beginSamplePass();
    answer = full([first]);
    const a = mapDomIsland(node('div'), context()).layers as any[];
    endSamplePass();
    beginSamplePass();
    const p0 = calls[0]!.pass!;
    answer = changes([{ $same: 0 }], p0);
    const b = mapDomIsland(node('div'), context()).layers as any[];
    // An unchanged layer is the same object from one frame to the next.
    expect(b[0].children[1]).toBe(a[0].children[1]);
    const p1 = calls[1]!.pass!;
    expect(p1).toBe(p0 + 1);
    expect(calls[1]!.base).toBe(p0);
    // A later render of the second pass is written against that pass's first.
    answer = changes([{ $same: 0 }], p1);
    mapDomIsland(node('div'), context());
    expect(calls[2]).toEqual({ pass: p1, base: p1 });
  });

  it('keeps a render written in full as the base', () => {
    beginSamplePass();
    answer = full([first]);
    mapDomIsland(node('div'), context());
    const p = calls[0]!.pass!;
    // The addon held other layers and wrote this render in full: the next one is written against it.
    answer = full([leaf('z', 9)]);
    mapDomIsland(node('div'), context());
    answer = changes([{ $same: 0 }], p);
    expect((mapDomIsland(node('div'), context()).layers as any[])[0]).toMatchObject({ id: 'z' });
  });

  it('drops the bases when a pass does not follow the last', () => {
    beginSamplePass();
    answer = full([first]);
    mapDomIsland(node('div'), context());
    endSamplePass();
    breakSamplePasses();
    beginSamplePass();
    mapDomIsland(node('div'), context());
    expect(calls[1]!.pass).toBe(calls[0]!.pass! + 2);
    expect(calls[1]!.base).toBeUndefined();
  });

  it('refuses changes from a render it did not make', () => {
    beginSamplePass();
    answer = full([first]);
    mapDomIsland(node('div'), context());
    answer = changes([{ $same: 0 }], calls[0]!.pass! - 1);
    expect(() => mapDomIsland(node('div'), context())).toThrow(/did not make/);
    endSamplePass();
    breakSamplePasses();
    beginSamplePass();
    answer = changes([{ $same: 0 }], calls[0]!.pass!);
    expect(() => mapDomIsland(node('div'), context())).toThrow(/did not make/);
  });
});

describe('fonts of the page\'s own CSS', () => {
  it('are in the request of the frame their <style> first appears in, not only from the next', () => {
    answer = { layers: [], unsupported: [], camera: null };
    const registry: Record<string, string> = { 'Inter:400:normal': '/f.ttf' };
    setCssFontFaceHandler((face) => {
      registry[`${face.family}:${face.weight}:${face.style}`] = `/proj/src/${face.url}`;
    });
    try {
      const css = '@font-face{font-family:KaTeX_Main;font-style:normal;font-weight:400;src:url(KaTeX_Main-Regular.woff2) format("woff2")}';
      // The caller read the font list before the island's stylesheets were seen, as emit does.
      mapDomIsland(node('div', {}, [node('span', {}, [{ kind: 'text', text: 'x' }])]), context({ fonts: { ...registry }, refreshFonts: () => ({ ...registry }), stylesheets: [css] }));
      expect(sent[0].fonts).toEqual({ 'Inter:400:normal': '/f.ttf', 'KaTeX_Main:400:normal': '/proj/src/KaTeX_Main-Regular.woff2' });
    } finally {
      setCssFontFaceHandler(null);
    }
  });
});

describe('a render of the state a readback left', () => {
  afterEach(() => {
    endSamplePass();
    noteIslandState('$1', null);
  });

  it('names the state instead of sending the request, and sends it when the addon does not hold the state', () => {
    const got: string[] = [];
    let stale = false;
    setDomAddon({
      renderDomIsland(json: string) {
        got.push(json);
        if (stale && json.startsWith('{"stamp"')) throw Object.assign(new Error('not kept'), { code: 'STALE_BASE' });
        return JSON.stringify({ layers: [], unsupported: [], camera: null });
      },
    });
    const tree = node('div', { style: { width: 5 } });
    // The request a readback sent: the one this render builds.
    mapDomIsland(tree, context());
    const request = JSON.parse(got[0]!);
    beginSamplePass();
    // A state of another pass is not named.
    noteIslandState('$1', { stamp: 7, pass: -1, request });
    mapDomIsland(tree, context());
    noteIslandState('$1', { stamp: 7, pass: currentSamplePass(), request });
    mapDomIsland(tree, context());
    // Another tree is sent.
    mapDomIsland(node('div', { style: { width: 6 } }), context());
    // A state the addon does not hold: the request is sent after all.
    stale = true;
    mapDomIsland(tree, context());
    expect(got.slice(1).map((json) => JSON.parse(json).stamp ?? 'request')).toEqual(['request', 7, 'request', 7, 'request']);
    expect(JSON.parse(got[2]!)).toEqual({ stamp: 7, base: 7, path: '$1', time: 0, set: [] });
  });
});
