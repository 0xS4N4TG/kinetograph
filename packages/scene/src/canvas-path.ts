// Paths for the Canvas 2D context (`canvas.ts`): the geometry of `arc`, `arcTo`, `ellipse` and `roundRect` as cubic
// curves, `Path2D`, and SVG path data in and out. A canvas path is a list of absolute segments in the space the
// builder keeps them in; `pathData` writes them as the SVG path data the canvas layer takes.

import type { CanvasMatrix } from './types.js';

export type Matrix = CanvasMatrix;

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n` applied to a point: the product `m * n`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The inverse of `m`, or null when it flattens the plane. */
export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The error a canvas throws for a bad argument (`IndexSizeError`, `SyntaxError`, ...). */
export function domError(message: string, name: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

export type Segment =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Q', number, number, number, number]
  | readonly ['Z'];

function mapSegment(segment: Segment, m: Matrix): Segment {
  const out: [string, ...number[]] = [segment[0]];
  for (let i = 1; i < segment.length; i += 2) {
    const [x, y] = apply(m, segment[i] as number, segment[i + 1] as number);
    out.push(x, y);
  }
  return out as unknown as Segment;
}

/** A number as short path data: four decimals are well under a hundredth of a pixel, and `-0` is `0`. */
function num(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(rounded === 0 ? 0 : rounded);
}

/** SVG path data of `segments`, each point taken through `m` when given. */
export function pathData(segments: readonly Segment[], m?: Matrix): string {
  let out = '';
  for (const segment of segments) {
    const s = m === undefined ? segment : mapSegment(segment, m);
    out += s[0] + s.slice(1).map((v) => num(v as number)).join(' ');
  }
  return out;
}

const isFinite2 = (...values: number[]): boolean => values.every(Number.isFinite);

/**
 * Cubic curves for the arc of an ellipse centred at `(cx, cy)` with radii `rx`, `ry` turned by `rotation`, from angle
 * `start` through `delta` radians (negative turns the other way), in at most quarter turns. The path must already be
 * at the arc's start.
 */
function arcSegments(cx: number, cy: number, rx: number, ry: number, rotation: number, start: number, delta: number): Segment[] {
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const point = (u: number, v: number): [number, number] => [cx + cos * rx * u - sin * ry * v, cy + sin * rx * u + cos * ry * v];
  const out: Segment[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t0 = start + i * step;
    const t1 = t0 + step;
    const [x1, y1] = point(Math.cos(t0) - k * Math.sin(t0), Math.sin(t0) + k * Math.cos(t0));
    const [x2, y2] = point(Math.cos(t1) + k * Math.sin(t1), Math.sin(t1) - k * Math.cos(t1));
    const [x, y] = point(Math.cos(t1), Math.sin(t1));
    out.push(['C', x1, y1, x2, y2, x, y]);
  }
  return out;
}

/** The sweep of `ellipse()` from `start` to `end`, a full turn at most, as the canvas spec normalises it. */
function sweepOf(start: number, end: number, counterclockwise: boolean): number {
  const turn = Math.PI * 2;
  const delta = end - start;
  if (!counterclockwise) {
    if (delta >= turn) return turn;
    return ((delta % turn) + turn) % turn;
  }
  if (-delta >= turn) return -turn;
  return -((((-delta) % turn) + turn) % turn);
}

type Radius = { x: number; y: number };

function cornerRadii(radii: unknown): Radius[] {
  const list = Array.isArray(radii) ? radii : typeof radii === 'object' && radii !== null && Symbol.iterator in radii ? [...(radii as Iterable<unknown>)] : [radii];
  if (list.length < 1 || list.length > 4) throw new RangeError(`roundRect: ${list.length} radii; it takes one to four`);
  const one = (value: unknown): Radius => {
    if (typeof value === 'number') return { x: value, y: value };
    if (typeof value === 'object' && value !== null) {
      const { x = 0, y = 0 } = value as { x?: number; y?: number };
      return { x: Number(x), y: Number(y) };
    }
    return { x: Number(value), y: Number(value) };
  };
  const r = list.map(one);
  for (const { x, y } of r) {
    if (!isFinite2(x, y)) return [];
    if (x < 0 || y < 0) throw new RangeError('roundRect: a radius must not be negative');
  }
  // top left, top right, bottom right, bottom left.
  if (r.length === 1) return [r[0]!, r[0]!, r[0]!, r[0]!];
  if (r.length === 2) return [r[0]!, r[1]!, r[0]!, r[1]!];
  if (r.length === 3) return [r[0]!, r[1]!, r[2]!, r[1]!];
  return r;
}

/**
 * A path as the canvas builds one. Calls take coordinates in the space `space` maps into the space the segments are
 * kept in (a context's current transform; the identity for a `Path2D`).
 */
export class PathBuilder {
  /** Segments, in the builder's own space. */
  segments: Segment[] = [];
  /** Takes the space of a call's coordinates to the builder's. */
  space: Matrix = IDENTITY;
  protected current: [number, number] | null = null;
  protected begin: [number, number] | null = null;

  protected add(...segments: Segment[]): void {
    this.segments.push(...segments);
    const last = segments[segments.length - 1];
    if (last && last[0] !== 'Z') this.current = [last[last.length - 2] as number, last[last.length - 1] as number];
  }

  protected map(x: number, y: number): [number, number] {
    return apply(this.space, x, y);
  }

  moveTo(x: number, y: number): void {
    if (!isFinite2(x, y)) return;
    const [px, py] = this.map(x, y);
    this.add(['M', px, py]);
    this.begin = [px, py];
  }

  lineTo(x: number, y: number): void {
    if (!isFinite2(x, y)) return;
    if (this.current === null) return this.moveTo(x, y);
    const [px, py] = this.map(x, y);
    this.add(['L', px, py]);
  }

  closePath(): void {
    if (this.current === null || this.begin === null) return;
    this.segments.push(['Z']);
    this.current = this.begin;
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!isFinite2(c1x, c1y, c2x, c2y, x, y)) return;
    if (this.current === null) this.moveTo(c1x, c1y);
    const [a, b] = this.map(c1x, c1y);
    const [c, d] = this.map(c2x, c2y);
    const [e, f] = this.map(x, y);
    this.add(['C', a, b, c, d, e, f]);
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!isFinite2(cx, cy, x, y)) return;
    if (this.current === null) this.moveTo(cx, cy);
    const [a, b] = this.map(cx, cy);
    const [c, d] = this.map(x, y);
    this.add(['Q', a, b, c, d]);
  }

  rect(x: number, y: number, width: number, height: number): void {
    if (!isFinite2(x, y, width, height)) return;
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.closePath();
  }

  roundRect(x: number, y: number, width: number, height: number, radii: unknown = 0): void {
    if (!isFinite2(x, y, width, height)) return;
    const r = cornerRadii(radii);
    if (r.length === 0) return;
    // A negative side runs the other way: the corners swap with their neighbours.
    let [tl, tr, br, bl] = r as [Radius, Radius, Radius, Radius];
    if (width < 0) {
      x += width;
      width = -width;
      [tl, tr, br, bl] = [tr, tl, bl, br];
    }
    if (height < 0) {
      y += height;
      height = -height;
      [tl, tr, br, bl] = [bl, br, tr, tl];
    }
    const fit = Math.min(
      tl.x + tr.x > 0 ? width / (tl.x + tr.x) : Infinity,
      bl.x + br.x > 0 ? width / (bl.x + br.x) : Infinity,
      tl.y + bl.y > 0 ? height / (tl.y + bl.y) : Infinity,
      tr.y + br.y > 0 ? height / (tr.y + br.y) : Infinity,
      1,
    );
    const scaled = (c: Radius): Radius => ({ x: c.x * fit, y: c.y * fit });
    [tl, tr, br, bl] = [scaled(tl), scaled(tr), scaled(br), scaled(bl)];
    const corner = (cx: number, cy: number, c: Radius, from: number, atx: number, aty: number): void => {
      if (c.x === 0 || c.y === 0) return this.lineTo(atx, aty);
      this.addArc(cx, cy, c.x, c.y, 0, from, Math.PI / 2);
    };
    this.moveTo(x + tl.x, y);
    this.lineTo(x + width - tr.x, y);
    corner(x + width - tr.x, y + tr.y, tr, -Math.PI / 2, x + width, y);
    this.lineTo(x + width, y + height - br.y);
    corner(x + width - br.x, y + height - br.y, br, 0, x + width, y + height);
    this.lineTo(x + bl.x, y + height);
    corner(x + bl.x, y + height - bl.y, bl, Math.PI / 2, x, y + height);
    this.lineTo(x, y + tl.y);
    corner(x + tl.x, y + tl.y, tl, Math.PI, x, y);
    this.closePath();
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    this.ellipse(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise);
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    if (!isFinite2(x, y, radiusX, radiusY, rotation, startAngle, endAngle)) return;
    if (radiusX < 0 || radiusY < 0) throw domError('The radius provided is negative.', 'IndexSizeError');
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const sx = radiusX * Math.cos(startAngle);
    const sy = radiusY * Math.sin(startAngle);
    this.lineTo(x + cos * sx - sin * sy, y + sin * sx + cos * sy);
    const delta = sweepOf(startAngle, endAngle, counterclockwise);
    if (delta === 0 || radiusX === 0 || radiusY === 0) return;
    this.addArc(x, y, radiusX, radiusY, rotation, startAngle, delta);
  }

  /** The curves of an arc, joined on at the current point (which is its start). */
  protected addArc(cx: number, cy: number, rx: number, ry: number, rotation: number, start: number, delta: number): void {
    const user = arcSegments(cx, cy, rx, ry, rotation, start, delta);
    this.add(...user.map((s) => mapSegment(s, this.space)));
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!isFinite2(x1, y1, x2, y2, radius)) return;
    if (radius < 0) throw domError('The radius provided is negative.', 'IndexSizeError');
    if (this.current === null) return this.moveTo(x1, y1);
    const back = invert(this.space);
    if (back === null) return this.lineTo(x1, y1);
    const [x0, y0] = apply(back, this.current[0], this.current[1]);
    const [ax, ay] = [x0 - x1, y0 - y1];
    const [bx, by] = [x2 - x1, y2 - y1];
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    // The same point twice, no radius, or three points in a line: the corner is not rounded.
    if (la === 0 || lb === 0 || radius === 0 || Math.abs(cross) < 1e-9 * la * lb) return this.lineTo(x1, y1);
    const [ux, uy] = [ax / la, ay / la];
    const [vx, vy] = [bx / lb, by / lb];
    const angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    const tangent = radius / Math.tan(angle / 2);
    const [t1x, t1y] = [x1 + ux * tangent, y1 + uy * tangent];
    const [t2x, t2y] = [x1 + vx * tangent, y1 + vy * tangent];
    const [bisx, bisy] = [ux + vx, uy + vy];
    const bis = Math.hypot(bisx, bisy);
    const away = radius / Math.sin(angle / 2);
    const [cx, cy] = [x1 + (bisx / bis) * away, y1 + (bisy / bis) * away];
    this.lineTo(t1x, t1y);
    const a1 = Math.atan2(t1y - cy, t1x - cx);
    const a2 = Math.atan2(t2y - cy, t2x - cx);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.addArc(cx, cy, radius, radius, 0, a1, delta);
  }
}

// ---- SVG path data ----

/** The segments of SVG path data in absolute coordinates, arcs as curves. Parsing stops at the first error, as a browser's does. */
export function parseSvgPath(d: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  const skip = (): void => {
    while (at < d.length && /[\s,]/.test(d[at]!)) at += 1;
  };
  const number = (): number | null => {
    skip();
    const m = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(d.slice(at));
    if (!m) return null;
    at += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number | null => {
    skip();
    const c = d[at];
    if (c !== '0' && c !== '1') return null;
    at += 1;
    return Number(c);
  };
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let previous = '';
  let ctrl: [number, number] | null = null;
  let command = '';
  for (;;) {
    skip();
    if (at >= d.length) break;
    if (/[a-zA-Z]/.test(d[at]!)) {
      command = d[at]!;
      at += 1;
    } else if (command === '' || command === 'Z' || command === 'z') {
      break;
    } else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';
    if (!/^[MmLlHhVvCcSsQqTtAaZz]$/.test(command)) break;
    const rel = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const read = (count: number): number[] | null => {
      const values: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const v = number();
        if (v === null) return null;
        values.push(v);
      }
      return values;
    };
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    let next: [number, number] | null = null;
    if (upper === 'Z') {
      out.push(['Z']);
      [x, y] = [sx, sy];
      ctrl = null;
      previous = 'Z';
      continue;
    }
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      const v = read(2);
      if (!v) break;
      const [px, py] = [v[0]! + ox, v[1]! + oy];
      if (upper === 'M') {
        out.push(['M', px, py]);
        [sx, sy] = [px, py];
        ctrl = null;
      } else if (upper === 'L') {
        out.push(['L', px, py]);
        ctrl = null;
      } else {
        const c: [number, number] = previous === 'Q' || previous === 'T' ? [2 * x - ctrl![0], 2 * y - ctrl![1]] : [x, y];
        out.push(['Q', c[0], c[1], px, py]);
        ctrl = c;
      }
      next = [px, py];
    } else if (upper === 'H' || upper === 'V') {
      const v = read(1);
      if (!v) break;
      const px = upper === 'H' ? v[0]! + ox : x;
      const py = upper === 'V' ? v[0]! + oy : y;
      out.push(['L', px, py]);
      next = [px, py];
      ctrl = null;
    } else if (upper === 'C' || upper === 'S') {
      const v = read(upper === 'C' ? 6 : 4);
      if (!v) break;
      const first: [number, number] = upper === 'S' ? (previous === 'C' || previous === 'S' ? [2 * x - ctrl![0], 2 * y - ctrl![1]] : [x, y]) : [v[0]! + ox, v[1]! + oy];
      const rest = upper === 'S' ? v : v.slice(2);
      out.push(['C', first[0], first[1], rest[0]! + ox, rest[1]! + oy, rest[2]! + ox, rest[3]! + oy]);
      ctrl = [rest[0]! + ox, rest[1]! + oy];
      next = [rest[2]! + ox, rest[3]! + oy];
    } else if (upper === 'Q') {
      const v = read(4);
      if (!v) break;
      out.push(['Q', v[0]! + ox, v[1]! + oy, v[2]! + ox, v[3]! + oy]);
      ctrl = [v[0]! + ox, v[1]! + oy];
      next = [v[2]! + ox, v[3]! + oy];
    } else {
      const head = read(3);
      if (!head) break;
      const fa = flag();
      if (fa === null) break;
      const fs = flag();
      if (fs === null) break;
      const tail = read(2);
      if (!tail) break;
      const [px, py] = [tail[0]! + ox, tail[1]! + oy];
      out.push(...svgArc(x, y, head[0]!, head[1]!, head[2]!, fa === 1, fs === 1, px, py));
      next = [px, py];
      ctrl = null;
    }
    [x, y] = next!;
    previous = upper;
  }
  return out;
}

/** An SVG elliptical arc from `(x1, y1)` to `(x2, y2)` as cubic curves (SVG 1.1, F.6.5). */
function svgArc(x1: number, y1: number, rxIn: number, ryIn: number, degrees: number, large: boolean, sweep: boolean, x2: number, y2: number): Segment[] {
  let [rx, ry] = [Math.abs(rxIn), Math.abs(ryIn)];
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const [dx, dy] = [(x1 - x2) / 2, (y1 - y2) / 2];
  const [x1p, y1p] = [cos * dx + sin * dy, -sin * dx + cos * dy];
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const [cxp, cyp] = [(factor * rx * y1p) / ry, (-factor * ry * x1p) / rx];
  const [cx, cy] = [cos * cxp - sin * cyp + (x1 + x2) / 2, sin * cxp + cos * cyp + (y1 + y2) / 2];
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  return arcSegments(cx, cy, rx, ry, phi, theta, delta);
}

/** A `Path2D`: a path built apart from the context, drawn with `fill(path)`, `stroke(path)` and `clip(path)`. */
export class Path2D extends PathBuilder {
  constructor(path?: Path2D | string) {
    super();
    if (path instanceof Path2D) {
      this.segments = [...path.segments];
      this.current = path.current;
      this.begin = path.begin;
    } else if (typeof path === 'string') {
      const segments = parseSvgPath(path);
      for (const s of segments) {
        if (s[0] === 'M') this.begin = [s[1], s[2]];
      }
      this.segments = segments;
      let last: [number, number] | null = null;
      for (const s of segments) {
        if (s[0] === 'Z') last = this.begin;
        else last = [s[s.length - 2] as number, s[s.length - 1] as number];
      }
      this.current = last;
    }
  }

  /** Adds the segments of `path`, taken through `matrix` (an object with `a` to `f`) when given. */
  addPath(path: Path2D, matrix?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void {
    const m: Matrix = matrix ? [matrix.a ?? 1, matrix.b ?? 0, matrix.c ?? 0, matrix.d ?? 1, matrix.e ?? 0, matrix.f ?? 0] : IDENTITY;
    if (!m.every(Number.isFinite)) return;
    const moved = path.segments.map((s) => mapSegment(s, m));
    if (moved.length === 0) return;
    this.segments.push(...moved);
    const begin = path.begin === null ? null : apply(m, path.begin[0], path.begin[1]);
    const current = path.current === null ? null : apply(m, path.current[0], path.current[1]);
    this.begin = begin ?? this.begin;
    this.current = current ?? this.current;
  }
}
