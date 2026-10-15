// DOM islands in the reconciler (docs/COMPAT.md §2): which host elements are accepted, where an island's layers
// stand, and what reaches the tree's `unsupported` and camera.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setLayoutDom } from '@kinetograph/compat/dom';
import type { LayerJson } from '@kinetograph/scene';
import { Camera, createSceneRoot, Layer, Rect, SequenceHost, Text, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

const font = fileURLToPath(new URL('../../../assets/fonts/DMSans-Medium.ttf', import.meta.url));

/** The addon's CPU `layoutDom`, or null where it is not built. */
function loadLayout(): ((json: string) => string) | null {
  try {
    return (createRequire(import.meta.url)('@kinetograph/native') as { layoutDom: (json: string) => string }).layoutDom;
  } catch {
    return null;
  }
}
const layoutDom = loadLayout();

// These tests are about the Phase 5 mapping's output until the Rust path is verified (KINETOGRAPH_DOM_MAPPER).
beforeAll(() => {
  process.env.KINETOGRAPH_DOM_MAPPER = 'legacy';
  setLayoutDom(layoutDom);
});
afterEach(() => setLayoutDom(layoutDom));

/** Renders in a 1000 x 800 composition with one registered font. */
function render(node: ReactNode, options: { viewport?: { width: number; height: number } } = {}) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 }, fonts: () => ({ 'DM Sans': font }), ...options });
  try {
    return root.render(<TimelineContext.Provider value={timeline(0)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

const ids = (layers: LayerJson[]): string[] =>
  layers.flatMap((l) => [l.id, ...(l.type === 'group' ? ids(l.children) : [])]);
const sq = { width: 10, height: 10, backgroundColor: 'red' };

describe('DOM elements in the reconciler', () => {
  it('accepts DOM host elements with text and native elements inside, and still refuses raw text elsewhere', () => {
    expect(() => render(<Layer>text</Layer>)).toThrow('Raw text "text" is not allowed inside <Layer>');
    expect(() => render(<Text font="Inter" size={10}><div /></Text>)).toThrow('<div> cannot be inside <Text>');
  });

  it('refuses a DOM element without the composition size, naming what to pass', () => {
    const root = createSceneRoot();
    expect(() => root.render(<div />)).toThrow(/createSceneRoot\(\{ viewport/);
    root.unmount();
  });

  it('ignores DOM elements for a root that only discovers compositions', () => {
    const root = createSceneRoot({ ignoreDom: true });
    expect(root.render(<div />).layers).toEqual([]);
    root.unmount();
  });
});

describe.skipIf(layoutDom === null)('islands', () => {
  it('stand where the element stands, with the ids of the host path', () => {
    const tree = render(
      <>
        <Rect width={1} height={1} />
        <Layer id="group">
          <div style={sq} />
          <Rect width={2} height={2} />
        </Layer>
        <div style={sq}>
          <span>hi</span>
        </div>
      </>,
    );
    // The Rect before the islands keeps $0; an island takes its place in the path like any element.
    expect(tree.layers.map((l) => l.id)).toEqual(['$0', 'group', '$2']);
    const group = tree.layers[1] as Extract<LayerJson, { type: 'group' }>;
    expect(group.children.map((c) => c.id)).toEqual(['$1.0', '$1.1']);
  });

  it('puts the island layers in the tree as absolute layout items', () => {
    const tree = render(
      <Layer id="fill" layout={{ flexDirection: 'column', width: 1000, height: 800 }}>
        <div style={{ position: 'absolute', top: 100, left: 50, ...sq }} />
      </Layer>,
    );
    const fill = tree.layers[0] as Extract<LayerJson, { type: 'group' }>;
    expect(fill.children[0]).toMatchObject({ id: '$0.0', layoutItem: { position: 'absolute' }, transform: { x: 50, y: 100 } });
  });

  it('draw native elements inside them, and islands inside native elements inside them', () => {
    const tree = render(
      <div style={{ padding: 10 }}>
        <Rect id="chip" width={20} height={20} fill="#fff" />
        <Layer>
          <div style={sq} />
        </Layer>
      </div>,
    );
    expect(ids(tree.layers)).toEqual(['$0', 'chip', '$0.1', '$0.1.0', '$0.1.0.bg']);
    const root = tree.layers[0] as Extract<LayerJson, { type: 'group' }>;
    expect(root.children.find((c) => c.id === 'chip')).toMatchObject({ transform: { x: 10, y: 10 } });
    // The Layer sits below the 20 px rect.
    expect(root.children.find((c) => c.id === '$0.1')).toMatchObject({ transform: { x: 10, y: 30 } });
  });

  it('collect what compat cannot draw in the tree, once per element', () => {
    const tree = render(
      <div style={{ width: 10, height: 10 }}>
        <div className="x" style={{ float: 'left' }} />
        <canvas />
      </div>,
    );
    expect(tree.unsupported.map((u) => `${u.path}:${u.property}`).sort()).toEqual(['$0.0 <div>:className', '$0.0 <div>:float', '$0.1 <canvas>:null']);
  });

  it('take no unsupported items from a subtree with display none', () => {
    const tree = render(
      <div>
        <div style={{ display: 'none' }}>
          <canvas />
        </div>
      </div>,
    );
    expect(tree.unsupported).toEqual([]);
  });

  it('give the tree its camera from perspective, and one camera is one', () => {
    const p = { position: 'absolute' as const, top: 0, left: 0, perspective: 600, ...sq };
    const tree = render(
      <>
        <div style={p} />
        <div style={p} />
      </>,
    );
    expect(tree.camera).toEqual({ perspective: 600, x: 5, y: 5 });
    expect(() =>
      render(
        <>
          <Camera perspective={700} />
          <div style={p} />
        </>,
      ),
    ).toThrow(/Only one <Camera>/);
  });

  it('take the <Sequence>s out of the way and record them', () => {
    const entry = { key: '/Sequence@0+10', name: null, from: 0, durationInFrames: 10, parent: null };
    const tree = render(
      <div style={{ width: 100 }}>
        <SequenceHost sequence={entry} wrapped={true}>
          <Layer id="inner">
            <div style={sq} />
          </Layer>
        </SequenceHost>
        <div style={sq} />
      </div>,
    );
    // The Sequence takes no place in the path: the layer is $0.0, the next div $0.1.
    expect(tree.sequences).toEqual([{ ...entry, layer: 'inner' }]);
    expect(ids(tree.layers)).toContain('$0.1');
    expect(ids(tree.layers)).not.toContain('$0.2');
  });

  it('keep the ids of native layers outside islands where they were', () => {
    const without = render(
      <>
        <Rect width={1} height={1} />
        <Layer>
          <Rect width={1} height={1} />
        </Layer>
      </>,
    );
    expect(ids(without.layers)).toEqual(['$0', '$1', '$1.0']);
  });
});
