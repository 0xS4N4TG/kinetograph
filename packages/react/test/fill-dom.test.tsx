// An <AbsoluteFill>'s layer mapping that holds DOM elements is drawn as the `div` it is in Remotion (docs/ENGINE.md §10):
// the island's root is that flex column, its children are the layer's, and the paths stay where they were.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { createSceneRoot, Layer, Rect, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

let sent: any[];
beforeEach(() => {
  sent = [];
  setDomAddon({
    renderDomIsland(json: string) {
      const request = JSON.parse(json);
      sent.push(request);
      // A group with a placeholder for each native element, as Rust leaves them.
      const natives = request.root.children
        .filter((c: any) => c.kind === 'native')
        .map((c: any) => ({ type: 'native', path: c.path, x: 0, y: 0, width: c.width ?? 0, height: c.height ?? 0 }));
      return JSON.stringify({
        layers: [{ id: request.path, type: 'group', children: natives }],
        unsupported: [],
        camera: null,
        ...(request.root.attrs?.['data-margin'] ? { margin: Number(request.root.attrs['data-margin']) } : {}),
      });
    },
  });
});
afterEach(() => setDomAddon(null));

const fill = (style: Record<string, unknown>, background = false, id?: string) => ({ style, background, ...(id ? { id } : {}) });

function render(node: React.ReactNode) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 } });
  try {
    return root.render(<TimelineContext.Provider value={timeline(0)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

describe('the margin islands ask for', () => {
  it('is the largest of them on the tree, and absent when none asks', () => {
    expect(render(<div />).margin).toBeUndefined();
    expect(render(<><div data-margin="8" /><div data-margin="30" /><div data-margin="12" /></>).margin).toBe(30);
  });
});

describe('AbsoluteFill with DOM children', () => {
  it('is a flex column div over the page with the author’s style on top', () => {
    const tree = render(
      <Layer layout={{ flexDirection: 'column', width: 1000, height: 800 }} domFill={fill({ justifyContent: 'center', alignItems: 'center' }, false, 'fill')}>
        <p>hello</p>
        <Rect width={5} height={5} />
      </Layer>,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].root).toMatchObject({
      tag: 'div',
      path: '$0',
      attrs: { id: 'fill' },
      style: 'position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center',
    });
    expect(sent[0].root.children.map((c: any) => [c.kind, c.tag ?? '', c.path])).toEqual([
      ['element', 'p', '$0.0'],
      ['native', '', '$0.1'],
    ]);
    expect(tree.layers).toHaveLength(1);
  });

  it('drops the background rectangle the layer mapping adds (the style has the colour)', () => {
    render(
      <Layer domFill={fill({ backgroundColor: '#123' }, true)}>
        <Rect width={1} height={1} fill="#123" />
        <span>x</span>
      </Layer>,
    );
    expect(sent[0].root.style).toContain('background-color: #123');
    expect(sent[0].root.children.map((c: any) => c.path)).toEqual(['$0.0']);
  });

  it('stays the native layer when nothing DOM is inside it', () => {
    const tree = render(
      <Layer id="plain" domFill={fill({})}>
        <Rect width={1} height={1} />
      </Layer>,
    );
    expect(sent).toHaveLength(0);
    expect(tree.layers[0]).toMatchObject({ id: 'plain', type: 'group' });
  });

  it('is found when the DOM element is deeper, through native layers', () => {
    render(
      <Layer domFill={fill({})}>
        <Layer>
          <div />
        </Layer>
      </Layer>,
    );
    // One island for the AbsoluteFill's div, and the inner div (inside a native Layer inside it) is another.
    expect(sent.map((s) => s.root.path)).toEqual(['$0', '$0.0.0']);
  });
});
