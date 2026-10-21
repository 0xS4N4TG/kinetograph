// The motion-blur sub-frames of the frame loop (docs/AUTHORING.md §7.3): one pass of island renders per frame, only
// the blurred layers read out of a sub-frame's tree, and the scene's `changes` saying what a whole render at the
// sub-frame time would have drawn.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { createSceneRoot, Layer, Rect, TimelineContext } from '@kinetograph/react';
import { motionSubFrames, motionTimes, type LayerJson } from '@kinetograph/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { resetVirtualClock, setVirtualFrame } from '../src/determinism.js';
import { clearFonts } from '../src/font-registry.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { interpolate } from '../src/interpolate.js';
import { useCurrentFrame } from '../src/timeline.js';
import { timeline } from './scene-harness.js';

/** Each island render: its path and pass. */
let calls: { path: string; pass: number | undefined }[] = [];

/**
 * A stand-in addon whose layers are a function of the request: a shape per element carrying its style, and a
 * placeholder where a native element goes, so what a sub-frame draws follows what it asks for.
 */
function drawn(node: any): unknown[] {
  if (node.kind === 'native') return [{ type: 'native', path: node.path, x: 3, y: 4, width: 0, height: 0 }];
  if (node.kind !== 'element') return [];
  return [
    { id: `${node.path}.box`, type: 'shape', shape: { kind: 'path', d: `M0 0 ${node.style ?? ''}` }, fill: '#fff' },
    ...node.children.flatMap(drawn),
  ];
}

function renderDomIsland(json: string, pass?: number): string {
  const request = JSON.parse(json);
  calls.push({ path: request.path, pass });
  return JSON.stringify({ layers: drawn(request.root), unsupported: [], camera: null });
}

/** An addon that also queues renders: each is drawn when started, and handed out when finished, in order. */
function queuing() {
  const outputs = new Map<number, string>();
  let next = 0;
  const finished: number[] = [];
  setDomAddon({
    renderDomIsland,
    startDomIsland(json: string, pass?: number) {
      outputs.set(++next, renderDomIsland(json, pass));
      return next;
    },
    finishDomIsland(ticket: number) {
      finished.push(ticket);
      const out = outputs.get(ticket)!;
      outputs.delete(ticket);
      return out;
    },
  });
  return { finished, outputs };
}

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  clearFonts();
  resetVirtualClock();
  calls = [];
  setDomAddon({ renderDomIsland });
});
afterEach(() => {
  setDomAddon(null);
  resetRenderState();
});

/** A DOM page around a blurred layer: a title that fades, a still caption, and the wall that moves inside the layer. */
function Page() {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 20], [0, 200]);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ opacity: interpolate(frame, [0, 20], [0, 1]) }}>title</div>
      <Layer id="wall" motionBlur={{ samples: 4, shutter: 1 }} opacity={interpolate(frame, [0, 20], [0.5, 1])}>
        <div style={{ position: 'absolute', transform: `translateX(${x}px)` }}>
          <div style={{ width: 10 }}>still</div>
          <div style={{ width: frame > 10 ? 20 : 10 }}>grows</div>
        </div>
        <Rect id="dot" width={4} height={4} fill="#f00" x={x} />
      </Layer>
      <Rect id="outside" width={4} height={4} fill="#0f0" x={x} />
    </div>
  );
}

function compose() {
  registerRoot(() => <Composition id="P" component={Page} width={400} height={300} fps={30} durationInFrames={30} />);
  return createFrameRenderer('P');
}

