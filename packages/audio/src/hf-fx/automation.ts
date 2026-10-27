// HyperFrames' effect lanes, the `fx.<node>.<param>` and `fx.preset.<id>` lanes of `data-automation` (Apache-2.0,
// heygen-com/hyperframes; packages/core/src/audioAutomation.ts for the format and the curve shapes,
// packages/core/src/audio/audioFxAutomation.ts for the scheduling). A lane is played as AudioParam events, the way
// HyperFrames' offline render plays it: a straight segment is a linear ramp, a bent or log-scaled one a value curve at
// 100 points a second. Changed from the original: only the effect lanes (the `volume` and `rate` lanes are applied by
// the HyperFrames runtime in @kinetographdev/core), and no rescheduling, which only a live preview needs.

import type { AudioParam } from 'node-web-audio-api';
import { fxDef, type FxChain } from './chain.js';

export interface LanePoint {
  t: number;
  v: number;
  curve?: number;
  viaX?: number;
  viaY?: number;
}
export interface Lane {
  target: string;
  points: LanePoint[];
}
interface Range {
  min: number;
  max: number;
  scale: 'linear' | 'log';
}

type Target = { kind: 'fx'; nodeId: string; param: string } | { kind: 'preset'; presetId: string } | { kind: 'other' };

function parseTarget(target: string): Target | null {
  if (target === 'volume' || target === 'rate') return { kind: 'other' };
  const parts = target.split('.');
  if (parts.length !== 3 || parts[0] !== 'fx' || !parts[1] || !parts[2]) return null;
  return parts[1] === 'preset' ? { kind: 'preset', presetId: parts[2] } : { kind: 'fx', nodeId: parts[1], param: parts[2] };
}

function rangeOf(target: Target, chain: FxChain): Range | null {
  if (target.kind === 'preset') return chain.nodes.some((n) => n.fromPreset === target.presetId) ? { min: 0, max: 1, scale: 'linear' } : null;
  if (target.kind !== 'fx') return null;
  const node = chain.nodes.find((n) => n.id === target.nodeId);
  const param = node ? fxDef(node.type)?.params.find((p) => p.key === target.param) : undefined;
  if (!param || param.kind !== 'number') return null;
  return { min: param.min, max: param.max, scale: param.scale === 'log' && param.min > 0 ? 'log' : 'linear' };
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

function cleanPoints(raw: unknown[], range: Range): LanePoint[] {
  const clean: LanePoint[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const t = finite(item?.t);
    const v = finite(item?.v);
    if (t === null || v === null) continue;
    const curve = finite(item?.curve);
    const bend = via(item?.viaX, item?.viaY);
    clean.push({
      t: Math.max(0, t),
      v: Math.min(range.max, Math.max(range.min, v)),
      ...(curve ? { curve: Math.min(1, Math.max(-1, curve)) } : {}),
      ...(bend ? { viaX: bend.x, viaY: bend.y } : {}),
    });
  }
  clean.sort((a, b) => a.t - b.t);
  const out: LanePoint[] = [];
  for (const p of clean) {
    if (out.length > 0 && out[out.length - 1]!.t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out.slice(0, 512);
}

export class AutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationError';
  }
}

/**
 * The effect lanes of a `data-automation` value, bound to `chain`: each clamped to its parameter's range, a lane whose
 * node or parameter is not in the chain dropped (audioAutomation.ts: parseAutomation, resolveAutomation). Throws where
 * HyperFrames' reader throws (bad JSON, a version other than 1, a lane with an unreadable target or no points array).
 */
export function parseFxLanes(json: string, chain: FxChain): Lane[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new AutomationError(`the automation is not valid JSON: ${(error as Error).message}`);
  }
  const obj = raw as { version?: unknown; lanes?: unknown } | null;
  if (typeof obj !== 'object' || obj === null) throw new AutomationError('the automation must be a JSON object');
  if (obj.version !== 1) throw new AutomationError(`unsupported automation version: ${String(obj.version)}`);
  if (!Array.isArray(obj.lanes)) throw new AutomationError('the automation has no `lanes` array');
  const lanes: Lane[] = [];
  obj.lanes.forEach((l: unknown, i: number) => {
    const lane = l as { target?: unknown; points?: unknown } | null;
    const target = typeof lane?.target === 'string' ? parseTarget(lane.target) : null;
    if (target === null) throw new AutomationError(`lane ${i} has an unreadable target: ${String(lane?.target)}`);
    if (!Array.isArray(lane!.points)) throw new AutomationError(`lane ${i} has no \`points\` array`);
    const range = rangeOf(target, chain);
    if (range === null) return;
    const points = cleanPoints(lane!.points, range);
    if (points.length > 0) lanes.push({ target: lane!.target as string, points });
  });
  return lanes;
}

// ---- the shape of a segment (audioAutomation.ts: applyCurve, viaConic, shapeVia) ----

function shapeVia(x: number, viaX: number, viaY: number): number {
  const dx = viaX - 0.5;
  const dy = viaY - 0.5;
  const edge = 0.999;
  const needX = dx > 0 ? dx / (edge - viaX) : dx < 0 ? -dx / (viaX - (1 - edge)) : 0;
  const needY = dy > 0 ? dy / (edge - viaY) : dy < 0 ? -dy / (viaY - (1 - edge)) : 0;
  const w = Math.min(1e6, Math.max(1, needX, needY));
  const cx = viaX + dx / w;
  const cy = viaY + dy / w;
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

const bent = (p: LanePoint): boolean => Boolean(p.curve) || (p.viaX !== undefined && p.viaY !== undefined);

function progress(x: number, p: LanePoint): number {
  if (p.viaX !== undefined && p.viaY !== undefined) return shapeVia(Math.min(1, Math.max(0, x)), p.viaX, p.viaY);
  return p.curve ? Math.pow(x, Math.pow(2, 2 * p.curve)) : x;
}

/** The lane at clip-local `t`; it holds its first value before the first point and its last after the last. */
export function sampleLane(lane: Lane, t: number, scale: 'linear' | 'log' = 'linear'): number {
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
  const x = progress((t - a.t) / span, a);
  return scale === 'log' && a.v > 0 && b.v > 0 ? Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * x) : a.v + (b.v - a.v) * x;
}

