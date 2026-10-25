// GSAP's root clock, driven from the virtual frame clock (packages/site/content/docs/compat.mdx, "GSAP").
//
// A tween made with `gsap.to(...)` outside a paused timeline plays by itself: GSAP's ticker moves its global timeline on
// every animation frame by the time that passed. A render has no such time, so the clock is taken over with GSAP's
// documented API and nothing of GSAP is patched:
//
//   - `gsap.ticker.remove(gsap.updateRoot)` takes the root timeline off the ticker (the ticker still serves the
//     listeners a project adds itself),
//   - `gsap.ticker.lagSmoothing(0)` turns off the lag adjustment, which would otherwise swallow a jump in time,
//   - `gsap.updateRoot(seconds)` moves the root timeline to the frame's time, once per frame. A jump to a later frame
//     renders the frames it skips (without reading them, see the frame loop) with the clock on each, since an effect
//     that runs at frame 30 makes its tween there, and only a render of that frame runs the effect.
//
// The clock finds GSAP where the page's own copy is: `window.gsap`, which GSAP's browser build (a CDN script, a
// HyperFrames page) sets, or `GSAP_REGISTRY`, which the CLI's bundler sets when the project imports `gsap` (GSAP's ES
// module does not set `window.gsap`; see `gsapPlugin` in packages/cli/src/bundle.ts). It does nothing for a project that
// does not use GSAP. A paused timeline that the project seeks itself is not on the root's clock and is not touched.

/** Where a bundled `import 'gsap'` leaves the instance it imported. */
export const GSAP_REGISTRY = Symbol.for('kinetograph.gsap');

function candidate(): unknown {
  const g = globalThis as { gsap?: unknown; [GSAP_REGISTRY]?: unknown };
  return g.gsap ?? g[GSAP_REGISTRY];
}

interface Gsap {
  updateRoot(time: number): void;
  ticker: { remove(callback: unknown): void; lagSmoothing(threshold: number, adjustedLag?: number): void };
  globalTimeline: { getChildren(nested: boolean, tweens: boolean, timelines: boolean): unknown[] };
}

/** The instances taken over, so each is set up once. */
const adopted = new WeakSet<object>();

function gsapOf(candidate: unknown): Gsap | null {
  const g = candidate as Partial<Gsap> | undefined;
  if (g === undefined || g === null || typeof g.updateRoot !== 'function' || g.ticker === undefined || g.globalTimeline === undefined) return null;
  return g as Gsap;
}

function loaded(): Gsap | null {
  const g = gsapOf(candidate());
  if (g === null) return null;
  if (!adopted.has(g)) {
    adopted.add(g);
    g.ticker.remove(g.updateRoot);
    g.ticker.lagSmoothing(0);
  }
  return g;
}

/** Moves GSAP's root timeline to `seconds` (the virtual clock); nothing when GSAP is not loaded. */
export function setGsapTime(seconds: number): void {
  loaded()?.updateRoot(seconds);
}

/** True once the page has loaded GSAP. */
export function gsapIsLoaded(): boolean {
  return gsapOf(candidate()) !== null;
}