/** The blurred layer as a whole render of the page at `time` draws it. */
function wholeAt(time: number): LayerJson {
  setVirtualFrame(time, 30, { fireTimers: false });
  const root = createSceneRoot({ viewport: { width: 400, height: 300 }, time: () => time / 30 });
  try {
    const tree = root.render(
      <TimelineContext.Provider value={{ ...timeline(time), durationInFrames: 30 }}>
        <Page />
      </TimelineContext.Provider>,
    );
    const find = (list: LayerJson[]): LayerJson | undefined => {
      for (const layer of list) {
        if (layer.id === 'wall') return layer;
        const inner = layer.type === 'group' ? find(layer.children) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    return find(tree.layers)!;
  } finally {
    root.unmount();
  }
}

const unblurred = (layer: LayerJson): LayerJson => {
  const { motionBlur: _dropped, ...rest } = layer;
  return rest.type === 'group' ? { ...rest, children: rest.children.map(unblurred) } : rest;
};

describe('motion-blur sub-frames', () => {
  it('draw what a whole render at each sub-frame time draws', async () => {
    const renderer = compose();
    for (const frame of [5, 6, 10, 11]) {
      const { scene } = await renderer.renderFrame(frame);
      const wall = (scene.layers as LayerJson[]).find((l) => l.id === 'wall')!;
      expect(wall.motionBlur?.changes).toHaveLength(4);
      const subs = motionSubFrames(wall)!;
      motionTimes(frame, 4, 1).forEach((time, i) => {
        expect(unblurred(subs[i]!)).toEqual(unblurred(wholeAt(time)));
      });
      // The scene says what changes, not a copy of the layer per sub-frame.
      expect(wall.motionBlur?.frames).toBeUndefined();
    }
  });

  it('draw the same when their islands are queued, finished in the order they were started', async () => {
    const renderer = compose();
    const plain = [];
    for (const frame of [5, 10]) plain.push((await renderer.renderFrame(frame)).scene);
    resetVirtualClock();
    const { finished, outputs } = queuing();
    const again = compose();
    for (const [i, frame] of [5, 10].entries()) {
      expect((await again.renderFrame(frame)).scene).toEqual(plain[i]);
    }
    expect(finished.length).toBeGreaterThan(0);
    expect(finished).toEqual([...finished].sort((a, b) => a - b));
    // Nothing is left in the addon.
    expect(outputs.size).toBe(0);
  });

  it('are one pass of island renders with the frame itself, a new one for each frame', async () => {
    const renderer = compose();
    await renderer.renderFrame(5);
    // A fresh start renders frame 0 first, outside the pass; then the frame and its sub-frames.
    const priming = calls.findIndex((c) => c.pass !== undefined);
    expect(priming).toBeGreaterThan(0);
    const first = new Set(calls.slice(priming).map((c) => c.pass));
    expect(first.size).toBe(1);
    expect([...first][0]).toBeTypeOf('number');
    calls = [];
    await renderer.renderFrame(6);
    const second = new Set(calls.map((c) => c.pass));
    expect(second.size).toBe(1);
    expect([...second][0]).not.toBe([...first][0]);
  });

  it('render only the islands that can hold a blurred layer', async () => {
    const renderer = compose();
    await renderer.renderFrame(4);
    calls = [];
    await renderer.renderFrame(5);
    const count = (path: string) => calls.filter((c) => c.path === path).length;
    // The page holds the layer, so it is laid out at each sub-frame too (it places the layer); the wall's island is
    // inside the layer. One render for the frame, four for its sub-frames.
    const page = calls[calls.length - 1]!.path;
    expect(count('$0')).toBe(5);
    expect(calls.filter((c) => c.path !== '$0')).toHaveLength(5);
    expect(page).not.toBe('$0');
  });

  it('leaves out a DOM island beside the blurred layers at a sub-frame', async () => {
    function Beside() {
      const frame = useCurrentFrame();
      return (
        <>
          <div style={{ opacity: frame / 30 }}>caption</div>
          <Layer id="moving" x={frame * 10} motionBlur={{ samples: 3, shutter: 1 }}>
            <Rect id="r" width={4} height={4} fill="#fff" />
          </Layer>
        </>
      );
    }
    registerRoot(() => <Composition id="B" component={Beside} width={100} height={100} fps={30} durationInFrames={30} />);
    const renderer = createFrameRenderer('B');
    await renderer.renderFrame(3);
    calls = [];
    const { scene } = await renderer.renderFrame(4);
    // The caption is drawn once, for the frame itself.
    expect(calls.map((c) => c.path)).toEqual(['$0']);
    const moving = (scene.layers as LayerJson[]).find((l) => l.id === 'moving')!;
    expect(motionSubFrames(moving)!.map((l) => l.transform?.x)).toEqual(motionTimes(4, 3, 1).map((t) => t * 10));
  });
});
