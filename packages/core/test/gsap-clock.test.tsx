// GSAP's root clock follows the virtual frame clock: a `gsap.to` that plays by itself (not on a paused timeline the
// project seeks) is where a render of every frame has it, in a frame rendered alone and after a jump. See ../src/gsap-clock.ts.
import { createRequire } from 'node:module';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect } from '@kinetographdev/react';
import type { ShapeLayer } from '@kinetographdev/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { GSAP_REGISTRY, setGsapTime } from '../src/gsap-clock.js';
import { useCurrentFrame } from '../src/timeline.js';

const loaded = createRequire(import.meta.url)('gsap') as { gsap?: typeof import('gsap').gsap; default?: typeof import('gsap').gsap };
const gsap = (loaded.gsap ?? loaded.default ?? loaded) as typeof import('gsap').gsap;
const registry = globalThis as { [GSAP_REGISTRY]?: unknown };

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  installDeterminism();
  // What the CLI's bundler does for `import 'gsap'`.
  registry[GSAP_REGISTRY] = gsap;
});
afterEach(() => {
  delete registry[GSAP_REGISTRY];
  gsap.globalTimeline.clear();
  uninstallDeterminism();
  resetRenderState();
});

describe('setGsapTime', () => {
  it('moves the root timeline, and takes it off the ticker once', () => {
    const o = { v: 0 };
    setGsapTime(0);
    gsap.to(o, { v: 100, duration: 1, ease: 'none' });
    setGsapTime(0.25);
    expect(o.v).toBeCloseTo(25, 9);
    expect((gsap.ticker as unknown as { _listeners: unknown[] })._listeners).not.toContain(gsap.updateRoot);
    setGsapTime(0.75);
    expect(o.v).toBeCloseTo(75, 9);
    setGsapTime(5);
    expect(o.v).toBe(100);
  });

  it('does nothing without GSAP', () => {
    delete registry[GSAP_REGISTRY];
    expect(() => setGsapTime(1)).not.toThrow();
  });
});

/** Two boxes: one tweened from the mount, one from an effect that runs at frame 30. Each tween is stopped when the scene goes. */
function Boxes() {
  const frame = useCurrentFrame();
  const a = useRef({ x: 0 });
  const b = useRef({ x: 0 });
  useEffect(() => {
    const tween = gsap.to(a.current, { x: 600, duration: 1, ease: 'power2.out' });
    return () => {
      tween.kill();
    };
  }, []);
  const late = frame >= 30;
  useEffect(() => {
    if (!late) return;
    const tween = gsap.to(b.current, { x: 500, duration: 1, ease: 'none' });
    return () => {
      tween.kill();
    };
  }, [late]);
  return (
    <>
      <Rect id="a" width={10} height={10} fill="#fff" x={a.current.x} />
      <Rect id="b" width={10} height={10} fill="#fff" x={b.current.x} />
    </>
  );
}

const at = async (renderer: ReturnType<typeof createFrameRenderer>, frame: number): Promise<[number, number]> => {
  const layers = (await renderer.renderFrame(frame)).scene.layers as ShapeLayer[];
  const x = (id: string) => (layers.find((l) => l.id === id)?.transform?.x ?? 0) as number;
  return [x('a'), x('b')];
};

describe('a tween that plays by itself', () => {
  beforeEach(() => {
    registerRoot(() => <Composition id="B" component={Boxes} width={10} height={10} fps={30} durationInFrames={60} />);
  });

  it('moves with the frames, from the frame its effect ran at', async () => {
    const r = createFrameRenderer('B');
    const [a0, b0] = await at(r, 0);
    expect([a0, b0]).toEqual([0, 0]);
    expect((await at(r, 15))[0]).toBeCloseTo(600 * (1 - 0.5 ** 3), 3); // power2.out is a cubic: 1 - (1 - 0.5)^3
    await at(r, 29);
    // The effect ran when the frame-30 render did, so the tween starts at 1 s: half way at frame 45.
    expect((await at(r, 30))[1]).toBe(0);
    expect((await at(r, 45))[1]).toBeCloseTo(250, 3);
    expect((await at(r, 59))[1]).toBeCloseTo(500 * (29 / 30), 3);
  });

  it('is the same alone as in a sequence, whatever frame the scene starts at', async () => {
    const sequence = createFrameRenderer('B');
    const inSequence: Array<[number, number]> = [];
    for (let f = 0; f < 60; f++) inSequence.push(await at(sequence, f));
    sequence.dispose();
    for (const f of [1, 29, 30, 31, 45, 59]) {
      const alone = createFrameRenderer('B');
      expect(await at(alone, f), `frame ${f}`).toEqual(inSequence[f]);
      alone.dispose();
    }
  });

  it('is the same after a jump forward within one scene, and after going back', async () => {
    const sequence = createFrameRenderer('B');
    const inSequence: Array<[number, number]> = [];
    for (let f = 0; f < 60; f++) inSequence.push(await at(sequence, f));
    sequence.dispose();
    const r = createFrameRenderer('B');
    expect(await at(r, 10)).toEqual(inSequence[10]);
    expect(await at(r, 50)).toEqual(inSequence[50]);
    // Going back starts the scene over; its tweens were stopped by their cleanups, so the clock restarts with it.
    expect(await at(r, 20)).toEqual(inSequence[20]);
    expect(await at(r, 31)).toEqual(inSequence[31]);
  });
});

describe('a project without GSAP', () => {
  it('renders as it did', async () => {
    delete registry[GSAP_REGISTRY];
    function Plain() {
      const frame = useCurrentFrame();
      return <Rect id="p" width={10} height={10} fill="#fff" x={frame} />;
    }
    registerRoot(() => <Composition id="P" component={Plain} width={10} height={10} fps={30} durationInFrames={60} />);
    const r = createFrameRenderer('P');
    expect((await r.renderFrame(40)).scene.layers[0]?.transform?.x).toBe(40);
  });
});
