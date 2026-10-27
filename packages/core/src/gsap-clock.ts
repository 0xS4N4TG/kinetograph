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

import { warnOnce } from './warn.js';

/** Where a bundled `import 'gsap'` leaves the instance it imported. */
export const GSAP_REGISTRY = Symbol.for('kinetograph.gsap');

function candidate(): unknown {
  const g = globalThis as { gsap?: unknown; [GSAP_REGISTRY]?: unknown };
  return g.gsap ?? g[GSAP_REGISTRY];
}

/** The part of a GSAP animation (a tween or a timeline) the motion-blur samples use; all of it is documented API. */
interface Animation {
  startTime(): number;
  timeScale(): number;
  paused(): boolean;
  totalTime(): number;
  totalProgress(): number;
  render(totalTime: number, suppressEvents?: boolean, force?: boolean): unknown;
  eventCallback(type: 'onUpdate'): ((...args: unknown[]) => void) | undefined | null;
  vars: { onUpdateParams?: unknown[]; callbackScope?: object };
  getChildren?(nested: boolean, tweens: boolean, timelines: boolean): Animation[];
}

interface Gsap {
  updateRoot(time: number): void;
  ticker: { remove(callback: unknown): void; lagSmoothing(threshold: number, adjustedLag?: number): void };
  globalTimeline: { autoRemoveChildren: boolean; getChildren(nested: boolean, tweens: boolean, timelines: boolean): Animation[] };
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

/** The root's time, and the root's children before it last moved there (a tween that ended on the way is let go). */
let rootTime = 0;
let before: Animation[] = [];

/** Moves GSAP's root timeline to `seconds` (the virtual clock); nothing when GSAP is not loaded. */
export function setGsapTime(seconds: number): void {
  const g = loaded();
  if (g === null) return;
  if (seconds !== rootTime) before = g.globalTimeline.getChildren(false, true, true);
  rootTime = seconds;
  g.updateRoot(seconds);
  warnAboutRootClock(g);
}

/**
 * Says once when something plays on GSAP's root clock (a `gsap.to` or `delayedCall` that is not on a paused timeline the
 * project seeks). It renders here the same alone and in sequence, but not in the renderers the project may also go
 * to: Remotion's moves it by the wall clock as frames are captured, HyperFrames' seeks only the timelines registered
 * on `window.__timelines`, so there it depends on how each worker got to its frames.
 */
function warnAboutRootClock(g: Gsap): void {
  const playing = g.globalTimeline.getChildren(false, true, true).filter((a) => !a.paused() && a.timeScale() !== 0);
  if (playing.length === 0) return;
  warnOnce(
    'gsap-root-clock',
    `GSAP: ${playing.length === 1 ? 'a tween plays' : `${playing.length} tweens play`} on GSAP's root clock, not on a paused timeline ` +
      'seeked to the frame. Kinetograph moves that clock with the frame, so a frame renders the same alone and in sequence, ' +
      'but a Remotion render moves it by the wall clock and a HyperFrames render does not move it at all: put the tween on ' +
      'a paused timeline seeked to frame / fps (or registered on window.__timelines) to render the same there.',
  );
}

/** The animations a motion-blur sample moved, with the total time each had at the frame (restored by `endGsapSamples`). */
let samples: Map<Animation, number> | null = null;

/** Each animation in `list` and every animation nested in it, with the `onUpdate` it has. */
function withNested(list: Iterable<Animation>): Animation[] {
  const out: Animation[] = [];
  for (const a of list) {
    out.push(a);
    if (typeof a.getChildren === 'function') out.push(...a.getChildren(true, true, true));
  }
  return out;
}

/** Calls the `onUpdate` of each animation in `list` whose total time is not the one in `was`, as GSAP calls it. */
function updated(list: Animation[], was: Map<Animation, number>): void {
  for (const a of list) {
    if (a.totalTime() === was.get(a)) continue;
    const callback = a.eventCallback('onUpdate');
    if (typeof callback === 'function') callback.apply(a.vars.callbackScope ?? a, a.vars.onUpdateParams ?? []);
  }
}

/**
 * Shows GSAP at `seconds`, a motion-blur sub-frame of the frame the root is at, without moving the root: each animation
 * that plays on the root clock (not paused, and started by the frame) is rendered at its own time for `seconds`, as a
 * seekable animation would be at the sub-frame. Its `onUpdate` callbacks run; `onStart`, `onComplete`, `onRepeat` and
 * the timeline's own calls do not, since what they do (make a tween, change state) would outlive the sample and make the
 * frames after it depend on whether this one was blurred. A paused timeline the project seeks is left to the project.
 * `endGsapSamples` puts everything back where the frame has it. Nothing when GSAP is not loaded.
 */
export function sampleGsapAt(seconds: number): void {
  const g = loaded();
  if (g === null) return;
  if (samples === null) {
    samples = new Map();
    // The root's children, and those that finished on the way to the frame (a sample before it still shows them
    // moving); one that was stopped (killed) is left alone.
    const now = g.globalTimeline.getChildren(false, true, true);
    for (const a of new Set([...before.filter((a) => a.totalProgress() === 1), ...now])) {
      // An animation that has not started by the frame is not initialised yet; starting it in a sample would read its
      // start values at the sub-frame instead of when the frames reach it.
      if (a.paused() || a.timeScale() === 0 || a.startTime() > rootTime) continue;
      samples.set(a, a.totalTime());
    }
  }
  const nested = withNested(samples.keys());
  const was = new Map(nested.map((a) => [a, a.totalTime()]));
  renderKept(g, () => {
    for (const a of samples!.keys()) a.render(Math.max(0, (seconds - a.startTime()) * a.timeScale()), true, true);
  });
  updated(nested, was);
}

/** Runs `render` with the root keeping the children that reach their end (a sample past a tween's end must not take it
 *  off the root, which the frames after it still move). */
function renderKept(g: Gsap, render: () => void): void {
  const remove = g.globalTimeline.autoRemoveChildren;
  g.globalTimeline.autoRemoveChildren = false;
  try {
    render();
  } finally {
    g.globalTimeline.autoRemoveChildren = remove;
  }
}

/** Puts the animations the samples moved back at the frame's time, with their `onUpdate` callbacks. */
export function endGsapSamples(): void {
  if (samples === null) return;
  const g = loaded();
  const nested = withNested(samples.keys());
  const was = new Map(nested.map((a) => [a, a.totalTime()]));
  const back = samples;
  const restore = () => {
    for (const [a, time] of back) a.render(time, true, true);
  };
  if (g === null) restore();
  else renderKept(g, restore);
  updated(nested, was);
  samples = null;
}

/** True once the page has loaded GSAP. */
export function gsapIsLoaded(): boolean {
  return gsapOf(candidate()) !== null;
}
