// The Web Animations API (Web Animations Level 1, with `linear()` easing and the composite modes of Level 2) on the
// virtual clock: `element.animate()`, `KeyframeEffect`, `Animation`, `document.timeline` and `getAnimations()`.
//
// The document timeline's time is the clock the engine gives (`setAnimationClock`: the frame's time, or a motion-blur
// sub-frame's), so an animation is a function of the frame like everything else. What an animation shows is worked out
// when the element's style is read (`animatedStyleOf`, laid over the inline style the way the animation origin of the
// cascade is), so a sub-frame sees its own time with nothing to undo. Events, promises and pending play and pause
// tasks move once per frame, in `tickAnimations`, which the frame loop calls where a browser updates its animations:
// after the timers, before the `requestAnimationFrame` callbacks.

import { cssPropertyName } from '../request/style.js';
import { parseEasing, type Easing } from './easing.js';
import { compositeValue, interpolateValue } from './css-interpolate.js';
import { isConnectedHost, readbackOfHost } from './tree.js';
import { overlayOf, setAnimatedStyleSource, type HostElement } from './host.js';

let clock: () => number = () => performance.now();

/** Sets where the document timeline reads its time, in ms (the frame loop gives the virtual clock). */
export function setAnimationClock(now: () => number): void {
  clock = now;
}

class DOMExceptionShim extends Error {
  constructor(message: string, override readonly name: string) {
    super(message);
  }
}
const domError = (message: string, name: string): Error => {
  const D = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  return D ? new D(message, name) : new DOMExceptionShim(message, name);
};

export class AnimationTimelineShim {
  get currentTime(): number | null {
    return clock();
  }
  get duration(): number | null {
    return null;
  }
}

export class DocumentTimelineShim extends AnimationTimelineShim {
  private readonly origin: number;
  constructor(options?: { originTime?: number }) {
    super();
    this.origin = Number(options?.originTime ?? 0) || 0;
  }
  override get currentTime(): number | null {
    return clock() - this.origin;
  }
}

/** The document's timeline. */
export const documentTimeline = new DocumentTimelineShim();

// ---- timing ----

type FillMode = 'none' | 'forwards' | 'backwards' | 'both' | 'auto';
type Direction = 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
type Composite = 'replace' | 'add' | 'accumulate';

interface Timing {
  delay: number;
  endDelay: number;
  fill: FillMode;
  iterationStart: number;
  iterations: number;
  duration: number | 'auto';
  direction: Direction;
  easing: string;
}

const DEFAULT_TIMING: Timing = { delay: 0, endDelay: 0, fill: 'auto', iterationStart: 0, iterations: 1, duration: 'auto', direction: 'normal', easing: 'linear' };

function checkedTiming(base: Timing, input: Partial<Timing> | number | undefined): Timing {
  const t = { ...base };
  if (typeof input === 'number') {
    t.duration = input;
  } else if (input !== undefined && input !== null) {
    for (const key of Object.keys(DEFAULT_TIMING) as Array<keyof Timing>) {
      if ((input as Record<string, unknown>)[key] !== undefined) (t as Record<string, unknown>)[key] = (input as Record<string, unknown>)[key];
    }
  }
  if (typeof t.duration === 'string' && t.duration !== 'auto') t.duration = Number(t.duration);
  if (typeof t.duration === 'number' && (!(t.duration >= 0) || Number.isNaN(t.duration))) throw new TypeError(`Invalid duration: ${String(t.duration)}`);
  t.iterations = Number(t.iterations);
  if (!(t.iterations >= 0)) throw new TypeError(`Invalid iterations: ${String(t.iterations)}`);
  t.iterationStart = Number(t.iterationStart);
  if (!(t.iterationStart >= 0) || !Number.isFinite(t.iterationStart)) throw new TypeError(`Invalid iterationStart: ${String(t.iterationStart)}`);
  t.delay = Number(t.delay) || 0;
  t.endDelay = Number(t.endDelay) || 0;
  if (parseEasing(String(t.easing)) === null) throw new TypeError(`'${String(t.easing)}' is not a valid value for easing`);
  return t;
}

interface ComputedTiming {
  delay: number;
  endDelay: number;
  fill: Exclude<FillMode, 'auto'>;
  iterationStart: number;
  iterations: number;
  duration: number;
  direction: Direction;
  easing: string;
  activeDuration: number;
  endTime: number;
  localTime: number | null;
  progress: number | null;
  currentIteration: number | null;
}

export class AnimationEffectShim {
  /** @internal */ timing: Timing = { ...DEFAULT_TIMING };
  /** @internal */ easingFn: Easing = (t) => t;
  /** @internal */ animation: AnimationShim | null = null;

