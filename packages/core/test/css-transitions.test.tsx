// CSS transitions end to end (packages/cli/skills/kinetograph/references/ENGINE.md §7.12): a composition whose DOM sets `opacity` by the frame and
// declares a transition is rendered through the real addon. A frame's history comes from the frames before it, so
// rendering a frame alone, in order, or out of order gives the same value, and the value is mid-transition.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { setDomAddon } from '@kinetograph/compat/dom';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { useCurrentFrame } from '../src/timeline.js';

let addon: any = null;
try {
  addon = createRequire(import.meta.url)('@kinetograph/native');
} catch {
  addon = null;
}
const real = addon?.renderDomIsland ? it : it.skip;

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  installDeterminism();
  if (addon) setDomAddon(addon);
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
  setDomAddon(null);
});

// Hidden until frame 30 (1 s at 30 fps), shown from then on; the fade takes a second.
function Fade() {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 40,
        height: 40,
        background: '#f00',
        opacity: frame >= 30 ? 1 : 0,
        transition: 'opacity 1s linear',
      }}
    />
  );
}

function register() {
  registerRoot(() => <Composition id="Fade" component={Fade} width={100} height={100} fps={30} durationInFrames={90} />);
}

/** The opacity of the box in a frame's scene (the layers the island made). */
function opacityOf(layers: any[]): number {
  let found: number | null = null;
  const visit = (list: any[]) => {
    for (const layer of list) {
      if (layer.opacity !== undefined && found === null) found = layer.opacity;
      if (layer.children) visit(layer.children);
    }
  };
  visit(layers);
  return found ?? 1;
}

describe('CSS transitions', () => {
  real('are mid-transition in the frames after the change, whichever way the frames are reached', async () => {
    register();
    const want = new Map([
      [30, 0],
      [37.5, 0.25],
      [45, 0.5],
      [60, 1],
    ]);
    const frames = [30, 45, 60];
    const inOrder = createFrameRenderer('Fade');
    await inOrder.ready();
    const seq = new Map<number, number>();
    for (let f = 25; f <= 60; f++) {
      const { scene } = await inOrder.renderFrame(f);
      if (frames.includes(f)) seq.set(f, opacityOf(scene.layers));
    }
    inOrder.dispose();
    for (const f of frames) expect(seq.get(f)).toBeCloseTo(want.get(f)!, 5);

    // Each frame alone, and backwards, with a renderer of its own: the same values.
    for (const f of [60, 45, 30]) {
      resetVirtualClock();
      const alone = createFrameRenderer('Fade');
      await alone.ready();
      const { scene } = await alone.renderFrame(f);
      expect(opacityOf(scene.layers)).toBeCloseTo(want.get(f)!, 5);
      alone.dispose();
    }
    // One renderer asked out of order.
    resetVirtualClock();
    const jumpy = createFrameRenderer('Fade');
    await jumpy.ready();
    for (const f of [45, 31, 60, 45]) {
      const { scene } = await jumpy.renderFrame(f);
      expect(opacityOf(scene.layers)).toBeCloseTo(f === 31 ? 1 / 30 : f === 45 ? 0.5 : 1, 2);
    }
    jumpy.dispose();
  });
});
