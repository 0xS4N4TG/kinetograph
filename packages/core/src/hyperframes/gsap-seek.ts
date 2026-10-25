// How HyperFrames seeks a GSAP timeline while it renders (Apache-2.0, heygen-com/hyperframes: packages/core/src/runtime/
// adapters/gsap.ts, and runtime/init.ts: seekRootChildrenAndAdapters). A frame is a timeline's state at one instant, and
// GSAP's own `totalTime(t)` does not always give it:
//
//   - A timeline that has never rendered and is seeked to 0 renders nothing (it is "already there"), so the `set()`s and
//     `from()`s at time 0 never apply and the page shows its CSS, not its first frame.
//   - Steps that fall on the same instant (a `set()` that undoes another at `t`) apply in the order the timeline holds
//     them, which is not authored order when the playhead lands on `t` from far away.
//   - A tween that starts inside the step the seek jumps over is not primed with its `from` values.
//
// The remedy is the one HyperFrames uses: after the seek, render the timeline again from just below `t` (just above at
// 0) with events suppressed, prime the tweens that start at `t`, and land on `t`; the bookkeeping GSAP keeps on those
// steps (`ratio`, `_zTime`, `_act`) and the length of the timelines above skipped children are put back as they were.
// It reaches into GSAP's private fields, as the original does. This is the render path's form (no cached structure).

type AnyRecord = Record<string, any>;

const PLAYHEAD_FLOAT_NOISE = 1e-6;
const BELOW_GSAP_TIME_RESOLUTION = 2e-8;
const REDRAW_STEP = 0.001;
const CALLBACKS = ['onStart', 'onUpdate', 'onComplete', 'onReverseComplete', 'onRepeat'];

type Timeline = AnyRecord & {
  totalTime: (time?: number, suppressEvents?: boolean) => unknown;
  totalDuration?: () => number;
  getChildren?: (nested: boolean, tweens: boolean, timelines: boolean) => unknown[];
};

const childrenOf = (timeline: Timeline): AnyRecord[] => (timeline.getChildren?.(false, true, true) as AnyRecord[] | undefined) ?? [];

/** Children whose landing the redraw must put back: the nested timelines and the zero-length tweens. */
function marksIn(timeline: Timeline): AnyRecord[] {
  return ((timeline.getChildren?.(true, true, true) as AnyRecord[] | undefined) ?? []).filter(
    (child) => typeof child.getChildren === 'function' || child.totalDuration?.() === 0,
  );
}

function childrenStartingAfter(children: AnyRecord[], time: number, found: AnyRecord[] = []): AnyRecord[] {
  for (const child of children) {
    if (child.startTime() > time + PLAYHEAD_FLOAT_NOISE) found.push(child);
    else if (child.getChildren && child.endTime() >= time) childrenStartingAfter(child.getChildren(false, true, true), child.time(), found);
  }
  return found;
}

function primedAtItsStart(tween: AnyRecord): boolean {
  if (tween.vars?.keyframes) {
    tween.render(BELOW_GSAP_TIME_RESOLUTION, true);
    tween.render(-BELOW_GSAP_TIME_RESOLUTION, true);
  }
  if (tween._startAt) tween._startAt.render(BELOW_GSAP_TIME_RESOLUTION, true, true);
  return Boolean(tween.vars?.keyframes || tween._startAt);
}

const playsForward = (value: AnyRecord): boolean =>
  typeof value?.render === 'function' &&
  typeof value.startTime === 'function' &&
  typeof value.paused === 'function' &&
  typeof value.timeScale === 'function' &&
  value.timeScale() > 0 &&
  !value.paused();

function primeStartedTween(child: AnyRecord, local: number, stepBelow: number): void {
  if (local < stepBelow && child._startAt) child._startAt.render(BELOW_GSAP_TIME_RESOLUTION, true, true);
  const nested = child.getChildren ? child : child.timeline;
  if (nested?.getChildren && local <= child.totalDuration()) primeTweensStartingAt(nested.getChildren(false, true, true), local, stepBelow);
}

