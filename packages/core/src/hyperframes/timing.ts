// HyperFrames' timing contract (docs: "Data attributes", "HTML schema"), as pure functions over elements: when a clip
// starts and ends in the project's time, whether it is on screen at a time, and which local time each registered
// timeline is seeked to. Written from the documented behaviour of HyperFrames' runtime (Apache-2.0).

import { parseAutomation, sourceTimeAt, timeAtSourceTime, type RateSpec } from './automation.js';
import { hasZeroDurationCallbackTween, rerenderAt, seekTimelineTo } from './gsap-seek.js';

/** The two instants closer than this are one (HyperFrames' half-open windows would otherwise flicker on float sums). */
const SAME_INSTANT = 1e-6;
const TERMINAL_EPSILON = 1e-6;

const sameInstant = (a: number, b: number): boolean => Math.abs(a - b) < SAME_INSTANT;
const hasStarted = (time: number, start: number): boolean => time >= start || sameInstant(time, start);

/** Half-open: two back-to-back clips never both hold the shared instant. */
export function isInClipWindow(time: number, start: number, end: number): boolean {
  return hasStarted(time, start) && time < end && !sameInstant(time, end);
}

/** The visibility window: half-open, except a clip that runs to the composition's end also owns the last instant. */
export function isClipVisibleAt(time: number, start: number, end: number, compositionDuration: number): boolean {
  return isInClipWindow(time, start, end) || (hasStarted(time, start) && compositionDuration > 0 && end >= compositionDuration - TERMINAL_EPSILON);
}

/** `"12.5"`, `"intro"`, `"intro + 2"`, `"intro - 0.5"`. */
export type StartExpression = { kind: 'seconds'; seconds: number } | { kind: 'ref'; id: string; offset: number };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A finite number from an attribute that is only a number (not `"3s"`, not `""`), else null. */
export function parseNumeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!NUMBER.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseStartExpression(value: string | null | undefined): StartExpression | null {
  if (value === null || value === undefined) return null;
  const seconds = parseNumeric(value);
  if (seconds !== null) return { kind: 'seconds', seconds };
  const m = /^\s*([A-Za-z_][\w:.-]*)\s*(?:([+-])\s*(\d+\.?\d*|\.\d+))?\s*$/.exec(value);
  if (!m) return null;
  const offset = m[2] === undefined ? 0 : (m[2] === '-' ? -1 : 1) * Number(m[3]);
  return { kind: 'ref', id: m[1]!, offset };
}

/** The part of an element the resolver reads: the live DOM's elements answer to it. */
export interface TimedElement {
  id: string;
  tagName: string;
  parentElement: TimedElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<TimedElement>;
}

export interface TimingEnv {
  /** The natural duration in seconds of a `<video>`/`<audio>`, or null when unknown. */
  mediaDuration(element: TimedElement): number | null;
  /** The duration of the timeline registered for a composition id, or null. */
  timelineDuration(compositionId: string): number | null;
  /** `document.getElementById`. */
  byId(id: string): TimedElement | null;
  /** The element with this `data-composition-id`. */
  byComposition(id: string): TimedElement | null;
}

/** HyperFrames' default for an `<img>` timed by `data-start` alone. */
export const IMAGE_SECONDS = 3;

const tag = (el: TimedElement): string => el.tagName.toLowerCase();

export function isMedia(el: TimedElement): boolean {
  const t = tag(el);
  return t === 'video' || t === 'audio';
}

/** `data-playback-rate` as the browser parses a rate (`"2x"` is 2), kept to 0.1..10; 1 when absent or not above 0 (parsers/mediaDuration.ts: readPlaybackRate). */
export function playbackRateOf(el: TimedElement): number {
  const authored = Number.parseFloat(el.getAttribute('data-playback-rate') ?? '');
  return Number.isFinite(authored) && authored > 0 ? Math.max(0.1, Math.min(10, authored)) : 1;
}

/** The clip's speed: its `rate` lane in `data-automation` when it has one, else the constant (runtime/playbackRate.ts: readElementRateSpec). */
export function rateSpecOf(el: TimedElement): RateSpec {
  return parseAutomation(el.getAttribute('data-automation'))?.rate ?? playbackRateOf(el);
}

/** The offset into the source: `data-media-start` for media, `data-playback-start` (then `data-media-start`) for a composition host. */
export function sourceOffsetOf(el: TimedElement): number {
  const names = isMedia(el) ? ['data-media-start'] : ['data-playback-start', 'data-media-start'];
  for (const name of names) {
    const n = parseNumeric(el.getAttribute(name));
    if (n !== null && n >= 0) return n;
  }
  return 0;
}

/** Start and duration of clips, in the project's time. */
export class TimingResolver {
  private readonly starts = new Map<TimedElement, number>();
  private readonly durations = new Map<TimedElement, number | null>();
  private readonly visiting = new Set<TimedElement>();

