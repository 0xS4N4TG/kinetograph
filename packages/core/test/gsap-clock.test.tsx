// GSAP's root clock follows the virtual frame clock: a `gsap.to` that plays by itself (not on a paused timeline the
// project seeks) is where a render of every frame has it, in a frame rendered alone and after a jump. See ../src/gsap-clock.ts.
import { createRequire } from 'node:module';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layer, Rect } from '@kinetographdev/react';
import { motionSubFrames, type GroupLayer, type ShapeLayer } from '@kinetographdev/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { GSAP_REGISTRY, setGsapTime } from '../src/gsap-clock.js';
import { useCurrentFrame, useVideoConfig } from '../src/timeline.js';
import { resetWarnings } from '../src/warn.js';

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

/**
 * A tween on the root clock, blurred or not: `x` goes 0 to 300 over 0.51 s (15.3 frames) and `shown` is what its
 * `onUpdate` wrote; its `onComplete` makes a second tween of `y`, which a sample past the end must not start early.
 */
function Moving({ blur }: { blur: boolean }) {
  const o = useRef({ x: 0, shown: 0, y: 0 });
  useEffect(() => {
    const v = o.current;
    const a = gsap.to(v, {
      x: 300,
      duration: 0.51,
      ease: 'none',
      onUpdate: () => {
        v.shown = v.x;
      },
      onComplete: () => {
        gsap.to(v, { y: 100, duration: 1, ease: 'none' });
      },
    });
    return () => {
      a.kill();
      gsap.killTweensOf(v);
    };
  }, []);
  const box = <Rect id="box" width={10} height={10} fill="#fff" x={o.current.x} y={o.current.shown + o.current.y} />;
  return blur ? (
    <Layer id="blurred" motionBlur={{ samples: 4, shutter: 1 }}>
      {box}
    </Layer>
  ) : (
    <Layer id="blurred">{box}</Layer>
  );
}

const boxOf = (layers: unknown[]): ShapeLayer => ((layers[0] as GroupLayer).children[0] as ShapeLayer);

describe('motion blur of a tween on the root clock', () => {
  beforeEach(() => {
    registerRoot(() => (
      <>
        <Composition id="Blur" component={Moving} defaultProps={{ blur: true }} width={10} height={10} fps={30} durationInFrames={40} />
        <Composition id="Sharp" component={Moving} defaultProps={{ blur: false }} width={10} height={10} fps={30} durationInFrames={40} />
      </>
    ));
  });

  it('samples GSAP at each sub-frame time, with its onUpdate, and keeps the frame its own', async () => {
    const r = createFrameRenderer('Blur');
    const layer = (await r.renderFrame(10)).scene.layers[0] as GroupLayer;
    const samples = (motionSubFrames(layer) as GroupLayer[]).map((g) => g.children[0] as ShapeLayer);
    // t_i = 10 + ((i + 0.5) / 4 - 0.5) -> 9.625, 9.875, 10.125, 10.375; x = 300 * (t / 30) / 0.51
    const at = (t: number) => (300 * (t / 30)) / 0.51;
    expect(samples.map((l) => l.transform!.x as number).map((x) => x.toFixed(6))).toEqual([9.625, 9.875, 10.125, 10.375].map((t) => at(t).toFixed(6)));
    // `shown` is written by onUpdate, which runs in the samples too.
    expect(samples.map((l) => l.transform!.y as number).map((y) => y.toFixed(6))).toEqual([9.625, 9.875, 10.125, 10.375].map((t) => at(t).toFixed(6)));
    expect((boxOf([layer]).transform!.x as number)).toBeCloseTo(at(10), 3);
  });

  it('leaves the frames after a blurred one as they are without blur, past onComplete too', async () => {
    const run = async (id: string) => {
      const r = createFrameRenderer(id);
      const out: unknown[] = [];
      for (let f = 0; f < 40; f++) {
        const t = boxOf((await r.renderFrame(f)).scene.layers).transform!;
        out.push([t.x, t.y]);
      }
      r.dispose();
      return out;
    };
    const blurred = await run('Blur');
    const sharp = await run('Sharp');
    expect(blurred).toEqual(sharp);
    // The second tween, made by onComplete at frame 16 (the first frame past 15.3), moves y from there.
    expect((sharp[16] as number[])[1]).toBeCloseTo(300, 9);
    expect((sharp[31] as number[])[1]).toBeCloseTo(350, 3);
  });

  it('is the same alone as in sequence', async () => {
    const sequence = createFrameRenderer('Blur');
    const all: unknown[] = [];
    for (let f = 0; f < 40; f++) all.push((await sequence.renderFrame(f)).scene.layers);
    sequence.dispose();
    for (const f of [9, 15, 16, 30]) {
      const alone = createFrameRenderer('Blur');
      expect((await alone.renderFrame(f)).scene.layers, `frame ${f}`).toEqual(all[f]);
      alone.dispose();
    }
  });
});

describe('the warning about the root clock', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const said = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("GSAP's root clock"));

  it('is given once for tweens that play by themselves', async () => {
    registerRoot(() => <Composition id="B" component={Boxes} width={10} height={10} fps={30} durationInFrames={60} />);
    const r = createFrameRenderer('B');
    for (const f of [0, 1, 30, 31]) await r.renderFrame(f);
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain('paused timeline');
  });

  it('is not given for a paused timeline seeked to the frame', async () => {
    function Seeked() {
      const frame = useCurrentFrame();
      const { fps } = useVideoConfig();
      const o = useRef({ x: 0 });
      const tl = useRef<ReturnType<typeof gsap.timeline> | null>(null);
      useLayoutEffect(() => {
        const t = gsap.timeline({ paused: true }).to(o.current, { x: 100, duration: 1 });
        tl.current = t;
        return () => {
          t.kill();
        };
      }, []);
      useLayoutEffect(() => {
        tl.current?.seek(frame / fps, false);
      }, [frame, fps]);
      return <Rect id="s" width={10} height={10} fill="#fff" x={o.current.x} />;
    }
    registerRoot(() => <Composition id="S" component={Seeked} width={10} height={10} fps={30} durationInFrames={60} />);
    const r = createFrameRenderer('S');
    for (const f of [0, 1, 30]) await r.renderFrame(f);
    expect(said()).toEqual([]);
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
