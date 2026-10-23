// mapDomIsland on the addon's renderDomIsland (packages/cli/skills/kinetograph/references/ENGINE.md §2), with a stand-in addon: what is sent, and how the
// answer is turned into layers (native placeholders filled and placed, top-level layers made absolute).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayerJson } from '@kinetographdev/scene';
import {
  beginSamplePass,
  endSamplePass,
  mapDomIsland,
  registerStylesheet,
  resetStylesheets,
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
  afterEach(() => endSamplePass());

  it('builds a later render from what it shares with the first, sharing those layers', () => {
    const pass: unknown[] = [];
    setDomAddon({
      renderDomIsland(json: string, id?: number) {
        pass.push(id);
        return JSON.stringify(answer);
      },
    });
    beginSamplePass();
    answer = { layers: [first, leaf('d', 0)], unsupported: [], camera: null };
    const a = mapDomIsland(node('div'), context()).layers as any[];
    // The group moved and its second child changed; the rest is as it was.
    answer = {
      layers: [{ id: '$1', type: 'group', transform: { x: 2 }, $base: 0, children: [{ $same: 0 }, leaf('b', 5), { $same: 2 }] }, { $same: 1 }],
      unsupported: [],
      camera: null,
      delta: true,
    };
    const b = mapDomIsland(node('div'), context()).layers as any[];
    expect(b[0]).toMatchObject({ id: '$1', type: 'group', transform: { x: 2 }, children: [leaf('a', 0), leaf('b', 5), leaf('c', 0)] });
    expect(b[0]).not.toHaveProperty('$base');
    expect(b[0].children[0]).toBe(a[0].children[0]);
    expect(b[0].children[2]).toBe(a[0].children[2]);
    expect(b[1]).toEqual(a[1]);
    // Both renders are of one pass.
    expect(pass).toHaveLength(2);
    expect(pass[0]).toBeTypeOf('number');
    expect(pass[1]).toBe(pass[0]);
  });

  it('starts again with each pass, and refuses changes from a render it did not make', () => {
    beginSamplePass();
    answer = { layers: [first], unsupported: [], camera: null };
    mapDomIsland(node('div'), context());
    beginSamplePass();
    answer = { layers: [{ $same: 0 }], unsupported: [], camera: null, delta: true };
    expect(() => mapDomIsland(node('div'), context())).toThrow(/did not make/);
  });
});
