import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { createSceneRoot, Rect, Text, TimelineContext, useTimeline } from '@kinetograph/react';
import { AbsoluteFill, Img, resetStyleWarnings } from '../src/fill.js';
import { Freeze } from '../src/timeline.js';
import { renderAt, timeline } from './scene-harness.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetStyleWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('AbsoluteFill', () => {
  it('is a full-size column layer that sits out of its parent flow', () => {
    const [fill] = renderAt(<AbsoluteFill />).layers;
    expect(fill).toMatchObject({
      type: 'group',
      layout: { flexDirection: 'column', width: 1280, height: 720 },
      layoutItem: { position: 'absolute' },
    });
  });

  it('maps the supported style keys', () => {
    const [fill] = renderAt(
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 20px',
          opacity: 0.5,
        }}
      />,
    ).layers as any[];
    expect(fill.layout).toEqual({
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'flex-end',
      flexWrap: 'wrap',
      gap: 12,
      padding: [10, 20, 10, 20],
      width: 1280,
      height: 720,
    });
    expect(fill.opacity).toBe(0.5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('draws backgroundColor as a full-size rect first, out of the flow', () => {
    const [fill] = renderAt(
      <AbsoluteFill style={{ backgroundColor: '#112233' }}>
        <Text font="Inter" size={40}>
          hi
        </Text>
      </AbsoluteFill>,
    ).layers as any[];
    expect(fill.children).toHaveLength(2);
    expect(fill.children[0]).toMatchObject({
      type: 'shape',
      shape: { kind: 'rect', width: 1280, height: 720 },
      fill: '#112233',
      layoutItem: { position: 'absolute' },
    });
    expect(fill.children[1].type).toBe('text');
  });

  it('takes `background` as a colour too and draws nothing for a transparent one', () => {
    const [a] = renderAt(<AbsoluteFill style={{ background: 'red' }} />).layers as any[];
    expect(a.children[0].fill).toBe('red');
    const [b] = renderAt(<AbsoluteFill style={{ backgroundColor: 'transparent' }} />).layers as any[];
    expect(b.children ?? []).toHaveLength(0);
  });

  it('warns once about a value it cannot map, however often it renders', () => {
    renderAt(<AbsoluteFill style={{ gap: '2em' }} />);
    renderAt(<AbsoluteFill style={{ gap: '3em' }} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('style.gap');
  });

  it('warns about a background that is not a colour, and about display values it cannot do', () => {
    renderAt(<AbsoluteFill style={{ background: 'linear-gradient(red, blue)', display: 'block' }} />);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('renders nothing for display: none', () => {
    expect(renderAt(<AbsoluteFill style={{ display: 'none' }} />).layers).toEqual([]);
  });

  it('follows the composition size', () => {
    const [fill] = renderAt(<AbsoluteFill />, 0, {
      config: { id: 'S', width: 1080, height: 1920, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} },
    }).layers as any[];
    expect(fill.layout).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe('Img', () => {
  it('maps width, height and objectFit from style', () => {
    const [img] = renderAt(<Img src="/a.png" style={{ width: 300, height: '200px', objectFit: 'cover' }} />).layers;
    expect(img).toMatchObject({ type: 'image', src: '/a.png', width: 300, height: 200, fit: 'cover' });
  });

  it('takes width and height props when style has none, and leaves the rest to the engine', () => {
    const [img] = renderAt(<Img src="/a.png" width={64} />).layers as any[];
    expect(img.width).toBe(64);
    expect(img.height).toBeUndefined();
    expect(img.fit).toBeUndefined();
  });

  it('warns about an object fit it cannot do', () => {
    renderAt(<Img src="/a.png" style={{ objectFit: 'none' }} />);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('Freeze', () => {
  it('marks the timeline frozen for what is inside', () => {
    const seen: boolean[] = [];
    function Reader() {
      seen.push(useTimeline().frozen);
      return null;
    }
    renderAt(
      <>
        <Freeze frame={4}>
          <Reader />
        </Freeze>
        <Freeze frame={4} active={false}>
          <Reader />
        </Freeze>
        <Reader />
      </>,
    );
    expect(seen).toEqual([true, false, false]);
  });
});

// ---- the DOM elements they are with any other key, or with DOM inside them (docs/ENGINE.md §10.1) ----

/** Renders in the 1280 x 720 composition of the harness, as the frame loop makes its root. */
function renderDom(node: ReactNode) {
  const root = createSceneRoot({ viewport: { width: 1280, height: 720 } });
  try {
    return root.render(<TimelineContext.Provider value={timeline(0)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

describe('as DOM elements', () => {
  // A stand-in addon: it records the islands it is asked to draw and answers a group per island with a placeholder
  // for each native element, as the Rust painter does.
  const sent: any[] = [];
  beforeAll(() => {
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
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(() => setDomAddon(null));

  it('AbsoluteFill with a style key the layers have no use for is a div over the whole page', () => {
    const tree = renderDom(<AbsoluteFill style={{ backgroundColor: '#112233', zIndex: 3, backgroundImage: 'linear-gradient(red, blue)' }} />);
    expect(warn).not.toHaveBeenCalled();
    expect(tree.unsupported).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].root).toMatchObject({
      tag: 'div',
      path: '$0',
      style:
        'position: absolute; inset: 0; display: flex; flex-direction: column; background-color: #112233; z-index: 3; background-image: linear-gradient(red, blue)',
    });
    expect((tree.layers[0] as any).id).toBe('$0');
  });

  it('lays its children out in a column unless the author says otherwise (CSS does, not the layer mapping)', () => {
    renderDom(
      <AbsoluteFill style={{ flexDirection: 'row', zIndex: 1 }}>
        <div style={{ width: 100, height: 20, backgroundColor: 'red' }} />
        <div style={{ width: 50, height: 20, backgroundColor: 'red' }} />
      </AbsoluteFill>,
    );
    expect(sent[0].root.style).toContain('flex-direction: row');
    renderDom(
      <AbsoluteFill style={{ zIndex: 1 }}>
        <div />
      </AbsoluteFill>,
    );
    expect(sent[1].root.style).toContain('flex-direction: column');
  });

  it('with a class name is a div carrying the class, with Tailwind and stylesheets left to the CSS engine', () => {
    renderDom(<AbsoluteFill className="bg" />);
    expect(sent[0].root).toMatchObject({ tag: 'div', attrs: { class: 'bg' } });
  });

  it('with only the keys the layers read, and no DOM inside, keeps the layers, so the hand ports render as before', () => {
    const [fill] = renderAt(<AbsoluteFill style={{ backgroundColor: '#112233', opacity: 0.5, flexDirection: 'row', gap: 4 }} />).layers as any[];
    expect(fill).toMatchObject({ type: 'group', layout: { width: 1280, height: 720, flexDirection: 'row', gap: 4 }, opacity: 0.5 });
    expect(sent).toHaveLength(0);
  });

  it('with only the keys the layers read becomes the div when DOM elements are inside it', () => {
    renderDom(
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p>centred</p>
      </AbsoluteFill>,
    );
    expect(sent[0].root.style).toBe('position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center');
    expect(sent[0].root.children[0]).toMatchObject({ tag: 'p', path: '$0.0' });
  });

  it('Img with a style key the image layer has no use for is an img', () => {
    renderDom(<Img src="/a.png" width={64} height={32} style={{ borderRadius: 8, objectFit: 'cover' }} />);
    expect(sent[0].root).toMatchObject({
      tag: 'img',
      path: '$0',
      attrs: { src: '/a.png', width: '64', height: '32' },
      style: 'border-radius: 8px; object-fit: cover',
    });
  });

  it('keeps its CSS position when it sits in an AbsoluteFill that is a flex column of layers', () => {
    renderDom(
      <AbsoluteFill>
        <Rect width={300} height={200} fill="#fff" />
        <AbsoluteFill style={{ zIndex: 2 }}>
          <div style={{ position: 'absolute', top: 100, left: 50, width: 10, height: 10, backgroundColor: 'red' }} />
        </AbsoluteFill>
      </AbsoluteFill>,
    );
    // The fills hold DOM, so they are one island (docs/ENGINE.md §10): the outer `div`, the Rect a box inside it, and
    // the inner fill its absolutely positioned `div`: out of the column's flow, as in CSS.
    expect(sent).toHaveLength(1);
    const [rect, inner] = sent[0].root.children;
    expect(rect).toMatchObject({ kind: 'native', path: '$0.0', width: 300, height: 200 });
    expect(inner).toMatchObject({ tag: 'div', path: '$0.1', style: expect.stringContaining('position: absolute; inset: 0') });
    expect(inner.children[0]).toMatchObject({ tag: 'div', path: '$0.1.0' });
  });
});
