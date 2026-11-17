// A source that says how its skipped frames are played (`setFrameReplay`) has the frames a jump skips played through
// that, in order, and the composition is not rendered for them. Without one the frames are rendered, as before.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect } from '@kinetographdev/react';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism, virtualNow } from '../src/determinism.js';
import { setFrameReplay } from '../src/frame-replay.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { GSAP_REGISTRY } from '../src/gsap-clock.js';
import { useCurrentFrame } from '../src/timeline.js';

const loaded = createRequire(import.meta.url)('gsap') as { gsap?: typeof import('gsap').gsap; default?: typeof import('gsap').gsap };
const gsap = (loaded.gsap ?? loaded.default ?? loaded) as typeof import('gsap').gsap;
const registry = globalThis as { [GSAP_REGISTRY]?: unknown };

const rendered: number[] = [];
function Counted() {
  rendered.push(useCurrentFrame());
  return <Rect id="a" width={10} height={10} fill="#fff" />;
}

beforeEach(() => {
  rendered.length = 0;
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  installDeterminism();
  // What the CLI's bundler does for `import 'gsap'`: only a page with GSAP has the frames a jump skips played.
  registry[GSAP_REGISTRY] = gsap;
  registerRoot(() => <Composition id="C" component={Counted} width={10} height={10} fps={30} durationInFrames={60} />);
});
afterEach(() => {
  setFrameReplay(null);
  delete registry[GSAP_REGISTRY];
  gsap.globalTimeline.clear();
  uninstallDeterminism();
  resetRenderState();
});

describe('the frames a jump skips', () => {
  it('are rendered when the source has no way to play them', async () => {
    const r = createFrameRenderer('C');
    await r.renderFrame(0);
    rendered.length = 0;
    await r.renderFrame(6);
    expect(rendered).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('are played through the source, in order, on the virtual clock of each, and the composition is rendered for the frame drawn only', async () => {
    const played: [number, number, number, number][] = [];
    setFrameReplay((frame, fps, total) => played.push([frame, fps, total, Math.round(virtualNow())]));
    const r = createFrameRenderer('C');
    await r.renderFrame(0);
    rendered.length = 0;
    const { scene } = await r.renderFrame(6);
    expect(played).toEqual([1, 2, 3, 4, 5].map((f) => [f, 30, 60, Math.round((f / 30) * 1000)]));
    expect(rendered).toEqual([6]);
    expect(scene.layers).toHaveLength(1);
    // The next frame is the next one: nothing is played through.
    played.length = 0;
    await r.renderFrame(7);
    expect(played).toEqual([]);
  });
});