  constructor(private readonly env: TimingEnv) {}

  /** The nearest ancestor that is a composition (has `data-composition-id`). */
  compositionHost(el: TimedElement): TimedElement | null {
    for (let p = el.parentElement; p !== null; p = p.parentElement) if (p.hasAttribute('data-composition-id')) return p;
    return null;
  }

  /** The element a reference in `from`'s `data-start` is looked up in: its own composition's. */
  private scopeOf(from: TimedElement): TimedElement | null {
    const own = from.hasAttribute('data-composition-id') ? from.parentElement : from;
    for (let p: TimedElement | null = own; p !== null; p = p.parentElement) if (p.hasAttribute('data-composition-id')) return p;
    return null;
  }

  private findReference(id: string, from: TimedElement): TimedElement | null {
    const scope = this.scopeOf(from);
    if (scope !== null) {
      for (const candidate of Array.from(scope.querySelectorAll(`[id="${id}"]`))) {
        if (this.scopeOf(candidate) === scope) return candidate;
      }
    }
    return this.env.byId(id) ?? this.env.byComposition(id);
  }

  /**
   * Where the host's local time 0 falls in the project: the host's start less its in-point (`data-playback-start`), so
   * that what a host plays from its in-point has its children at the right time (parsers/mediaTiming.ts: compositionOriginSeconds).
   */
  private hostOrigin(el: TimedElement): number {
    const host = this.compositionHost(el);
    return host === null ? 0 : this.start(host) - sourceOffsetOf(host);
  }

  /** Start in the composition's own time: `data-start` as written (a reference resolved), 0 without one. */
  localStart(el: TimedElement): number {
    const expression = parseStartExpression(el.getAttribute('data-start'));
    if (expression === null) return 0;
    if (expression.kind === 'seconds') return Math.max(0, expression.seconds);
    const target = this.findReference(expression.id, el);
    if (target === null || target === el || this.visiting.has(el)) return 0;
    this.visiting.add(el);
    try {
      const duration = this.duration(target);
      // A reference to a clip with no known length cannot say when it ends: it ends where it starts.
      return this.start(target) - this.hostOrigin(el) + (duration ?? 0) + expression.offset;
    } finally {
      this.visiting.delete(el);
    }
  }

  /**
   * Start in the project's time: the host's origin plus the local start. A reference is clamped at the host's start when
   * an in-point puts local 0 before 0 (runtime/startResolver.ts: computeStart). A media element whose
   * `data-hf-media-start-basis` is `global` has a start that is already the project's.
   */
  start(el: TimedElement): number {
    const known = this.starts.get(el);
    if (known !== undefined) return known;
    const origin = this.hostOrigin(el);
    const expression = parseStartExpression(el.getAttribute('data-start'));
    let value: number;
    if (expression !== null && expression.kind === 'seconds' && isMedia(el) && origin !== 0 && (el.getAttribute('data-hf-media-start-basis') ?? '').trim().toLowerCase() === 'global') {
      value = expression.seconds;
    } else if (expression !== null && expression.kind === 'ref') {
      value = Math.max(Math.min(0, origin), origin + this.localStart(el));
    } else {
      value = origin + this.localStart(el);
    }
    this.starts.set(el, value);
    return value;
  }

  /** `data-duration`, else `data-end` less the start: the length an author wrote, none of the natural ones. */
  private authoredDuration(el: TimedElement): number | null {
    const positive = (n: number | null): number | null => (n !== null && Number.isFinite(n) && n > 0 ? n : null);
    const written = positive(parseNumeric(el.getAttribute('data-duration')));
    if (written !== null) return written;
    const end = parseNumeric(el.getAttribute('data-end'));
    return end === null ? null : positive(end - this.localStart(el));
  }

