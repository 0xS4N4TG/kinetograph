// SVG path data: parsed to absolute segments, transformed by an affine map, written back. Arcs become cubic curves
// (so that a map which is not a similarity keeps them round), which the scene's `path` takes like any other.

import { r3 } from './util.js';

/** `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f (SVG's `matrix(a b c d e f)`). */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m` applied after `n`: the matrix of `m n`. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export function isIdentityAffine(m: Affine): boolean {
  return near(m[0], 1) && near(m[1], 0) && near(m[2], 0) && near(m[3], 1) && near(m[4], 0) && near(m[5], 0);
}

/** A rotation, a uniform scale and a translation: `translate(e, f) rotate(angle) scale(scale)`; null otherwise. */
export function similarity(m: Affine): { x: number; y: number; rotation: number; scale: number } | null {
  if (!near(m[0], m[3]) || !near(m[1], -m[2])) return null;
  const scale = Math.hypot(m[0], m[1]);
  if (scale === 0) return null;
  return { x: m[4], y: m[5], rotation: (Math.atan2(m[1], m[0]) * 180) / Math.PI, scale };
}

const COUNTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

type Segment =
  | { c: 'M' | 'L'; p: [number, number] }
  | { c: 'C'; p: [number, number, number, number, number, number] }
  | { c: 'Q'; p: [number, number, number, number] }
  | { c: 'Z' };

function tokens(d: string): (string | number)[] | null {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)/y;
  let at = 0;
  while (at < d.length) {
    re.lastIndex = at;
    const m = re.exec(d);
    if (!m) return null;
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(Number(m[2]));
    at = re.lastIndex;
  }
  return out;
}

/** Arc flags may be written without separators ("a1 1 0 00.5.5"), which the number regex above does not split. */
function expandArcFlags(d: string): string {
  return d.replace(/([Aa])([^A-Za-z]*)/g, (_all, cmd: string, rest: string) => {
    // Re-read the arguments seven at a time: the 4th and 5th are single-digit flags.
    const parts: string[] = [];
    let text = rest.trim();
    while (text.length > 0) {
      const args: string[] = [];
      for (let i = 0; i < 7 && text.length > 0; i += 1) {
        text = text.replace(/^[\s,]+/, '');
        const flag = i === 3 || i === 4;
        const m = (flag ? /^[01]/ : /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/).exec(text);
        if (!m) return cmd + rest;
        args.push(m[0]);
        text = text.slice(m[0].length);
      }
      parts.push(args.join(' '));
      text = text.replace(/^[\s,]+/, '');
    }
    return `${cmd}${parts.join(` ${cmd} `)}`;
  });
}

/** The cubic curves of an elliptical arc (endpoint form, SVG implementation notes F.6.5). */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
): Segment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [{ c: 'L', p: [x, y] }];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1) / ry;
  const cyp = (-coef * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Segment[] = [];
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  ];
  const derivative = (t: number): [number, number] => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  ];
  for (let i = 0; i < count; i += 1) {
    const a = theta1 + i * step;
    const b = a + step;
    const p0 = point(a);
    const p3 = i === count - 1 ? ([x, y] as [number, number]) : point(b);
    const d0 = derivative(a);
    const d3 = derivative(b);
    out.push({ c: 'C', p: [p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]] });
  }
  return out;
}

/** Path data as absolute segments, or null when it does not parse. */
export function parsePath(d: string): Segment[] | null {
  const list = tokens(expandArcFlags(d));
  if (list === null || list.length === 0) return null;
  const out: Segment[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // The last control point, for smooth curves.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  let command = '';
  let first = true;
  while (i < list.length) {
    const t = list[i]!;
    if (typeof t === 'string') {
      command = t;
      i += 1;
    } else if (command === '') {
      return null;
    }
    const lower = command.toLowerCase();
    const relative = command === lower;
    const n = COUNTS[lower];
    if (n === undefined) return null;
    if (first && lower !== 'm') return null;
    first = false;
    if (lower === 'z') {
      out.push({ c: 'Z' });
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      continue;
    }
    const args: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const v = list[i + k];
      if (typeof v !== 'number') return null;
      args.push(v);
    }
    i += n;
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    switch (lower) {
      case 'm':
        cx = args[0]! + ox;
        cy = args[1]! + oy;
        sx = cx;
        sy = cy;
        out.push({ c: 'M', p: [cx, cy] });
        // Further pairs are implicit lineto's.
        command = relative ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      case 'l':
        cx = args[0]! + ox;
        cy = args[1]! + oy;
        out.push({ c: 'L', p: [cx, cy] });
        lastC = lastQ = null;
        break;
      case 'h':
        cx = args[0]! + ox;
        out.push({ c: 'L', p: [cx, cy] });
        lastC = lastQ = null;
        break;
      case 'v':
        cy = args[0]! + oy;
        out.push({ c: 'L', p: [cx, cy] });
        lastC = lastQ = null;
        break;
      case 'c': {
        const p: [number, number, number, number, number, number] = [args[0]! + ox, args[1]! + oy, args[2]! + ox, args[3]! + oy, args[4]! + ox, args[5]! + oy];
        out.push({ c: 'C', p });
        lastC = [p[2], p[3]];
        lastQ = null;
        cx = p[4];
        cy = p[5];
        break;
      }
      case 's': {
        const r1: [number, number] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        const p: [number, number, number, number, number, number] = [r1[0], r1[1], args[0]! + ox, args[1]! + oy, args[2]! + ox, args[3]! + oy];
        out.push({ c: 'C', p });
        lastC = [p[2], p[3]];
        lastQ = null;
        cx = p[4];
        cy = p[5];
        break;
      }
      case 'q': {
        const p: [number, number, number, number] = [args[0]! + ox, args[1]! + oy, args[2]! + ox, args[3]! + oy];
        out.push({ c: 'Q', p });
        lastQ = [p[0], p[1]];
        lastC = null;
        cx = p[2];
        cy = p[3];
        break;
      }
      case 't': {
        const c1: [number, number] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        const p: [number, number, number, number] = [c1[0], c1[1], args[0]! + ox, args[1]! + oy];
        out.push({ c: 'Q', p });
        lastQ = c1;
        lastC = null;
        cx = p[2];
        cy = p[3];
        break;
      }
      case 'a': {
        const [rx, ry, rot, large, sweep] = args as [number, number, number, number, number, number, number];
        const x = args[5]! + ox;
        const y = args[6]! + oy;
        out.push(...arcToCubics(cx, cy, rx, ry, rot, large !== 0, sweep !== 0, x, y));
        cx = x;
        cy = y;
        lastC = lastQ = null;
        break;
      }
    }
  }
  return out;
}

/** Path data written from segments after `m` is applied. */
export function writePath(segments: readonly Segment[], m: Affine = IDENTITY): string {
  const pt = (x: number, y: number): string => {
    const [px, py] = applyAffine(m, x, y);
    return `${r3(px)} ${r3(py)}`;
  };
  return segments
    .map((s) => {
      switch (s.c) {
        case 'M':
        case 'L':
          return `${s.c}${pt(s.p[0], s.p[1])}`;
        case 'C':
          return `C${pt(s.p[0], s.p[1])} ${pt(s.p[2], s.p[3])} ${pt(s.p[4], s.p[5])}`;
        case 'Q':
          return `Q${pt(s.p[0], s.p[1])} ${pt(s.p[2], s.p[3])}`;
        case 'Z':
          return 'Z';
      }
    })
    .join(' ');
}

/** `d` with `m` applied to every point; null when it does not parse. */
export function transformPath(d: string, m: Affine): string | null {
  const segments = parsePath(d);
  return segments === null ? null : writePath(segments, m);
}

/** SVG's `transform` attribute: a list of translate, scale, rotate, skewX, skewY and matrix, as one matrix; null when
 *  it does not parse. */
export function parseSvgTransform(value: string): Affine | null {
  let m: Affine = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let at = 0;
  const text = value.trim();
  if (text === '') return IDENTITY;
  while (at < text.length) {
    re.lastIndex = at;
    const found = re.exec(text);
    if (!found) return null;
    at = re.lastIndex;
    const args = found[2]!.trim().split(/[\s,]+/).filter((s) => s !== '').map(Number);
    if (args.some((n) => !Number.isFinite(n))) return null;
    let next: Affine;
    switch (found[1]) {
      case 'matrix':
        if (args.length !== 6) return null;
        next = args as Affine;
        break;
      case 'translate':
        if (args.length < 1 || args.length > 2) return null;
        next = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
        break;
      case 'scale':
        if (args.length < 1 || args.length > 2) return null;
        next = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
        break;
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) return null;
        const a = (args[0]! * Math.PI) / 180;
        const rot: Affine = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        next =
          args.length === 3
            ? multiply(multiply([1, 0, 0, 1, args[1]!, args[2]!], rot), [1, 0, 0, 1, -args[1]!, -args[2]!])
            : rot;
        break;
      }
      case 'skewX':
        if (args.length !== 1) return null;
        next = [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        if (args.length !== 1) return null;
        next = [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, next);
  }
  return m;
}