  getTiming(): Timing {
    return { ...this.timing, duration: this.timing.duration };
  }
  updateTiming(input?: Partial<Timing>): void {
    this.timing = checkedTiming(this.timing, input ?? {});
    this.easingFn = parseEasing(this.timing.easing)!;
    this.animation?.timingChanged();
  }
  getComputedTiming(): ComputedTiming {
    return this.computed(this.animation?.currentTime ?? null, this.animation?.playbackRate ?? 1);
  }

  /** @internal Web Animations 1, "Timing model": phases, active time, iteration progress, the easing. */
  computed(localTime: number | null, rate: number): ComputedTiming {
    const t = this.timing;
    const duration = t.duration === 'auto' ? 0 : t.duration;
    const activeDuration = duration === 0 || t.iterations === 0 ? 0 : duration * t.iterations;
    const endTime = Math.max(t.delay + activeDuration + t.endDelay, 0);
    const fill: ComputedTiming['fill'] = t.fill === 'auto' ? 'none' : t.fill;
    const base = { delay: t.delay, endDelay: t.endDelay, fill, iterationStart: t.iterationStart, iterations: t.iterations, duration, direction: t.direction, easing: t.easing, activeDuration, endTime, localTime };
    if (localTime === null) return { ...base, progress: null, currentIteration: null };
    const backwards = rate < 0;
    const beforeEnd = Math.max(Math.min(t.delay, endTime), 0);
    const activeEnd = Math.max(Math.min(t.delay + activeDuration, endTime), 0);
    let phase: 'before' | 'active' | 'after';
    if (localTime < beforeEnd || (backwards && localTime === beforeEnd)) phase = 'before';
    else if (localTime > activeEnd || (!backwards && localTime === activeEnd)) phase = 'after';
    else phase = 'active';
    let active: number | null;
    if (phase === 'before') active = fill === 'backwards' || fill === 'both' ? Math.max(localTime - t.delay, 0) : null;
    else if (phase === 'active') active = localTime - t.delay;
    else active = fill === 'forwards' || fill === 'both' ? Math.max(Math.min(localTime - t.delay, activeDuration), 0) : null;
    if (active === null) return { ...base, progress: null, currentIteration: null };
    let overall = duration === 0 ? (phase === 'before' ? 0 : t.iterations) : active / duration;
    overall += t.iterationStart;
    let simple = Number.isFinite(overall) ? overall % 1 : t.iterationStart % 1;
    if (simple === 0 && (phase === 'active' || phase === 'after') && active === activeDuration && t.iterations !== 0 && overall !== 0) simple = 1;
    let iteration: number;
    if (phase === 'after' && t.iterations === Infinity) iteration = Infinity;
    else if (simple === 1) iteration = Math.floor(overall) - 1;
    else iteration = Math.floor(overall);
    let directed = simple;
    const forwards = t.direction === 'normal' ? true : t.direction === 'reverse' ? false : (iteration % 2 === 0) === (t.direction === 'alternate');
    if (!forwards) directed = 1 - simple;
    const beforeFlag = (phase === 'before' && !backwards) || (phase === 'after' && backwards);
    const progress = this.easingFn(directed, forwards ? beforeFlag : !beforeFlag);
    return { ...base, progress, currentIteration: iteration };
  }
}

interface Keyframe {
  offset: number | null;
  computedOffset: number;
  easing: string;
  easingFn: Easing;
  composite: Composite | 'auto';
  values: Map<string, string>;
}

/** Turns a camelCase property name of a keyframe into CSS (`cssFloat` is `float`, custom properties stay). */
const cssName = (key: string): string => (key.startsWith('--') ? key : key === 'cssFloat' ? 'float' : key === 'cssOffset' ? 'offset' : cssPropertyName(key));

const KEYFRAME_KEYS = new Set(['offset', 'easing', 'composite']);

