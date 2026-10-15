// DOM islands in the reconciler (docs/ENGINE.md §1, §2): which host elements are accepted, where an island's layers
// stand, how native elements are put back where Rust placed them, and what reaches the tree's `unsupported`, camera
// and margin. The addon is a stand-in that answers as the Rust painter does: a group per island root, a placeholder
// for each native element, and whatever the request's attributes ask it to report.

import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import type { LayerJson } from '@kinetograph/scene';
import { Camera, createSceneRoot, Layer, Rect, SequenceHost, Text, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

interface Node {
  kind: 'element' | 'text' | 'native';
  tag?: string;
  path?: string;
  attrs?: Record<string, string>;
  style?: string;
  children?: Node[];
  width?: number;
  height?: number;
}

const requests: { root: Node; path: string; viewport: { width: number; height: number } }[] = [];

/** One group per element, children in order, natives as placeholders at 100 px steps; `data-*` attributes script it. */
function paint(node: Node, y: number): { layer: unknown; used: number } | null {
  if (node.kind === 'text') return null;
  if (node.kind === 'native') {
    return { layer: { type: 'native', path: node.path, x: 0, y, width: node.width ?? 0, height: node.height ?? 0 }, used: 100 };
  }
  const children: unknown[] = [];
  let at = y;
  for (const child of node.children ?? []) {
    const made = paint(child, at);
    if (made) {
      children.push(made.layer);
      at += made.used;
    }
  }
  return { layer: { id: node.path, type: 'group', children }, used: at - y + 10 };
}

beforeAll(() => {
  setDomAddon({
    renderDomIsland(json: string) {
      const request = JSON.parse(json);
      requests.push(request);
      const root = request.root as Node;
      const out: { layers: unknown[]; unsupported: unknown[]; camera: unknown } = {
        layers: [paint(root, 0)!.layer],
        unsupported: [],
        camera: null,
      };
      // Scripted by attributes anywhere in the island.
      const visit = (n: Node): void => {
        if (n.kind !== 'element') return;
        if (n.attrs?.['data-unsupported'] !== undefined) {
          out.unsupported.push({ path: `${n.path} <${n.tag}>`, element: n.tag, property: n.attrs['data-unsupported'], value: null, reason: 'scripted' });
        }
        if (n.attrs?.['data-perspective'] !== undefined) out.camera = { perspective: Number(n.attrs['data-perspective']), x: 5, y: 5 };
        n.children?.forEach(visit);
      };
      visit(root);
      return JSON.stringify(out);
    },
  });
});
afterAll(() => setDomAddon(null));
beforeEach(() => {
  requests.length = 0;
});

/** Renders in a 1000 x 800 composition. */
function render(node: ReactNode, options: { viewport?: { width: number; height: number } } = {}) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 }, ...options });
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
    expect(requests).toHaveLength(0);
  });
});

describe('islands', () => {
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
    expect(requests.map((r) => r.path)).toEqual(['$1.0', '$2']);
  });

  it('put the native elements’ layers where the engine placed their boxes, and are absolute layout items', () => {
    const tree = render(
      <Layer id="fill" layout={{ flexDirection: 'column', width: 1000, height: 800 }}>
        <div style={{ position: 'absolute', top: 100, left: 50, ...sq }}>
          <Rect id="chip" width={20} height={20} fill="#fff" />
        </div>
      </Layer>,
    );
    const fill = tree.layers[0] as Extract<LayerJson, { type: 'group' }>;
    const island = fill.children[0] as Extract<LayerJson, { type: 'group' }>;
    expect(island).toMatchObject({ id: '$0.0', layoutItem: { position: 'absolute' } });
    // The stand-in put the Rect's box at y = 0.
    expect(island.children[0]).toMatchObject({ id: 'chip', type: 'shape' });
    expect(requests[0]!.root.children![0]).toEqual({ kind: 'native', path: '$0.0.0', width: 20, height: 20 });
  });

  it('draw islands inside native elements inside them', () => {
    const tree = render(
      <div style={{ padding: 10 }}>
        <Rect id="chip" width={20} height={20} fill="#fff" />
        <Layer>
          <div style={sq} />
        </Layer>
      </div>,
    );
    expect(ids(tree.layers)).toEqual(['$0', 'chip', '$0.1', '$0.1.0']);
    const root = tree.layers[0] as Extract<LayerJson, { type: 'group' }>;
    // The stand-in puts the first native at y 0 and the second 100 px lower.
    expect(root.children.find((c) => c.id === '$0.1')).toMatchObject({ transform: { y: 100 } });
  });

  it('collect what the engine cannot draw, and the camera it asks for', () => {
    const tree = render(
      <div style={{ width: 10, height: 10 }} data-perspective="600">
        <div data-unsupported="float" />
        <canvas data-unsupported="canvas" />
      </div>,
    );
    expect(tree.unsupported.map((u) => `${u.path}:${u.property}`)).toEqual(['$0.0 <div>:float', '$0.1 <canvas>:canvas']);
    expect(tree.camera).toEqual({ perspective: 600, x: 5, y: 5 });
  });

  it('give the tree one camera, and refuse a second one', () => {
    const a = <div data-perspective="600" style={sq} />;
    expect(render(<>{a}{a}</>).camera).toEqual({ perspective: 600, x: 5, y: 5 });
    expect(() =>
      render(
        <>
          <Camera perspective={700} />
          {a}
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
    expect(requests).toHaveLength(0);
  });
});
