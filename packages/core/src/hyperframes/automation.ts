// `data-automation`: HyperFrames' envelopes over a clip's own time, written from its source (Apache-2.0,
// heygen-com/hyperframes; packages/core/src/audioAutomation.ts, speedRamp.ts, runtime/audioAutomationVolume.ts). A lane
// is a list of breakpoints `{ t, v, curve?, viaX?, viaY? }` with `t` in seconds from the clip's start. Two lanes change a
// clip here: `volume` (a gain on the clip) and `rate` (a speed multiplier: a speed ramp). Lanes that drive an audio
// effect (`fx.<node>.<param>`) are read and ignored, as the effects are.
//
// Everything is a pure function of the attribute text and a time, so a frame is a function of its number.

export const MIN_RATE = 0.1;
export const MAX_RATE = 10;
/** Linear gain of +12 dB, the ceiling of every volume (audioGain.ts: MAX_AUDIO_GAIN). */
export const MAX_GAIN = 10 ** (12 / 20);
const MAX_POINTS = 512;

export interface AutomationPoint {
  /** Seconds from the start of the clip. */
  t: number;
  v: number;
  /** Curvature of the segment leaving this point, -1..1. */
  curve?: number;
  /** A point the segment leaving this one passes through, as fractions of the segment (both or neither). */
  viaX?: number;
  viaY?: number;
}

export interface AutomationLane {
  target: string;
  points: AutomationPoint[];
}

const finite = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function via(rawX: unknown, rawY: unknown): { x: number; y: number } | null {
  const x = finite(rawX);
  const y = finite(rawY);
  if (x === null || y === null) return null;
  const inside = (n: number): number => Math.min(0.999, Math.max(0.001, n));
  const cx = inside(x);
  const cy = inside(y);
  return Math.abs(cx - cy) < 1e-6 ? null : { x: cx, y: cy };
}

function cleanPoints(raw: unknown, min: number, max: number): AutomationPoint[] {
  if (!Array.isArray(raw)) return [];
  const clean: AutomationPoint[] = [];
  for (const item of raw) {
    const t = finite(item?.t);
    const v = finite(item?.v);
    if (t === null || v === null) continue;
    const curve = finite(item?.curve);
    const bend = via(item?.viaX, item?.viaY);
    clean.push({
      t: Math.max(0, t),
      v: Math.min(max, Math.max(min, v)),
      ...(curve ? { curve: Math.min(1, Math.max(-1, curve)) } : {}),
      ...(bend ? { viaX: bend.x, viaY: bend.y } : {}),
    });
  }
  clean.sort((a, b) => a.t - b.t);
  // The later of two points at one time wins.
  const out: AutomationPoint[] = [];
  for (const p of clean) {
    if (out.length > 0 && out[out.length - 1]!.t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out.slice(0, MAX_POINTS);
}

export interface Automation {
  volume: AutomationLane | null;
  rate: AutomationLane | null;
}

/** The volume and rate lanes of a `data-automation` value; null for text that is not an automation (version 1, a `lanes` array). */
export function parseAutomation(text: string | null | undefined): Automation | null {
  if (!text) return null;
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || raw.version !== 1 || !Array.isArray(raw.lanes)) return null;
  const out: Automation = { volume: null, rate: null };
  for (const lane of raw.lanes) {
    if (lane?.target === 'volume') {
      const points = cleanPoints(lane.points, 0, MAX_GAIN);
      if (points.length > 0) out.volume = { target: 'volume', points };
    } else if (lane?.target === 'rate') {
      const points = cleanPoints(lane.points, MIN_RATE, MAX_RATE);
      if (points.length > 0) out.rate = { target: 'rate', points };
    }
  }
  return out;
}

// ---- the shape of a segment ----

/** `curve` is an exponent in disguise: 0 is straight (audioAutomation.ts: applyCurve). */
const applyCurve = (x: number, curve: number | undefined): number => (curve ? Math.pow(x, Math.pow(2, 2 * curve)) : x);

/**
 * The rational quadratic Bezier from (0,0) to (1,1) that passes through the via point at its mid-parameter, with the
 * smallest weight that keeps its control point inside the segment (audioAutomation.ts: viaConic, shapeVia).
 */
function shapeVia(x: number, viaX: number, viaY: number): number {
  const dx = viaX - 0.5;
  const dy = viaY - 0.5;
  const edge = 0.999;
  const needX = dx > 0 ? dx / (edge - viaX) : dx < 0 ? -dx / (viaX - (1 - edge)) : 0;
  const needY = dy > 0 ? dy / (edge - viaY) : dy < 0 ? -dy / (viaY - (1 - edge)) : 0;
  const w = Math.min(1e6, Math.max(1, needX, needY));
  const cx = viaX + dx / w;
  const cy = viaY + dy / w;
  // x(t) = x is a quadratic in t; take the root on the arc.
  const spread = 2 - 2 * w;
  const a = x * spread - 1 + 2 * w * cx;
  const b = -x * spread - 2 * w * cx;
  let t: number;
  if (Math.abs(a) < 1e-12) t = Math.abs(b) < 1e-12 ? x : -x / b;
  else {
    const root = Math.sqrt(Math.max(0, b * b - 4 * a * x));
    const first = (-b + root) / (2 * a);
    const second = (-b - root) / (2 * a);
    const onArc = (n: number): boolean => n >= -1e-9 && n <= 1 + 1e-9;
    t = onArc(first) ? Math.min(1, Math.max(0, first)) : onArc(second) ? Math.min(1, Math.max(0, second)) : x;
  }
  const rest = 1 - t;
  const denominator = rest * rest + 2 * w * t * rest + t * t;
  return denominator > 0 ? (2 * w * cy * t * rest + t * t) / denominator : x;
}

const shape = (x: number, p: AutomationPoint): number =>
  p.viaX !== undefined && p.viaY !== undefined ? shapeVia(Math.min(1, Math.max(0, x)), p.viaX, p.viaY) : applyCurve(x, p.curve);

/** The lane's value at clip-local `t`: it holds its first value before the first point and its last after the last. `log` interpolates in log space (rate). */
export function sampleLane(lane: AutomationLane, t: number, scale: 'linear' | 'log' = 'linear'): number {
  const pts = lane.points;
  const first = pts[0]!;
  if (t <= first.t) return first.v;
  const last = pts[pts.length - 1]!;
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const x = shape((t - a.t) / span, a);
  return scale === 'log' && a.v > 0 && b.v > 0 ? Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * x) : a.v + (b.v - a.v) * x;
}