  /**
   * The windows of the hosts above `el` that start their composition part-way in (an in-point): what `el` plays is cut to
   * them (parsers/mediaTiming.ts: cutToHostSlots; runtime/startResolver.ts: resolveHostSlotsForElement).
   */
  hostSlots(el: TimedElement): { start: number; end: number }[] {
    const slots: { start: number; end: number }[] = [];
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      if (!node.hasAttribute('data-composition-id') || sourceOffsetOf(node) <= 0) continue;
      const start = this.start(node);
      const duration = this.authoredDuration(node);
      slots.push({ start, end: duration !== null ? start + duration : Infinity });
    }
    return slots;
  }

  /** Length in seconds on the timeline, or null when the clip has none of its own (it runs to the end). */
  duration(el: TimedElement): number | null {
    if (this.durations.has(el)) return this.durations.get(el) ?? null;
    const positive = (n: number | null): number | null => (n !== null && Number.isFinite(n) && n > 0 ? n : null);
    let value = positive(parseNumeric(el.getAttribute('data-duration')));
    if (value === null) {
      const end = parseNumeric(el.getAttribute('data-end'));
      if (end !== null) value = positive(end - this.localStart(el));
    }
    if (value === null && isMedia(el)) {
      const natural = this.env.mediaDuration(el);
      if (natural !== null) value = positive(timeAtSourceTime(rateSpecOf(el), Math.max(0, natural - sourceOffsetOf(el))));
    }
    if (value === null && tag(el) === 'img' && el.hasAttribute('data-start')) value = IMAGE_SECONDS;
    if (value === null) {
      const id = el.getAttribute('data-composition-id');
      if (id !== null) value = positive(this.env.timelineDuration(id));
    }
    this.durations.set(el, value);
    return value;
  }

  /** The end of the clip in the project's time (Infinity without a length). */
  end(el: TimedElement): number {
    const duration = this.duration(el);
    return duration === null ? Infinity : this.start(el) + duration;
  }

  /** Whether `el` and every timed ancestor is on screen at `time`. */
  visibleAt(el: TimedElement, time: number, compositionDuration: number, root: TimedElement | null): boolean {
    for (let node: TimedElement | null = el; node !== null && node !== root; node = node.parentElement) {
      if (node.hasAttribute('data-start') && !isClipVisibleAt(time, this.start(node), this.end(node), compositionDuration)) return false;
    }
    return true;
  }

  /** Forget everything resolved (a script changed the timing attributes). */
  reset(): void {
    this.starts.clear();
    this.durations.clear();
  }
}

/** A timeline (GSAP's): the calls the runtime makes. */
export interface TimelineLike {
  pause?(): unknown;
  totalTime?(time?: number, suppressEvents?: boolean): unknown;
  seek?(time: number, suppressEvents?: boolean): unknown;
  totalDuration?(): number;
  duration?(): number;
}

/** Each in-point host cuts the span to its own window. */
export function cutToSlots(span: { start: number; end: number }, slots: readonly { start: number; end: number }[]): { start: number; end: number } {
  return slots.reduce((kept, slot) => {
    const start = Math.max(kept.start, slot.start);
    return { start, end: Math.max(start, Math.min(kept.end, slot.end)) };
  }, span);
}

export function timelineDuration(timeline: TimelineLike | undefined): number | null {
  if (!timeline) return null;
  try {
    const total = Number(timeline.totalDuration ? timeline.totalDuration() : timeline.duration ? timeline.duration() : NaN);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** Where a composition's clock stands against the project's: its host's start, the point it stops (the host's end), the source offset and rate. */
export interface SceneClock {
  start: number;
  hiddenFrom: number;
  playbackStart: number;
  rate: RateSpec;
}

/**
 * The time a registered timeline is seeked to when the project is at `time`: the child's own time from its host's
 * start (held at the host's end), scaled by the rate and shifted by the playback start, never past the timeline's end.
 */
export function localTimelineTime(clock: SceneClock, time: number, duration: number | null): number {
  const source = clock.playbackStart + sourceTimeAt(clock.rate, Math.max(0, Math.min(time, clock.hiddenFrom) - clock.start));
  const clamped = duration !== null && duration > 0 ? Math.min(duration, source) : source;
  return Math.max(0, clamped);
}

/** Seeks one timeline: paused, to `time`, the way HyperFrames seeks a GSAP one (see `gsap-seek.ts`). */
export function seekTimeline(timeline: TimelineLike, time: number, suppressEvents = false, rerender = false): void {
  timeline.pause?.();
  if (typeof timeline.totalTime === 'function') {
    const redrawn = seekTimelineTo(timeline as never, time, suppressEvents);
    if (rerender && !redrawn && !suppressEvents && !hasZeroDurationCallbackTween(timeline as never)) rerenderAt(timeline as never, time);
  } else timeline.seek?.(time, suppressEvents);
}

/**
 * Seeks the root timeline to `time` (held at its end: a seek past the end of a paused GSAP timeline can undo its
 * `from()` tweens), then every other registered timeline to its own local time. Every frame, every timeline: a frame
 * is a function of the time alone.
 */
export function seekTimelines(
  registry: Record<string, TimelineLike | undefined>,
  rootId: string | null,
  time: number,
  clockOf: (compositionId: string) => SceneClock | null,
  suppressEvents = false,
  /** Hears each seek that failed (a tween's callback threw: what it drew is missing), so the frame can say so. */
  onFailure: (message: string) => void = (message) => console.warn(`HyperFrames: ${message}`),
): void {
  for (const [id, timeline] of Object.entries(registry)) {
    if (!timeline || typeof timeline !== 'object') continue;
    try {
      if (id === rootId) {
        const total = timelineDuration(timeline);
        seekTimeline(timeline, total !== null && time > total ? total : time, suppressEvents, true);
        continue;
      }
      const clock = clockOf(id);
      if (clock === null) continue;
      seekTimeline(timeline, localTimelineTime(clock, time, timelineDuration(timeline)), suppressEvents);
    } catch (error) {
      onFailure(`seeking the timeline of "${id}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