/** Web Animations 1, "Processing a keyframes argument": both the list form and the property-indexed form. */
function processKeyframes(input: unknown): Keyframe[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== 'object') throw new TypeError('Keyframes must be an object, an array or null');
  const frames: Keyframe[] = [];
  const make = (offset: number | null, easing: string, composite: Composite | 'auto'): Keyframe => {
    const easingFn = parseEasing(easing);
    if (easingFn === null) throw new TypeError(`'${easing}' is not a valid value for easing`);
    if (offset !== null && (!(offset >= 0) || offset > 1)) throw new TypeError('Offsets must be null or between 0 and 1');
    return { offset, computedOffset: 0, easing, easingFn, composite, values: new Map() };
  };
  if (Array.isArray(input) || typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    let last = -Infinity;
    for (const raw of input as Iterable<Record<string, unknown>>) {
      if (raw === null || typeof raw !== 'object') throw new TypeError('A keyframe must be an object');
      const offset = raw.offset === undefined || raw.offset === null ? null : Number(raw.offset);
      if (offset !== null) {
        if (offset < last) throw new TypeError('Offsets must be in order');
        last = offset;
      }
      const frame = make(offset, raw.easing === undefined ? 'linear' : String(raw.easing), (raw.composite as Composite | undefined) ?? 'auto');
      for (const [key, value] of Object.entries(raw)) if (!KEYFRAME_KEYS.has(key) && value !== undefined) frame.values.set(cssName(key), String(value));
      frames.push(frame);
    }
  } else {
    const object = input as Record<string, unknown>;
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
    const offsets = list(object.offset);
    const easings = list(object.easing);
    const composites = list(object.composite);
    const byProperty: Array<[string, unknown[]]> = Object.entries(object).filter(([k]) => !KEYFRAME_KEYS.has(k)).map(([k, v]) => [cssName(k), list(v)]);
    // Each property's values are spread evenly; keyframes at the same offset are merged, in offset order.
    const at = new Map<number, Keyframe>();
    for (const [property, values] of byProperty) {
      values.forEach((value, i) => {
        const offset = values.length === 1 ? 1 : i / (values.length - 1);
        let frame = at.get(offset);
        if (frame === undefined) at.set(offset, (frame = make(null, 'linear', 'auto')));
        frame.computedOffset = offset;
        frame.values.set(property, String(value));
      });
    }
    frames.push(...[...at.values()].sort((a, b) => a.computedOffset - b.computedOffset));
    offsets.forEach((o, i) => {
      if (frames[i] !== undefined && o !== null && o !== undefined) frames[i]!.offset = Number(o);
    });
    if (easings.length > 0) frames.forEach((f, i) => {
      const e = String(easings[i % easings.length]);
      const fn = parseEasing(e);
      if (fn === null) throw new TypeError(`'${e}' is not a valid value for easing`);
      f.easing = e;
      f.easingFn = fn;
    });
    if (composites.length > 0) frames.forEach((f, i) => (f.composite = composites[i % composites.length] as Composite));
  }
  computeOffsets(frames);
  return frames;
}