function primeTweensStartingAt(children: AnyRecord[], time: number, stepBelowInTheirTime: number): void {
  for (const child of children.filter(playsForward)) {
    const local = (time - child.startTime()) * child.timeScale();
    if (Math.abs(local) < 1e-9 && primedAtItsStart(child)) continue;
    if (local > 0) primeStartedTween(child, local, stepBelowInTheirTime * child.timeScale());
  }
}

/** Renders a timeline that is already at `t` again, silently, so that the steps at `t` apply in order (adapters/gsap.ts: rerenderGsapTimelineAt). */
export function rerenderAt(timeline: Timeline, t: number): void {
  timeline.totalDuration?.();
  const children = childrenOf(timeline);
  const marked = marksIn(timeline).map((child) => [child, child.ratio, child._zTime, child._act] as const);
  const skipped = childrenStartingAfter(children, t).map((child) => [child, child._ts] as const);
  const parents = new Set<AnyRecord>();
  for (const [child] of skipped) {
    for (let parent = child.parent; parent && !parents.has(parent); parent = parent.parent) parents.add(parent);
  }
  const lengths = [...parents].map((parent) => [parent, parent._dur, parent._tDur, parent._end, parent._dirty] as const);
  for (const [child] of skipped) child._ts = 0;
  try {
    const below = t >= REDRAW_STEP;
    timeline.totalTime(below ? t - REDRAW_STEP : t + REDRAW_STEP, true);
    primeTweensStartingAt(children, t, below ? REDRAW_STEP : 0);
    timeline.totalTime(t, true);
  } finally {
    for (const [child, timeScale] of skipped) child._ts = timeScale;
    for (const [parent, dur, tDur, end, dirty] of lengths) Object.assign(parent, { _dur: dur, _tDur: tDur, _end: end, _dirty: dirty });
  }
  for (const [child, ratio, zTime, active] of marked) {
    child.ratio = ratio;
    child._zTime = zTime;
    child._act = active;
  }
}

/** True while no child of the timeline has been initialised: it has never rendered (adapters/gsap.ts: gsapNeverRendered). */
function neverRendered(timeline: AnyRecord): boolean {
  const first = '_first' in timeline ? (timeline._first ? timeline._first : null) : ((timeline.getChildren?.(false, true, true) ?? [])[0] ?? null);
  const rendered = first?.parent as AnyRecord | undefined;
  return rendered !== undefined && !rendered._initted;
}

/** Seeks to `t`; true when it had to render a timeline that was already at `t` (adapters/gsap.ts: seekGsapTimeline). */
export function seekTimelineTo(timeline: Timeline, t: number, suppressEvents: boolean): boolean {
  if (typeof timeline.totalTime !== 'function') {
    (timeline as AnyRecord).seek(t, suppressEvents);
    return false;
  }
  const from = Number(timeline.totalTime());
  timeline.totalTime(t, suppressEvents);
  if (from !== t || !neverRendered(timeline)) return false;
  rerenderAt(timeline, t);
  return true;
}

/** Whether a tween of zero length has a callback: it must not run twice, so the root is not rendered again (init.ts: findZeroDurationCallbackTween). */
export function hasZeroDurationCallbackTween(timeline: Timeline): boolean {
  if (typeof timeline.getChildren !== 'function') return false;
  let children: unknown;
  try {
    children = timeline.getChildren(true, true, true);
  } catch {
    return false;
  }
  if (!Array.isArray(children)) return false;
  for (const child of children as AnyRecord[]) {
    if (typeof child !== 'object' || child === null || typeof child.vars !== 'object' || child.vars === null) continue;
    if (!CALLBACKS.some((name) => typeof child.vars[name] === 'function')) continue;
    for (const getter of ['totalDuration', 'duration']) {
      if (typeof child[getter] !== 'function') continue;
      let value = NaN;
      try {
        value = Number(child[getter]());
      } catch {
        // an unreadable length is no length
      }
      if (Number.isFinite(value)) {
        if (value <= 0.000001) return true;
        break;
      }
    }
  }
  return false;
}
