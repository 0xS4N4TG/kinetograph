// A <Sequence> is an AbsoluteFill in Remotion: with DOM inside it (or around it) it is that `div`, in the same CSS tree
// as its surroundings, so a flex-centered AbsoluteFill does not move it (docs/ENGINE.md §10.1).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { createSceneRoot, Rect, TimelineContext } from '@kinetograph/react';
import { AbsoluteFill } from '../src/fill.js';
import { Loop, Sequence } from '../src/timeline.js';

let sent: any[];
beforeEach(() => {
  sent = [];
  setDomAddon({
    renderDomIsland(json: string) {
      const request = JSON.parse(json);
      sent.push(request);
      const natives = request.root.children
        .filter((c: any) => c.kind === 'native')
        .map((c: any) => ({ type: 'native', path: c.path, x: 0, y: 0, width: c.width ?? 0, height: c.height ?? 0 }));
      return JSON.stringify({ layers: [{ id: request.path, type: 'group', children: natives }], unsupported: [], camera: null });
    },
  });
});
afterEach(() => setDomAddon(null));

const timeline = {
  frame: 0,
  absoluteFrame: 0,
  durationInFrames: 60,
  config: { id: 'T', width: 1000, height: 800, fps: 30, durationInFrames: 60, defaultProps: {}, props: {} },
  frozen: false,
};

function render(node: React.ReactNode) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 } });
  try {
    return root.render(<TimelineContext.Provider value={timeline}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

const summary = (n: any): any =>
  n.kind === 'element' ? { tag: n.tag, path: n.path, ...(n.children.length ? { children: n.children.map(summary) } : {}) } : n.kind === 'text' ? n.text : { native: n.path };

describe('Sequence with DOM inside', () => {
  it('is a div of the same island as the AbsoluteFill around it', () => {
    const tree = render(
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Sequence from={0}>
          <p>hi</p>
        </Sequence>
        <Sequence from={10}>
          <p>not yet</p>
        </Sequence>
      </AbsoluteFill>,
    );
    expect(sent).toHaveLength(1);
    expect(summary(sent[0].root)).toEqual({
      tag: 'div',
      path: '$0',
      // Only the Sequence that is showing has a wrapper; its path is where it stands (the second one shows nothing).
      children: [{ tag: 'div', path: '$0.0', children: [{ tag: 'p', path: '$0.0.0', children: ['hi'] }] }],
    });
    expect(sent[0].root.children[0].style).toBe('position: absolute; inset: 0; display: flex; flex-direction: column');
    expect(tree.sequences).toHaveLength(2);
  });

  it('is a div in a Loop at the top of the tree, and stays a layer when only layers are inside', () => {
    render(
      <Loop durationInFrames={20}>
        <section />
      </Loop>,
    );
    expect(summary(sent[0].root)).toEqual({ tag: 'div', path: '$0', children: [{ tag: 'section', path: '$0.0' }] });
    sent.length = 0;
    const tree = render(
      <Sequence>
        <Rect width={5} height={5} />
      </Sequence>,
    );
    expect(sent).toHaveLength(0);
    expect(tree.layers[0]).toMatchObject({ type: 'group' });
  });
});