/** Web Animations 1, "Calculating computed keyframes": missing offsets spread evenly between the known ones. */
function computeOffsets(frames: Keyframe[]): void {
  if (frames.length === 0) return;
  for (const f of frames) f.computedOffset = f.offset ?? NaN;
  if (frames.length > 1 && Number.isNaN(frames[0]!.computedOffset)) frames[0]!.computedOffset = 0;
  if (Number.isNaN(frames[frames.length - 1]!.computedOffset)) frames[frames.length - 1]!.computedOffset = 1;
  for (let i = 1; i < frames.length; i++) {
    if (!Number.isNaN(frames[i]!.computedOffset)) continue;
    let j = i;
    while (Number.isNaN(frames[j]!.computedOffset)) j++;
    const from = frames[i - 1]!.computedOffset;
    const to = frames[j]!.computedOffset;
    for (let k = i; k < j; k++) frames[k]!.computedOffset = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
}

/** The element an effect animates, with the host it stands for. */
interface Target {
  host: HostElement;
}

/** @internal How an effect's target is turned into its host; set by element.ts. */
let hostOfTarget: (target: unknown) => HostElement | null = () => null;
export function setAnimationTargetResolver(resolve: (target: unknown) => HostElement | null): void {
  hostOfTarget = resolve;
}

let warnedPseudo = false;

export class KeyframeEffectShim extends AnimationEffectShim {
  private targetElement: unknown;
  /** @internal */ frames: Keyframe[] = [];
  composite: Composite = 'replace';
  iterationComposite: 'replace' | 'accumulate' = 'replace';
  pseudoElement: string | null = null;

  constructor(target: unknown, keyframes?: unknown, options?: number | (Partial<Timing> & { composite?: Composite; iterationComposite?: 'replace' | 'accumulate'; pseudoElement?: string | null }));
  constructor(source: KeyframeEffectShim);
  constructor(target: unknown, keyframes?: unknown, options?: unknown) {
    super();
    if (target instanceof KeyframeEffectShim && keyframes === undefined) {
      this.targetElement = target.targetElement;
      this.frames = target.frames.map((f) => ({ ...f, values: new Map(f.values) }));
      this.timing = { ...target.timing };
      this.easingFn = target.easingFn;
      this.composite = target.composite;
      this.iterationComposite = target.iterationComposite;
      this.pseudoElement = target.pseudoElement;
      return;
    }
    this.targetElement = target ?? null;
    this.frames = processKeyframes(keyframes);
    this.timing = checkedTiming(DEFAULT_TIMING, options as Partial<Timing> | number | undefined);
    this.easingFn = parseEasing(this.timing.easing)!;
    if (typeof options === 'object' && options !== null) {
      const o = options as { composite?: Composite; iterationComposite?: 'replace' | 'accumulate'; pseudoElement?: string | null };
      if (o.composite !== undefined) this.composite = o.composite;
      if (o.iterationComposite !== undefined) this.iterationComposite = o.iterationComposite;
      if (o.pseudoElement !== undefined) this.pseudoElement = o.pseudoElement;
    }
    if (this.pseudoElement !== null && !warnedPseudo) {
      warnedPseudo = true;
      console.warn(`element.animate(): an animation of a pseudo-element (${this.pseudoElement}) is not drawn; the element itself is`);
    }
  }
  get target(): unknown {
    return this.targetElement;
  }
  set target(value: unknown) {
    const before = this.host();
    this.targetElement = value;
    touch(before);
    touch(this.host());
  }
  /** @internal */ host(): HostElement | null {
    return this.targetElement === null || this.targetElement === undefined ? null : hostOfTarget(this.targetElement);
  }
  getKeyframes(): Array<Record<string, unknown>> {
    return this.frames.map((f) => {
      const out: Record<string, unknown> = { offset: f.offset, computedOffset: f.computedOffset, easing: f.easing, composite: f.composite };
      for (const [property, value] of f.values) out[property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
      return out;
    });
  }
  setKeyframes(keyframes: unknown): void {
    this.frames = processKeyframes(keyframes);
    touch(this.host());
  }

  /** @internal The properties this effect animates. */
  properties(): Set<string> {
    const out = new Set<string>();
    for (const f of this.frames) for (const p of f.values.keys()) out.add(p);
    return out;
  }

  /**
   * @internal Web Animations 1, "The effect value of a keyframe effect": the value of `property` at iteration progress
   * `progress`, over `under` (the value below this effect in the stack).
   */
  valueOf(property: string, progress: number, iteration: number, under: string): string {
    const frames = this.frames.filter((f) => f.values.has(property));
    const value = (f: Keyframe) => {
      const own = f.values.get(property)!;
      const composite = f.composite === 'auto' ? this.composite : f.composite;
      return compositeValue(property, under, own, composite);
    };
    // Implicit keyframes at 0 and 1 take the value underneath (a neutral value composited with `add`).
    type Point = { offset: number; value: string; easing: Easing };
    const points: Point[] = frames.map((f) => ({ offset: f.computedOffset, value: value(f), easing: f.easingFn }));
    if (points.length === 0 || points[0]!.offset !== 0) points.unshift({ offset: 0, value: under, easing: (t) => t });
    if (points[points.length - 1]!.offset !== 1) points.push({ offset: 1, value: under, easing: (t) => t });
    let result: string;
    if (points.length === 1) result = points[0]!.value;
    else {
      let i: number;
      if (progress < 0 && points.filter((p) => p.offset === 0).length > 1) return points[0]!.value;
      if (progress >= 1 && points.filter((p) => p.offset === 1).length > 1) return points[points.length - 1]!.value;
      if (progress < 0) i = 0;
      else if (progress >= 1) i = points.length - 2;
      else {
        i = 0;
        for (let k = 0; k < points.length - 1; k++) if (points[k]!.offset <= progress) i = k;
      }
      const a = points[i]!;
      const b = points[i + 1]!;
      const span = b.offset - a.offset;
      const local = span === 0 ? 0 : (progress - a.offset) / span;
      result = interpolateValue(property, a.value, b.value, a.easing(local));
    }
    // `iterationComposite: 'accumulate'` adds the last keyframe's value once per finished iteration.
    if (this.iterationComposite === 'accumulate' && iteration > 0 && Number.isFinite(iteration)) {
      const last = points[points.length - 1]!.value;
      for (let k = 0; k < iteration; k++) result = compositeValue(property, last, result, 'accumulate');
    }
    return result;
  }
}

// ---- animations ----

type PlayState = 'idle' | 'running' | 'paused' | 'finished';
type Listener = ((event: AnimationPlaybackEventShim) => void) | { handleEvent(event: AnimationPlaybackEventShim): void };

export class AnimationPlaybackEventShim {
  readonly bubbles = false;
  readonly cancelable = false;
  target: unknown = null;
  currentTarget: unknown = null;
  constructor(
    readonly type: string,
    init: { currentTime?: number | null; timelineTime?: number | null } = {},
  ) {
    this.currentTime = init.currentTime ?? null;
    this.timelineTime = init.timelineTime ?? null;
  }
  readonly currentTime: number | null;
  readonly timelineTime: number | null;
}

/** Every animation made, in the order made (the composite order of the API's animations). */
const all = new Set<AnimationShim>();
let sequence = 0;
/** Events to dispatch at the next tick, in the order they were queued. */
let queued: Array<{ animation: AnimationShim; event: AnimationPlaybackEventShim }> = [];

const handled = <T>(p: Promise<T>): Promise<T> => {
  p.catch(() => undefined);
  return p;
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; settled: boolean } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d = { promise, resolve: (v: T) => { d.settled = true; resolve(v); }, reject: (e: unknown) => { d.settled = true; reject(e); }, settled: false };
  return d;
}

/** Tells the readback the host's style changed (an animation moved, started or stopped). */
function touch(host: HostElement | null): void {
  if (host !== null) readbackOfHost(host).touch();
}

export class AnimationShim {
  id = '';
  onfinish: ((event: AnimationPlaybackEventShim) => void) | null = null;
  oncancel: ((event: AnimationPlaybackEventShim) => void) | null = null;
  onremove: ((event: AnimationPlaybackEventShim) => void) | null = null;
  /** @internal */ readonly order = sequence++;
  private effectValue: AnimationEffectShim | null = null;
  private timelineValue: AnimationTimelineShim | null;
  private start: number | null = null;
  private hold: number | null = null;
  private rate = 1;
  private pendingRate: number | null = null;
  /** The pending play or pause task, with the timeline time it was asked at (its ready time). */
  private task: { kind: 'play' | 'pause'; at: number | null } | null = null;
  private previousCurrentTime: number | null = null;
  private readyD = deferred<AnimationShim>();
  private finishedD = deferred<AnimationShim>();
  private finishNotified = false;
  private persisted = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(effect: AnimationEffectShim | null = null, timeline: AnimationTimelineShim | null = documentTimeline) {
    this.timelineValue = timeline;
    this.readyD.resolve(this);
    handled(this.readyD.promise);
    handled(this.finishedD.promise);
    this.effect = effect;
    all.add(this);
  }

  // ---- properties ----

  get effect(): AnimationEffectShim | null {
    return this.effectValue;
  }
  set effect(effect: AnimationEffectShim | null) {
    if (effect === this.effectValue) return;
    const old = this.effectValue;
    if (old !== null) {
      old.animation = null;
      touch((old as KeyframeEffectShim).host?.() ?? null);
    }
    if (effect !== null && effect.animation !== null) effect.animation.effect = null;
    this.effectValue = effect;
    if (effect !== null) effect.animation = this;
    this.updateFinishedState(false, false);
  }
  get timeline(): AnimationTimelineShim | null {
    return this.timelineValue;
  }
  set timeline(timeline: AnimationTimelineShim | null) {
    const previous = this.currentTime;
    this.timelineValue = timeline;
    if (this.start !== null) this.hold = null;
    if (previous !== null) this.silentlySetCurrentTime(previous);
    this.updateFinishedState(false, false);
  }
  get startTime(): number | null {
    return this.start;
  }
  set startTime(value: number | null) {
    const time = value === null ? null : Number(value);
    const timelineTime = this.timelineTime();
    if (timelineTime === null && time !== null) this.hold = null;
    const previous = this.currentTime;
    this.applyPendingRate();
    this.start = time;
    all.add(this);
    if (time !== null) {
      if (this.rate !== 0) this.hold = null;
    } else {
      this.hold = previous;
    }
    if (this.task !== null) {
      this.task = null;
      this.readyD.resolve(this);
    }
    this.updateFinishedState(true, false);
    touch(this.host());
  }
  get currentTime(): number | null {
    if (this.hold !== null) return this.hold;
    const timelineTime = this.timelineTime();
    if (timelineTime === null || this.start === null) return null;
    return (timelineTime - this.start) * this.rate;
  }
  set currentTime(value: number | null) {
    if (value === null) {
      if (this.currentTime !== null) throw new TypeError('currentTime cannot be set to null');
      return;
    }
    this.silentlySetCurrentTime(Number(value));
    all.add(this);
    if (this.task?.kind === 'pause') {
      this.hold = Number(value);
      this.applyPendingRate();
      this.start = null;
      this.task = null;
      this.readyD.resolve(this);
    }
    this.updateFinishedState(true, false);
    touch(this.host());
  }
  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    this.pendingRate = null;
    const previous = this.currentTime;
    this.rate = Number(value);
    if (previous !== null) this.currentTime = previous;
  }
  get pending(): boolean {
    return this.task !== null;
  }
  get ready(): Promise<AnimationShim> {
    return this.readyD.promise;
  }
  get finished(): Promise<AnimationShim> {
    return this.finishedD.promise;
  }
  get replaceState(): 'active' | 'removed' | 'persisted' {
    return this.persisted ? 'persisted' : 'active';
  }
  get playState(): PlayState {
    const current = this.currentTime;
    if (current === null && this.start === null && this.task === null) return 'idle';
    if (this.task?.kind === 'pause' || (this.start === null && this.task?.kind !== 'play')) return 'paused';
    if (current !== null && ((this.effectiveRate() > 0 && current >= this.endTime()) || (this.effectiveRate() < 0 && current <= 0))) return 'finished';
    return 'running';
  }

  // ---- methods ----

  play(): void {
    this.playInternal(true);
  }
  pause(): void {
    if (this.task?.kind === 'pause') return;
    if (this.playState === 'paused') return;
    let seek: number | null = null;
    if (this.currentTime === null) {
      if (this.rate >= 0) seek = 0;
      else {
        if (this.endTime() === Infinity) throw domError('Cannot pause an animation with an infinite end in reverse', 'InvalidStateError');
        seek = this.endTime();
      }
    }
    if (seek !== null) this.hold = seek;
    all.add(this);
    const hadPlay = this.task?.kind === 'play';
    if (!hadPlay) this.newReady();
    this.task = { kind: 'pause', at: this.timelineTime() };
    this.updateFinishedState(false, false);
    touch(this.host());
  }
  finish(): void {
    const rate = this.effectiveRate();
    if (rate === 0 || (rate > 0 && this.endTime() === Infinity)) throw domError('Cannot finish this animation', 'InvalidStateError');
    this.applyPendingRate();
    all.add(this);
    const limit = this.rate > 0 ? this.endTime() : 0;
    this.silentlySetCurrentTime(limit);
    const timelineTime = this.timelineTime();
    if (this.start === null && timelineTime !== null) this.start = timelineTime - limit / this.rate;
    if (this.task?.kind === 'pause' && this.start !== null) {
      this.hold = null;
      this.task = null;
      this.readyD.resolve(this);
    }
    if (this.task?.kind === 'play' && this.start !== null) {
      this.task = null;
      this.readyD.resolve(this);
    }
    this.updateFinishedState(true, true);
    touch(this.host());
  }
  cancel(): void {
    if (this.playState !== 'idle') {
      if (this.task !== null) {
        this.task = null;
        this.readyD.reject(domError('The animation was cancelled', 'AbortError'));
        this.readyD = deferred();
        this.readyD.resolve(this);
        handled(this.readyD.promise);
      }
      if (!this.finishedD.settled) this.finishedD.reject(domError('The animation was cancelled', 'AbortError'));
      this.finishedD = deferred();
      handled(this.finishedD.promise);
      this.finishNotified = false;
      queued.push({ animation: this, event: new AnimationPlaybackEventShim('cancel', { currentTime: null, timelineTime: this.timelineTime() }) });
    }
    this.hold = null;
    this.start = null;
    touch(this.host());
  }
  reverse(): void {
    if (this.timelineTime() === null) throw domError('The animation has no active timeline', 'InvalidStateError');
    const original = this.pendingRate;
    this.pendingRate = -this.effectiveRate();
    try {
      this.playInternal(true);
    } catch (error) {
      this.pendingRate = original;
      throw error;
    }
  }
  updatePlaybackRate(rate: number): void {
    const previousState = this.playState;
    this.pendingRate = Number(rate);
    if (this.task !== null) return;
    if (previousState === 'idle' || previousState === 'paused') {
      this.applyPendingRate();
    } else if (previousState === 'finished') {
      const timelineTime = this.timelineTime();
      const unconstrained = timelineTime !== null && this.start !== null ? (timelineTime - this.start) * this.rate : null;
      if (Number(rate) === 0) this.start = timelineTime;
      else if (unconstrained !== null && timelineTime !== null) this.start = timelineTime - unconstrained / Number(rate);
      this.applyPendingRate();
      this.updateFinishedState(false, false);
    } else {
      this.playInternal(false);
    }
  }
  persist(): void {
    this.persisted = true;
  }
  /** Writes the animated values into the target's inline style. */
  commitStyles(): void {
    const effect = this.effectValue as KeyframeEffectShim | null;
    const host = effect?.host?.() ?? null;
    if (host === null || effect === null) return;
    const target = effect.target as { style?: { setProperty(name: string, value: string): void } };
    const values = animatedStyleOf(host, this);
    if (values === null || target.style === undefined) return;
    for (const property of effect.properties()) {
      const value = values.get(property);
      if (value !== undefined) target.style.setProperty(property, value);
    }
  }
  addEventListener(type: string, listener: Listener | null): void {
    if (listener === null) return;
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener | null): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: AnimationPlaybackEventShim): boolean {
    event.target = event.currentTarget = this;
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === 'function') handler.call(this, event);
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
    return true;
  }

  // ---- internals ----

  /** @internal */ host(): HostElement | null {
    return (this.effectValue as KeyframeEffectShim | null)?.host?.() ?? null;
  }
  /** @internal */ timingChanged(): void {
    this.updateFinishedState(false, false);
    touch(this.host());
  }
  private timelineTime(): number | null {
    return this.timelineValue?.currentTime ?? null;
  }
  private endTime(): number {
    return this.effectValue?.computed(null, 1).endTime ?? 0;
  }
  private effectiveRate(): number {
    return this.pendingRate ?? this.rate;
  }
  private applyPendingRate(): void {
    if (this.pendingRate !== null) {
      this.rate = this.pendingRate;
      this.pendingRate = null;
    }
  }
  private newReady(): void {
    if (this.readyD.settled) {
      this.readyD = deferred();
      handled(this.readyD.promise);
    }
  }
  private silentlySetCurrentTime(seek: number): void {
    const timelineTime = this.timelineTime();
    if (this.hold !== null || this.start === null || timelineTime === null || this.rate === 0) this.hold = seek;
    else this.start = timelineTime - seek / this.rate;
    if (timelineTime === null) this.start = null;
    this.previousCurrentTime = null;
  }
  /** Web Animations 1, "Playing an animation". */
  private playInternal(autoRewind: boolean): void {
    const abortedPause = this.task?.kind === 'pause';
    let hasPendingReadyPromise = false;
    let seek: number | null = null;
    const rate = this.effectiveRate();
    const current = this.currentTime;
    const end = this.endTime();
    if (rate >= 0 && autoRewind && (current === null || current < 0 || current >= end)) seek = 0;
    else if (rate < 0 && autoRewind && (current === null || current <= 0 || current > end)) {
      if (end === Infinity) throw domError('Cannot play an animation with an infinite end in reverse', 'InvalidStateError');
      seek = end;
    } else if (rate === 0 && current === null) seek = 0;
    if (seek !== null) {
      this.start = null;
      this.hold = seek;
    }
    all.add(this);
    if (this.hold !== null) this.start = null;
    if (this.task !== null) {
      this.task = null;
      hasPendingReadyPromise = true;
    }
    if (this.hold === null && seek === null && !abortedPause && this.pendingRate === null) {
      this.updateFinishedState(false, false);
      return;
    }
    if (!hasPendingReadyPromise) this.newReady();
    this.task = { kind: 'play', at: this.timelineTime() };
    this.finishNotified = false;
    this.updateFinishedState(false, false);
    touch(this.host());
  }
  /** @internal The pending play or pause task, done when the animation is ready (the next tick). */
  runPendingTask(): void {
    const task = this.task;
    if (task === null) return;
    const ready = task.at ?? this.timelineTime();
    this.task = null;
    if (task.kind === 'play') {
      if (this.hold !== null) {
        this.applyPendingRate();
        if (this.rate === 0) this.start = ready;
        else if (ready !== null) {
          this.start = ready - this.hold / this.rate;
          this.hold = null;
        }
      } else if (this.start !== null && this.pendingRate !== null) {
        const current = ready === null ? 0 : (ready - this.start) * this.rate;
        this.applyPendingRate();
        this.start = this.rate === 0 ? ready : ready! - current / this.rate;
      }
    } else {
      if (this.start !== null && this.hold === null && ready !== null) this.hold = (ready - this.start) * this.rate;
      this.applyPendingRate();
      this.start = null;
    }
    this.readyD.resolve(this);
    this.updateFinishedState(false, false);
    touch(this.host());
  }
  /** Web Animations 1, "Updating the finished state". */
  private updateFinishedState(didSeek: boolean, synchronously: boolean): void {
    const unconstrained = (() => {
      if (didSeek) return this.currentTime;
      const timelineTime = this.timelineTime();
      if (timelineTime === null || this.start === null) return null;
      return (timelineTime - this.start) * this.rate;
    })();
    if (unconstrained !== null && this.start !== null && this.task === null) {
      const end = this.endTime();
      if (this.rate > 0 && unconstrained >= end) {
        this.hold = didSeek ? unconstrained : Math.max(this.previousCurrentTime ?? end, end);
        if (!didSeek && this.previousCurrentTime === null) this.hold = end;
      } else if (this.rate < 0 && unconstrained <= 0) {
        this.hold = didSeek ? unconstrained : Math.min(this.previousCurrentTime ?? 0, 0);
        if (!didSeek && this.previousCurrentTime === null) this.hold = 0;
      } else if (this.rate !== 0 && this.timelineTime() !== null) {
        if (didSeek && this.hold !== null) this.start = this.timelineTime()! - this.hold / this.rate;
        this.hold = null;
      }
    }
    this.previousCurrentTime = this.currentTime;
    if (this.playState === 'finished') {
      if (!this.finishNotified && synchronously) this.notifyFinished();
    } else {
      if (this.finishedD.settled) {
        this.finishedD = deferred();
        handled(this.finishedD.promise);
      }
      this.finishNotified = false;
    }
  }
  /** @internal The finish notification steps: resolve `finished` and queue the `finish` event. */
  notifyFinished(): void {
    if (this.playState !== 'finished' || this.finishNotified) return;
    this.finishNotified = true;
    this.finishedD.resolve(this);
    queued.push({ animation: this, event: new AnimationPlaybackEventShim('finish', { currentTime: this.currentTime, timelineTime: this.timelineTime() }) });
  }
  /** @internal Called once per frame. */
  tick(): void {
    this.runPendingTask();
    this.updateFinishedState(false, false);
    this.notifyFinished();
  }
  /** @internal Whether the animation still has anything to do at a later frame (a task, an event, a value that moves). */
  live(): boolean {
    if (this.task !== null) return true;
    const state = this.playState;
    return state === 'running' || (state === 'finished' && !this.finishNotified);
  }
}