// ---- scheduling (audioFxAutomation.ts) ----

/** Where an automation lane writes: an AudioParam, and the map from the knob's unit to the param's. */
export interface ParamTarget {
  param: AudioParam;
  map?: (value: number) => number;
}

/** Where the lane's clock is in the context: at context time `scheduledAt`, the lane is at `elapsed` seconds. */
export interface LaneTiming {
  scheduledAt: number;
  elapsed: number;
}

const POINTS_PER_SECOND = 100;

type Op =
  | { kind: 'set'; time: number; value: number }
  | { kind: 'ramp'; time: number; value: number }
  | { kind: 'curve'; time: number; duration: number; values: Float32Array };

function planOps(lane: Lane, scale: 'linear' | 'log', timing: LaneTiming, map: ((v: number) => number) | undefined): Op[] {
  const apply = map ?? ((v: number) => v);
  const toCtx = (t: number): number => timing.scheduledAt + (t - timing.elapsed);
  const ops: Op[] = [];
  for (let i = 0; i + 1 < lane.points.length; i++) {
    const a = lane.points[i]!;
    const b = lane.points[i + 1]!;
    const toTime = toCtx(b.t);
    if (toTime <= timing.scheduledAt) continue;
    const fromTime = Math.max(timing.scheduledAt, toCtx(a.t));
    const duration = toTime - fromTime;
    if (duration <= 0) continue;
    if (!bent(a) && scale === 'linear' && !map) {
      ops.push({ kind: 'ramp', time: toTime, value: b.v });
      continue;
    }
    const count = Math.min(4096, Math.max(8, Math.ceil(duration * POINTS_PER_SECOND)));
    const from = Math.max(a.t, timing.elapsed);
    const values = new Float32Array(count);
    for (let k = 0; k < count; k++) values[k] = apply(sampleLane(lane, from + ((b.t - from) * k) / (count - 1), scale));
    ops.push({ kind: 'curve', time: fromTime, duration, values });
  }
  const first = ops[0];
  if (!(first?.kind === 'curve' && first.time <= timing.scheduledAt)) {
    ops.unshift({ kind: 'set', time: timing.scheduledAt, value: apply(sampleLane(lane, timing.elapsed, scale)) });
  }
  return ops;
}

function emit(param: AudioParam, ops: Op[]): void {
  for (const op of ops) {
    if (op.kind === 'set') param.setValueAtTime(op.value, op.time);
    else if (op.kind === 'ramp') param.linearRampToValueAtTime(op.value, op.time);
    else {
      try {
        param.setValueCurveAtTime(op.values, op.time, op.duration);
      } catch {
        // A curve that overlaps the next event is refused: the whole lane as ramps instead (audioFxAutomation.ts: emitRamps).
        param.cancelScheduledValues(0);
        for (const o of ops) {
          if (o.kind === 'set') param.setValueAtTime(o.value, o.time);
          else if (o.kind === 'ramp') param.linearRampToValueAtTime(o.value, o.time);
          else {
            param.setValueAtTime(o.values[0] ?? 0, o.time);
            param.linearRampToValueAtTime(o.values[o.values.length - 1] ?? 0, o.time + o.duration);
          }
        }
        return;
      }
    }
  }
}

/** Schedules every effect lane onto the built chain; a lane with no AudioParam behind it (a worklet's knob) is inert, as in HyperFrames. */
export function scheduleLanes(
  lanes: readonly Lane[],
  chain: FxChain,
  nodes: readonly { id?: string; automation?: Record<string, ParamTarget[]> }[],
  presets: Record<string, ParamTarget[]>,
  timing: LaneTiming,
): void {
  const byId = new Map(nodes.filter((n) => n.id).map((n) => [n.id!, n]));
  for (const lane of lanes) {
    const target = parseTarget(lane.target);
    if (target === null || target.kind === 'other') continue;
    const targets = target.kind === 'preset' ? presets[target.presetId] : byId.get(target.nodeId)?.automation?.[target.param];
    const range = rangeOf(target, chain);
    if (!targets || targets.length === 0 || range === null) continue;
    const constant = lane.points.every((p) => p.v === lane.points[0]!.v);
    for (const t of targets) {
      t.param.cancelScheduledValues(0);
      // node-web-audio-api plays a value set by `.value` (as the builders set every knob) through the first render
      // quantum even with an event at time 0, where Chrome plays the event: so the knob starts at the lane's value.
      t.param.value = (t.map ?? ((v: number) => v))(sampleLane(lane, timing.elapsed, range.scale));
      if (constant) t.param.setValueAtTime((t.map ?? ((v: number) => v))(lane.points[0]!.v), timing.scheduledAt);
      else emit(t.param, planOps(lane, range.scale, timing, t.map));
    }
  }
}

/** The largest value a lane on `target` reaches, or null without one (audioFxTail.ts: knobMax). */
export function laneMax(lanes: readonly Lane[], target: string): number | null {
  const lane = lanes.find((l) => l.target === target);
  return lane ? lane.points.reduce((max, p) => Math.max(max, p.v), -Infinity) : null;
}