// ---- speed ramps ----

/** A constant multiplier, or a `rate` lane. */
export type RateSpec = number | AutomationLane;

const CELLS = 48;
interface RateTable {
  ts: Float64Array;
  ss: Float64Array;
  firstRate: number;
  lastRate: number;
}
const tables = new WeakMap<AutomationLane, RateTable>();

/** Source seconds consumed by clip-local time, tabulated by the trapezoid rule over 48 cells per segment (speedRamp.ts: buildTable). */
function tableOf(lane: AutomationLane): RateTable {
  const known = tables.get(lane);
  if (known) return known;
  const pts = lane.points;
  const ts: number[] = [0];
  const ss: number[] = [0];
  const push = (t: number): void => {
    const prevT = ts[ts.length - 1]!;
    if (t <= prevT) return;
    ts.push(t);
    ss.push(ss[ss.length - 1]! + ((sampleLane(lane, prevT, 'log') + sampleLane(lane, t, 'log')) / 2) * (t - prevT));
  };
  push(Math.max(0, pts[0]!.t));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!.t;
    const b = pts[i]!.t;
    if (b <= 0) continue;
    for (let k = 1; k <= CELLS; k++) push(Math.max(a, 0) + ((b - a) * k) / CELLS);
  }
  const table = { ts: Float64Array.from(ts), ss: Float64Array.from(ss), firstRate: pts[0]!.v, lastRate: pts[pts.length - 1]!.v };
  tables.set(lane, table);
  return table;
}

function interpolate(xs: Float64Array, ys: Float64Array, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo]! + ((ys[hi]! - ys[lo]!) * (x - xs[lo]!)) / (xs[hi]! - xs[lo]!);
}

export function rateAt(spec: RateSpec, t: number): number {
  return typeof spec === 'number' ? spec : sampleLane(spec, t, 'log');
}

/** The seconds of the source clip-local time `t` has consumed: the integral of the rate. */
export function sourceTimeAt(spec: RateSpec, t: number): number {
  if (typeof spec === 'number') return t * spec;
  const { ts, ss, firstRate, lastRate } = tableOf(spec);
  const last = ts.length - 1;
  if (t <= 0) return t * firstRate;
  if (t >= ts[last]!) return ss[last]! + (t - ts[last]!) * lastRate;
  return interpolate(ts, ss, t);
}

/** The inverse of `sourceTimeAt`: the clip-local time at which `source` seconds have been consumed. */
export function timeAtSourceTime(spec: RateSpec, source: number): number {
  if (typeof spec === 'number') return source / spec;
  const { ts, ss, firstRate, lastRate } = tableOf(spec);
  const last = ts.length - 1;
  if (source <= 0) return source / firstRate;
  if (source >= ss[last]!) return ts[last]! + (source - ss[last]!) / lastRate;
  return interpolate(ss, ts, source);
}

/** The gain a volume lane asks for at clip-local `t`, times the clip's `data-volume`, capped at +12 dB (audioGain.ts: gainTimesLane). */
export function laneGain(lane: AutomationLane, gain: number, t: number): number {
  const g = Number.isFinite(gain) ? Math.max(0, Math.min(MAX_GAIN, gain)) : 1;
  return Math.max(0, Math.min(MAX_GAIN, g * sampleLane(lane, t)));
}