// ---- the frame loop's side ----

/**
 * Moves every animation to the clock's time, as a browser's "update animations and send events" step: pending play and
 * pause tasks are done, finished animations resolve `finished` and fire `finish`, and the queued events are dispatched.
 */
export function tickAnimations(): void {
  for (const animation of [...all]) animation.tick();
  const events = queued;
  queued = [];
  for (const { animation, event } of events) animation.dispatchEvent(event);
  // An idle animation (cancelled, or never played) does nothing until it is played again, which puts it back.
  for (const animation of all) if (animation.playState === 'idle') all.delete(animation);
}

/**
 * The clock moved (a frame, or a motion-blur sub-frame): the style of every animated element is read again. Called by
 * the frame loop whenever it sets the clock.
 */
export function animationClockMoved(): void {
  const seen = new Set<HostElement>();
  for (const animation of all) {
    const target = animation.host();
    if (target !== null && !seen.has(target)) {
      seen.add(target);
      readbackOfHost(target).touch();
    }
  }
}

/** Whether any animation has work left at a later frame (the frame loop steps skipped frames while it does). */
export function animationsPending(): boolean {
  for (const animation of all) if (animation.live()) return true;
  return queued.length > 0;
}

/** Forgets every animation (a new render). */
export function resetAnimations(): void {
  all.clear();
  queued = [];
}

