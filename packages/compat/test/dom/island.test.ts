// mapDomIsland end to end: React-shaped host nodes, the real parseStyle, the real layout.

import { describe, expect, it } from 'vitest';
import { isDomElement, mapDomIsland, setLayoutDom } from '../../src/dom/index.js';
import type { DomNode } from '../../src/types.js';
import { context, find, hasAddon, nativeLayout } from './helpers.js';

const node = (type: string, props: Record<string, any> = {}, children: DomNode[] = []): DomNode => ({ kind: 'element', type, props, children });
const text = (t: string): DomNode => ({ kind: 'text', text: t });

describe('isDomElement', () => {
  it('accepts HTML, SVG and custom elements, never kg-*', () => {
    for (const type of ['div', 'span', 'img', 'svg', 'path', 'linearGradient', 'canvas', 'my-widget', 'h3', 'li']) {
      expect(isDomElement(type), type).toBe(true);
    }
    for (const type of ['kg-layer', 'kg-text', 'bogus', 'root', 'Div']) expect(isDomElement(type), type).toBe(false);
  });
});

describe.skipIf(!hasAddon)('mapDomIsland', () => {
  it('reads inline style objects as React passes them', () => {
    setLayoutDom(nativeLayout());
    const result = mapDomIsland(
      node(
        'div',
        { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: '#112233' } },
        [node('div', { style: { width: 100, height: 40, backgroundColor: 'rgba(255, 0, 0, 0.5)', borderRadius: 8, opacity: 0.9 } })],
      ),
      context(),
    );
    expect(result.unsupported).toEqual([]);
    const [island] = result.layers as any[];
    expect(island).toMatchObject({ id: '$0', layoutItem: { position: 'absolute' } });
    expect(find(island, '$0.bg')).toMatchObject({ shape: { kind: 'rect', width: 1000, height: 800 }, fill: '#112233' });
    const child = find(island, '$0.0');
    expect(child).toMatchObject({ opacity: 0.9, transform: { x: 450, y: 380 } });
    expect(find(island, '$0.0.bg')).toMatchObject({ shape: { kind: 'roundedRect', radius: 8 }, fill: '#ff000080' });
  });

  it('draws text with a registered font and reports a class name', () => {
    setLayoutDom(nativeLayout());
    const result = mapDomIsland(
      node('div', { className: 'title', style: { fontFamily: 'DM Sans, sans-serif', fontSize: 40, color: 'white', width: 500 } }, [text('Hello  world')]),
      context(),
    );
    expect(result.unsupported).toEqual([
      { path: '$0 <div>', element: 'div', property: 'className', value: 'title', reason: expect.any(String) },
    ]);
    expect(find(result.layers[0], '$0.text')).toMatchObject({ text: 'Hello world', font: 'DM Sans', size: 40, color: '#ffffff', maxWidth: 500 });
  });

  it('reports what parseStyle cannot read, and skips the diagnostics of a display: none subtree', () => {
    setLayoutDom(nativeLayout());
    const result = mapDomIsland(
      node('div', { style: { float: 'left', width: 10, height: 10 } }, [node('div', { style: { display: 'none', outline: '1px solid red' } })]),
      context(),
    );
    expect(result.unsupported.map((u) => u.property)).toEqual(['float']);
  });

  it('claims explicit ids, and falls back to the path for one that is taken', () => {
    setLayoutDom(nativeLayout());
    const taken = new Set<string>(['dup']);
    const result = mapDomIsland(
      node('div', { id: 'card', style: { width: 10, height: 10, backgroundColor: 'red' } }, [
        node('div', { id: 'dup', style: { width: 5, height: 5, backgroundColor: 'red' } }),
        node('div', { id: '$reserved', style: { width: 5, height: 5, backgroundColor: 'red' } }),
      ]),
      context({ claimId: (id) => (taken.has(id) ? false : (taken.add(id), true)) }),
    );
    expect((result.layers[0] as any).id).toBe('card');
    expect(find(result.layers[0], 'card.bg')).toBeDefined();
    expect(find(result.layers[0], '$0.0')).toBeDefined();
    expect(find(result.layers[0], '$0.1')).toBeDefined();
  });

  it('numbers native children among the element children, and lays the island out in the composition', () => {
    setLayoutDom(nativeLayout());
    const seen: string[] = [];
    const result = mapDomIsland(
      node('div', { style: { padding: 10 } }, [
        text('  '),
        node('kg-rect', {}),
        node('div', { style: { width: 5, height: 5, backgroundColor: 'red' } }),
      ]),
      context({
        emitNative: (n, path) => {
          seen.push(`${(n as { type: string }).type}@${path}`);
          return { id: path, type: 'shape', shape: { kind: 'rect', width: 20, height: 20 }, fill: '#fff' };
        },
      }),
    );
    expect(seen).toEqual(['kg-rect@$0.0']);
    expect(find(result.layers[0], '$0.0')).toMatchObject({ transform: { x: 10, y: 10 } });
    expect(find(result.layers[0], '$0.1').transform).toEqual({ x: 10, y: 30 });
  });

  it('is empty for a root with display none, and needs an element', () => {
    setLayoutDom(nativeLayout());
    expect(mapDomIsland(node('div', { style: { display: 'none' } }), context())).toEqual({ layers: [], unsupported: [], camera: null });
    expect(() => mapDomIsland(text('x'), context())).toThrow(/DOM element/);
  });
});