/** The animations whose effect targets `host` and that are current or in effect, in composite order. */
export function animationsOf(host: HostElement | null, subtree = false): AnimationShim[] {
  const out: AnimationShim[] = [];
  for (const animation of all) {
    const effect = animation.effect as KeyframeEffectShim | null;
    const target = effect?.host?.() ?? null;
    if (target === null) continue;
    if (host !== null) {
      let match = target === host;
      if (!match && subtree) for (let h: HostElement | null = target; h !== null && !match; h = readbackOfHost(h).parent(h)) match = h === host;
      if (!match) continue;
    } else if (!isConnectedHost(target)) continue;
    const state = animation.playState;
    if (state === 'idle') continue;
    const timing = effect!.computed(animation.currentTime, animation.playbackRate);
    const current = state !== 'finished' || timing.progress !== null;
    if (current) out.push(animation);
  }
  return out;
}

/**
 * The style the animations on `host` give it now, as CSS property to value (kebab-case), or null when none applies.
 * `upTo` stops before that animation (what `commitStyles` reads, which includes it, passes the one after).
 */
export function animatedStyleOf(host: HostElement, upTo?: AnimationShim): Map<string, string> | null {
  if (all.size === 0) return null;
  let out: Map<string, string> | null = null;
  for (const animation of all) {
    const effect = animation.effect as KeyframeEffectShim | null;
    if (effect === null || effect.host() !== host || effect.pseudoElement !== null) continue;
    if (animation.playState === 'idle') continue;
    const timing = effect.computed(animation.currentTime, animation.playbackRate);
    if (timing.progress === null) continue;
    for (const property of effect.properties()) {
      const under = out?.get(property) ?? baseValue(host, property);
      const value = effect.valueOf(property, timing.progress, timing.currentIteration ?? 0, under);
      (out ??= new Map()).set(property, value);
    }
    if (animation === upTo) break;
  }
  return out;
}

/** The initial values of the properties animations usually move, for an element with no inline value for them. */
const INITIAL: Record<string, string> = {
  opacity: '1', transform: 'none', filter: 'none', 'backdrop-filter': 'none', 'clip-path': 'none', 'background-color': 'rgba(0, 0, 0, 0)',
  color: 'rgb(0, 0, 0)', 'box-shadow': 'none', 'text-shadow': 'none', translate: 'none', rotate: 'none', scale: 'none', visibility: 'visible',
  'border-radius': '0px', 'letter-spacing': '0px', 'stroke-dashoffset': '0px', 'fill-opacity': '1', 'stroke-opacity': '1',
};

/** The value under the animations: the inline style (a script's included), else the property's initial value. */
function baseValue(host: HostElement, property: string): string {
  const overlay = overlayOf(host, false)?.style.get(property);
  if (overlay !== undefined && overlay !== '') return overlay;
  const style = host.props.style;
  if (typeof style === 'object' && style !== null) {
    for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
      if ((key.startsWith('--') ? key : cssPropertyName(key)) === property && value !== undefined && value !== null && value !== '') {
        return typeof value === 'number' && value !== 0 && !UNITLESS.has(property) ? `${value}px` : String(value);
      }
    }
  }
  return INITIAL[property] ?? (/(width|height|top|left|right|bottom|margin|padding|gap|size|radius|spacing|offset)$/.test(property) ? '0px' : '');
}

const UNITLESS = new Set(['opacity', 'z-index', 'flex-grow', 'flex-shrink', 'order', 'font-weight', 'line-height', 'scale', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'zoom']);

setAnimatedStyleSource((host) => animatedStyleOf(host));
