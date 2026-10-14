// `@remotion/paths`: pure SVG path maths. Written from the documented behaviour
// of each function and checked against values recorded from the published
// package (test/fixtures/paths.json).
//
// Paths are parsed into instructions (relative ones kept as they are written),
// and most operations work on a reduced form that only has M, L, C and Z in
// absolute coordinates. A few things follow the published package rather than
// what one would guess; each is marked where it happens:
//  - `translatePath` leaves relative instructions alone (they move with the
//    path anyway, but a leading `m` does not move);
//  - `scalePath` and `reversePath` reduce the path first, so arcs, quadratics
//    and shorthands come back as cubics and lines;
//  - `reversePath` writes `Z` glued to the last number.

// ---- instruction types ----

export interface MoveTo { type: 'M'; x: number; y: number }
export interface LineTo { type: 'L'; x: number; y: number }
export interface Horizontal { type: 'H'; x: number }
export interface Vertical { type: 'V'; y: number }
export interface CurveTo { type: 'C'; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }
export interface SmoothCurveTo { type: 'S'; cpx: number; cpy: number; x: number; y: number }
export interface QuadTo { type: 'Q'; cpx: number; cpy: number; x: number; y: number }
export interface SmoothQuadTo { type: 'T'; x: number; y: number }
export interface ArcTo {
  type: 'A';
  rx: number;
  ry: number;
  xAxisRotation: number;
  largeArcFlag: boolean;
  sweepFlag: boolean;
  x: number;
  y: number;
}
export interface ClosePath { type: 'Z' }
export interface RelMoveTo { type: 'm'; dx: number; dy: number }
export interface RelLineTo { type: 'l'; dx: number; dy: number }
export interface RelHorizontal { type: 'h'; dx: number }
export interface RelVertical { type: 'v'; dy: number }
export interface RelCurveTo { type: 'c'; cp1dx: number; cp1dy: number; cp2dx: number; cp2dy: number; dx: number; dy: number }
export interface RelSmoothCurveTo { type: 's'; cpdx: number; cpdy: number; dx: number; dy: number }
export interface RelQuadTo { type: 'q'; cpdx: number; cpdy: number; dx: number; dy: number }
export interface RelSmoothQuadTo { type: 't'; dx: number; dy: number }
export interface RelArcTo {
  type: 'a';
  rx: number;
  ry: number;
  xAxisRotation: number;
  largeArcFlag: boolean;
  sweepFlag: boolean;
  dx: number;
  dy: number;
}

export type AbsoluteInstruction =
  | MoveTo | LineTo | Horizontal | Vertical | CurveTo | SmoothCurveTo | QuadTo | SmoothQuadTo | ArcTo | ClosePath;
export type RelativeInstruction =
  | RelMoveTo | RelLineTo | RelHorizontal | RelVertical | RelCurveTo | RelSmoothCurveTo | RelQuadTo | RelSmoothQuadTo | RelArcTo;
export type Instruction = AbsoluteInstruction | RelativeInstruction;
export type ReducedInstruction = MoveTo | LineTo | CurveTo | ClosePath;

export interface Point { x: number; y: number }

// ---- parsing ----

const ARGUMENT_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(d: string): { command: string; numbers: number[] }[] {
  const out: { command: string; numbers: number[] }[] = [];
  let i = 0;
  let current: { command: string; numbers: number[] } | null = null;
  while (i < d.length) {
    const ch = d[i]!;
    if (/\s|,/.test(ch)) {
      i++;
    } else if (/[a-zA-Z]/.test(ch)) {
      if (ARGUMENT_COUNT[ch.toUpperCase()] !== undefined) {
        current = { command: ch, numbers: [] };
        out.push(current);
      }
      // A letter that is not a command is skipped, and its numbers go to the command before it.
      i++;
    } else {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(d);
      if (!match) {
        i++;
        continue;
      }
      // An arc's two flags are single characters and may be written without a separator ("a1 1 0 011 1").
      const isArc = current !== null && current.command.toUpperCase() === 'A';
      const position = current ? current.numbers.length % 7 : 0;
      if (isArc && (position === 3 || position === 4) && (ch === '0' || ch === '1')) {
        current!.numbers.push(Number(ch));
        i++;
        continue;
      }
      current?.numbers.push(Number(match[0]));
      i += match[0].length;
    }
  }
  return out;
}

export function parsePath(path: string): Instruction[] {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('No path provided');
  const instructions: Instruction[] = [];
  for (const { command, numbers } of tokenize(path)) {
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const size = ARGUMENT_COUNT[upper]!;
    if (upper === 'Z') {
      instructions.push({ type: 'Z' });
      continue;
    }
    if (numbers.length === 0 || numbers.length % size !== 0) {
      throw new Error(
        `Malformed path data: ${command} was expected to have a multiple of ${size} numbers, but got "${command} ${numbers.join(' ')} instead"`,
      );
    }
    for (let k = 0; k < numbers.length; k += size) {
      const n = numbers.slice(k, k + size) as number[];
      // More pairs after a moveto are linetos.
      const type = k > 0 && upper === 'M' ? (relative ? 'l' : 'L') : relative ? upper.toLowerCase() : upper;
      instructions.push(makeInstruction(type, n));
    }
  }
  return instructions;
}

function makeInstruction(type: string, n: number[]): Instruction {
  switch (type) {
    case 'M': return { type, x: n[0]!, y: n[1]! };
    case 'L': return { type, x: n[0]!, y: n[1]! };
    case 'H': return { type, x: n[0]! };
    case 'V': return { type, y: n[0]! };
    case 'C': return { type, cp1x: n[0]!, cp1y: n[1]!, cp2x: n[2]!, cp2y: n[3]!, x: n[4]!, y: n[5]! };
    case 'S': return { type, cpx: n[0]!, cpy: n[1]!, x: n[2]!, y: n[3]! };
    case 'Q': return { type, cpx: n[0]!, cpy: n[1]!, x: n[2]!, y: n[3]! };
    case 'T': return { type, x: n[0]!, y: n[1]! };
    case 'A': return { type, rx: n[0]!, ry: n[1]!, xAxisRotation: n[2]!, largeArcFlag: n[3] !== 0, sweepFlag: n[4] !== 0, x: n[5]!, y: n[6]! };
    case 'm': return { type, dx: n[0]!, dy: n[1]! };
    case 'l': return { type, dx: n[0]!, dy: n[1]! };
    case 'h': return { type, dx: n[0]! };
    case 'v': return { type, dy: n[0]! };
    case 'c': return { type, cp1dx: n[0]!, cp1dy: n[1]!, cp2dx: n[2]!, cp2dy: n[3]!, dx: n[4]!, dy: n[5]! };
    case 's': return { type, cpdx: n[0]!, cpdy: n[1]!, dx: n[2]!, dy: n[3]! };
    case 'q': return { type, cpdx: n[0]!, cpdy: n[1]!, dx: n[2]!, dy: n[3]! };
    case 't': return { type, dx: n[0]!, dy: n[1]! };
    case 'a': return { type, rx: n[0]!, ry: n[1]!, xAxisRotation: n[2]!, largeArcFlag: n[3] !== 0, sweepFlag: n[4] !== 0, dx: n[5]!, dy: n[6]! };
    default: throw new Error(`Unknown path command ${type}`);
  }
}

export function serializeInstructions(instructions: Instruction[]): string {
  return instructions.map(serializeOne).join(' ');
}

function serializeOne(i: Instruction): string {
  switch (i.type) {
    case 'M': case 'L': case 'T': return `${i.type} ${i.x} ${i.y}`;
    case 'H': return `H ${i.x}`;
    case 'V': return `V ${i.y}`;
    case 'C': return `C ${i.cp1x} ${i.cp1y} ${i.cp2x} ${i.cp2y} ${i.x} ${i.y}`;
    case 'S': case 'Q': return `${i.type} ${i.cpx} ${i.cpy} ${i.x} ${i.y}`;
    case 'A': return `A ${i.rx} ${i.ry} ${i.xAxisRotation} ${i.largeArcFlag ? 1 : 0} ${i.sweepFlag ? 1 : 0} ${i.x} ${i.y}`;
    case 'Z': return 'Z';
    case 'm': case 'l': case 't': return `${i.type} ${i.dx} ${i.dy}`;
    case 'h': return `h ${i.dx}`;
    case 'v': return `v ${i.dy}`;
    case 'c': return `c ${i.cp1dx} ${i.cp1dy} ${i.cp2dx} ${i.cp2dy} ${i.dx} ${i.dy}`;
    case 's': case 'q': return `${i.type} ${i.cpdx} ${i.cpdy} ${i.dx} ${i.dy}`;
    case 'a': return `a ${i.rx} ${i.ry} ${i.xAxisRotation} ${i.largeArcFlag ? 1 : 0} ${i.sweepFlag ? 1 : 0} ${i.dx} ${i.dy}`;
  }
}

// ---- absolute form ----

/** The same path with every relative instruction written in absolute coordinates. */
function toAbsolute(instructions: Instruction[]): AbsoluteInstruction[] {
  const out: AbsoluteInstruction[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const i of instructions) {
    switch (i.type) {
      case 'M': out.push(i); x = startX = i.x; y = startY = i.y; break;
      case 'm': x += i.dx; y += i.dy; startX = x; startY = y; out.push({ type: 'M', x, y }); break;
      case 'L': case 'T': out.push(i); x = i.x; y = i.y; break;
      case 'l': x += i.dx; y += i.dy; out.push({ type: 'L', x, y }); break;
      case 'H': out.push(i); x = i.x; break;
      case 'h': x += i.dx; out.push({ type: 'H', x }); break;
      case 'V': out.push(i); y = i.y; break;
      case 'v': y += i.dy; out.push({ type: 'V', y }); break;
      case 'C': case 'S': case 'Q': case 'A': out.push(i); x = i.x; y = i.y; break;
      case 'c': out.push({ type: 'C', cp1x: x + i.cp1dx, cp1y: y + i.cp1dy, cp2x: x + i.cp2dx, cp2y: y + i.cp2dy, x: x + i.dx, y: y + i.dy }); x += i.dx; y += i.dy; break;
      case 's': out.push({ type: 'S', cpx: x + i.cpdx, cpy: y + i.cpdy, x: x + i.dx, y: y + i.dy }); x += i.dx; y += i.dy; break;
      case 'q': out.push({ type: 'Q', cpx: x + i.cpdx, cpy: y + i.cpdy, x: x + i.dx, y: y + i.dy }); x += i.dx; y += i.dy; break;
      case 't': x += i.dx; y += i.dy; out.push({ type: 'T', x, y }); break;
      case 'a': x += i.dx; y += i.dy; out.push({ type: 'A', rx: i.rx, ry: i.ry, xAxisRotation: i.xAxisRotation, largeArcFlag: i.largeArcFlag, sweepFlag: i.sweepFlag, x, y }); break;
      case 'Z': out.push(i); x = startX; y = startY; break;
    }
  }
  return out;
}

export function normalizePath(path: string): string {
  return serializeInstructions(toAbsolute(parsePath(path)));
}

// ---- reduction to M, L, C, Z ----

interface ArcGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  phi: number;
  theta1: number;
  delta: number;
}

/** The center parameterization of an SVG arc (implementation notes, F.6.5); null when the arc is a point or a line. */
function arcGeometry(
  x1: number, y1: number, rxIn: number, ryIn: number, rotation: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): ArcGeometry | null {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return null;
  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coefficient = Math.sqrt(Math.max(0, numerator / denominator));
  if (largeArc === sweep) coefficient = -coefficient;
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    return sign * Math.acos(Math.min(1, Math.max(-1, cos)));
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, theta1, delta };
}

function arcPoint(g: ArcGeometry, theta: number): Point {
  const ex = g.rx * Math.cos(theta);
  const ey = g.ry * Math.sin(theta);
  return {
    x: Math.cos(g.phi) * ex - Math.sin(g.phi) * ey + g.cx,
    y: Math.sin(g.phi) * ex + Math.cos(g.phi) * ey + g.cy,
  };
}

function arcDerivative(g: ArcGeometry, theta: number): Point {
  const ex = -g.rx * Math.sin(theta);
  const ey = g.ry * Math.cos(theta);
  return {
    x: Math.cos(g.phi) * ex - Math.sin(g.phi) * ey,
    y: Math.sin(g.phi) * ex + Math.cos(g.phi) * ey,
  };
}

/** An elliptical arc as cubic Béziers, at most a quarter turn each. */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, rotation: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): CurveTo[] {
  const g = arcGeometry(x1, y1, rx, ry, rotation, largeArc, sweep, x2, y2);
  if (g === null) return [];
  const segments = Math.max(1, Math.ceil(Math.abs(g.delta) / (Math.PI / 2) - 1e-9));
  const step = g.delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: CurveTo[] = [];
  for (let s = 0; s < segments; s++) {
    const a = g.theta1 + s * step;
    const b = a + step;
    const p0 = arcPoint(g, a);
    const p1 = arcPoint(g, b);
    const d0 = arcDerivative(g, a);
    const d1 = arcDerivative(g, b);
    out.push({
      type: 'C',
      cp1x: p0.x + k * d0.x,
      cp1y: p0.y + k * d0.y,
      cp2x: p1.x - k * d1.x,
      cp2y: p1.y - k * d1.y,
      // The last segment ends exactly where the arc was told to end.
      x: s === segments - 1 ? x2 : p1.x,
      y: s === segments - 1 ? y2 : p1.y,
    });
  }
  return out;
}

/** Every instruction as M, L, C or Z in absolute coordinates; arcs, quadratics and shorthands become cubics. */
export function reduceInstructions(instructions: Instruction[]): ReducedInstruction[] {
  return reduceWithOrigins(instructions, true).map((r) => r.instruction as ReducedInstruction);
}

/** The reduced instructions, each with the index (in the absolute list) of the instruction it came from. */
function reduceWithOrigins(
  instructions: Instruction[],
  arcsAsCubics = true,
): { instruction: ReducedInstruction | ArcTo; source: number }[] {
  const out: { instruction: ReducedInstruction | ArcTo; source: number }[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The control point a following S or T reflects, when the instruction before it was a C or a Q.
  let lastCubicControl: Point | null = null;
  let lastQuadControl: Point | null = null;
  const absolute = toAbsolute(instructions);
  absolute.forEach((i, source) => {
    let nextCubic: Point | null = null;
    let nextQuad: Point | null = null;
    const push = (instruction: ReducedInstruction | ArcTo) => out.push({ instruction, source });
    switch (i.type) {
      case 'M': push(i); x = startX = i.x; y = startY = i.y; break;
      case 'L': push(i); x = i.x; y = i.y; break;
      case 'H': push({ type: 'L', x: i.x, y }); x = i.x; break;
      case 'V': push({ type: 'L', x, y: i.y }); y = i.y; break;
      case 'C': push(i); nextCubic = { x: i.cp2x, y: i.cp2y }; x = i.x; y = i.y; break;
      case 'S': {
        const c1 = lastCubicControl ? { x: 2 * x - lastCubicControl.x, y: 2 * y - lastCubicControl.y } : { x, y };
        push({ type: 'C', cp1x: c1.x, cp1y: c1.y, cp2x: i.cpx, cp2y: i.cpy, x: i.x, y: i.y });
        nextCubic = { x: i.cpx, y: i.cpy };
        x = i.x; y = i.y;
        break;
      }
      case 'Q':
      case 'T': {
        const control =
          i.type === 'Q' ? { x: i.cpx, y: i.cpy } : lastQuadControl ? { x: 2 * x - lastQuadControl.x, y: 2 * y - lastQuadControl.y } : { x, y };
        push({
          type: 'C',
          cp1x: x + (2 / 3) * (control.x - x),
          cp1y: y + (2 / 3) * (control.y - y),
          cp2x: i.x + (2 / 3) * (control.x - i.x),
          cp2y: i.y + (2 / 3) * (control.y - i.y),
          x: i.x,
          y: i.y,
        });
        nextQuad = control;
        x = i.x; y = i.y;
        break;
      }
      case 'A': {
        if (!arcsAsCubics) {
          push(i);
          x = i.x; y = i.y;
          break;
        }
        const curves = arcToCubics(x, y, i.rx, i.ry, i.xAxisRotation, i.largeArcFlag, i.sweepFlag, i.x, i.y);
        if (curves.length === 0) push({ type: 'L', x: i.x, y: i.y });
        else for (const curve of curves) push(curve);
        x = i.x; y = i.y;
        break;
      }
      case 'Z': push(i); x = startX; y = startY; break;
    }
    lastCubicControl = nextCubic;
    lastQuadControl = nextQuad;
  });
  return out;
}

// ---- geometry ----

interface Line { kind: 'L'; x0: number; y0: number; x1: number; y1: number }
interface Cubic { kind: 'C'; x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
interface Arc { kind: 'A'; x0: number; y0: number; x1: number; y1: number; geometry: ArcGeometry }
type Curve = Line | Cubic | Arc;

// Gauss-Legendre nodes and weights of order 24, found by Newton's method on the Legendre polynomial.
const GAUSS_ORDER = 24;
const GAUSS = (() => {
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < GAUSS_ORDER; i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (GAUSS_ORDER + 0.5));
    let derivative = 1;
    for (let iteration = 0; iteration < 100; iteration++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= GAUSS_ORDER; k++) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      derivative = (GAUSS_ORDER * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / derivative;
      x -= dx;
      if (Math.abs(dx) < 1e-16) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * derivative * derivative));
  }
  return { nodes, weights };
})();

function cubicSpeed(c: Cubic, t: number): number {
  const u = 1 - t;
  const dx = 3 * (u * u * (c.x1 - c.x0) + 2 * u * t * (c.x2 - c.x1) + t * t * (c.x3 - c.x2));
  const dy = 3 * (u * u * (c.y1 - c.y0) + 2 * u * t * (c.y2 - c.y1) + t * t * (c.y3 - c.y2));
  return Math.hypot(dx, dy);
}

/** Arc length of a cubic from t = 0 to `to`. */
function cubicLengthTo(c: Cubic, to: number): number {
  const half = to / 2;
  let sum = 0;
  for (let i = 0; i < GAUSS_ORDER; i++) sum += GAUSS.weights[i]! * cubicSpeed(c, half * (GAUSS.nodes[i]! + 1));
  return sum * half;
}

/** Length of an arc from its start to the fraction `to` of its sweep. */
function arcLengthTo(g: ArcGeometry, to: number): number {
  const half = to / 2;
  let sum = 0;
  for (let i = 0; i < GAUSS_ORDER; i++) {
    const theta = g.theta1 + g.delta * half * (GAUSS.nodes[i]! + 1);
    sum += GAUSS.weights[i]! * Math.hypot(g.rx * Math.sin(theta), g.ry * Math.cos(theta));
  }
  return sum * half * Math.abs(g.delta);
}

function curveLength(curve: Curve): number {
  if (curve.kind === 'L') return Math.hypot(curve.x1 - curve.x0, curve.y1 - curve.y0);
  if (curve.kind === 'A') return arcLengthTo(curve.geometry, 1);
  return cubicLengthTo(curve, 1);
}

/** Length of any curve from its start to parameter `t`. */
function curveLengthTo(curve: Curve, t: number): number {
  if (curve.kind === 'L') return curveLength(curve) * t;
  if (curve.kind === 'A') return arcLengthTo(curve.geometry, t);
  return cubicLengthTo(curve, t);
}

function cubicPoint(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.x0 + b * c.x1 + d * c.x2 + e * c.x3, y: a * c.y0 + b * c.y1 + d * c.y2 + e * c.y3 };
}

function cubicTangent(c: Cubic, t: number): Point {
  const u = 1 - t;
  let dx = 3 * (u * u * (c.x1 - c.x0) + 2 * u * t * (c.x2 - c.x1) + t * t * (c.x3 - c.x2));
  let dy = 3 * (u * u * (c.y1 - c.y0) + 2 * u * t * (c.y2 - c.y1) + t * t * (c.y3 - c.y2));
  if (dx === 0 && dy === 0) {
    // A cusp or a degenerate control point: fall back to the chord.
    dx = c.x3 - c.x0;
    dy = c.y3 - c.y0;
  }
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/**
 * The parameter at which a cubic's arc length from its start is `distance`. The
 * published package finds it by stepping t until the length is within 0.1% of the
 * whole curve's, halving the step when neither direction helps; that tolerance is
 * visible in its points (up to ~0.1% of the path length off), so the same search
 * is used here.
 */
function parameterAt(curve: Curve, distance: number, total: number): number {
  if (distance <= 0) return 0;
  if (distance >= total) return 1;
  // Along an arc the angle is taken as proportional to the length, as in the published package. That is exact
  // for a circle and only close for an ellipse.
  if (curve.kind === 'A') return distance / total;
  let error = 1;
  let t = distance / total;
  let step = (distance - curveLengthTo(curve, t)) / total;
  for (let iterations = 0; error > 0.001 && iterations <= 500; iterations++) {
    const increasedError = Math.abs(distance - curveLengthTo(curve, t + step)) / total;
    const decreasedError = Math.abs(distance - curveLengthTo(curve, t - step)) / total;
    if (increasedError < error) {
      error = increasedError;
      t += step;
    } else if (decreasedError < error) {
      error = decreasedError;
      t -= step;
    } else {
      step /= 2;
    }
  }
  return t;
}

interface Piece {
  /** The curves one drawing instruction produced, with their lengths. */
  curves: { curve: Curve; length: number }[];
  length: number;
  /** Position in the instruction list, counting from the one after the first (a leading `M`). */
  index: number;
}

/** Splits the path into drawing instructions with their curves and lengths. `M` draws nothing and has no piece. */
function piecesOf(path: string): Piece[] {
  const instructions = toAbsolute(parsePath(path));
  const reduced = reduceWithOrigins(instructions, false);
  const pieces = new Map<number, Piece>();
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const { instruction: r, source } of reduced) {
    let curve: Curve | null = null;
    switch (r.type) {
      case 'M': x = startX = r.x; y = startY = r.y; continue;
      case 'L': curve = { kind: 'L', x0: x, y0: y, x1: r.x, y1: r.y }; x = r.x; y = r.y; break;
      case 'C': curve = { kind: 'C', x0: x, y0: y, x1: r.cp1x, y1: r.cp1y, x2: r.cp2x, y2: r.cp2y, x3: r.x, y3: r.y }; x = r.x; y = r.y; break;
      case 'Z': curve = { kind: 'L', x0: x, y0: y, x1: startX, y1: startY }; x = startX; y = startY; break;
      case 'A': {
        const geometry = arcGeometry(x, y, r.rx, r.ry, r.xAxisRotation, r.largeArcFlag, r.sweepFlag, r.x, r.y);
        curve = geometry
          ? { kind: 'A', x0: x, y0: y, x1: r.x, y1: r.y, geometry }
          : { kind: 'L', x0: x, y0: y, x1: r.x, y1: r.y };
        x = r.x;
        y = r.y;
        break;
      }
    }
    let piece = pieces.get(source);
    if (!piece) {
      piece = { curves: [], length: 0, index: Math.max(0, source - 1) };
      pieces.set(source, piece);
    }
    const length = curveLength(curve);
    piece.curves.push({ curve, length });
    piece.length += length;
  }
  return [...pieces.values()];
}

export function getLength(path: string): number {
  let total = 0;
  for (const piece of piecesOf(path)) total += piece.length;
  return total;
}

function locate(path: string, length: number): { curve: Curve; length: number; distance: number } | null {
  if (length < 0) throw new Error('Length less than 0 was passed');
  let passed = 0;
  let last: { curve: Curve; length: number; distance: number } | null = null;
  for (const piece of piecesOf(path)) {
    for (const { curve, length: curveLen } of piece.curves) {
      if (curveLen === 0 && length > passed) {
        passed += curveLen;
        continue;
      }
      last = { curve, length: curveLen, distance: length - passed };
      if (length <= passed + curveLen) return last;
      passed += curveLen;
    }
  }
  return length <= passed + 1e-8 * Math.max(1, passed) ? last : null;
}

/** The point `length` along the path, or `null` past its end. */
export function getPointAtLength(path: string, length: number): Point | null {
  const found = locate(path, length);
  if (found === null) return null;
  const { curve, length: curveLen, distance } = found;
  if (curve.kind === 'L') {
    const t = curveLen === 0 ? 0 : Math.min(1, distance / curveLen);
    return { x: curve.x0 + (curve.x1 - curve.x0) * t, y: curve.y0 + (curve.y1 - curve.y0) * t };
  }
  const t = parameterAt(curve, distance, curveLen);
  if (curve.kind === 'A') return arcPoint(curve.geometry, curve.geometry.theta1 + t * curve.geometry.delta);
  return cubicPoint(curve, t);
}

/** The unit tangent `length` along the path, or `null` past its end. */
export function getTangentAtLength(path: string, length: number): Point | null {
  const found = locate(path, length);
  if (found === null) return null;
  const { curve, length: curveLen, distance } = found;
  if (curve.kind === 'L') {
    const len = Math.hypot(curve.x1 - curve.x0, curve.y1 - curve.y0) || 1;
    return { x: (curve.x1 - curve.x0) / len, y: (curve.y1 - curve.y0) / len };
  }
  const t = parameterAt(curve, distance, curveLen);
  if (curve.kind === 'A') {
    const g = curve.geometry;
    const d = arcDerivative(g, g.theta1 + t * g.delta);
    const sign = g.delta < 0 ? -1 : 1;
    const size = Math.hypot(d.x, d.y) || 1;
    return { x: (sign * d.x) / size, y: (sign * d.y) / size };
  }
  return cubicTangent(curve, t);
}

/** Which instruction `length` falls in (counted from the one after the first `M`) and how far into it. */
export function getInstructionIndexAtLength(
  path: string,
  length: number,
): { index: number; lengthIntoInstruction: number } {
  if (length < 0) throw new Error('Length less than 0 was passed');
  const pieces = piecesOf(path);
  let total = 0;
  for (const piece of pieces) total += piece.length;
  if (length > total + 1e-8 * Math.max(1, total)) {
    throw new Error(
      `A length of ${length} was passed to getInstructionIndexAtLength() but the total length of the path is only ${total}`,
    );
  }
  let passed = 0;
  for (const piece of pieces) {
    if (length <= passed + piece.length) return { index: piece.index, lengthIntoInstruction: length - passed };
    passed += piece.length;
  }
  const lastPiece = pieces[pieces.length - 1]!;
  return { index: lastPiece.index, lengthIntoInstruction: lastPiece.length };
}

/**
 * The stroke properties that draw the first `progress` of the path: set both on
 * the element. At progress 0 the dash is 1.5 times as long, which keeps the round
 * or square cap of a zero-length dash from showing as a dot.
 */
export function evolvePath(progress: number, path: string): { strokeDasharray: string; strokeDashoffset: number } {
  const length = getLength(path);
  if (progress === 0) {
    const hidden = length * 1.5;
    return { strokeDasharray: `${hidden} ${hidden}`, strokeDashoffset: hidden };
  }
  return { strokeDasharray: `${length} ${length}`, strokeDashoffset: length - progress * length };
}

/** The first `length` of the path, as a path. */
export function cutPath(path: string, length: number): string {
  if (length < 0) throw new Error('Length less than 0 was passed');
  const reduced = reduceInstructions(parsePath(path));
  const out: ReducedInstruction[] = [];
  let remaining = length;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const r of reduced) {
    if (r.type === 'M') {
      out.push(r);
      x = startX = r.x;
      y = startY = r.y;
      continue;
    }
    const curve: Curve =
      r.type === 'L'
        ? { kind: 'L', x0: x, y0: y, x1: r.x, y1: r.y }
        : r.type === 'C'
          ? { kind: 'C', x0: x, y0: y, x1: r.cp1x, y1: r.cp1y, x2: r.cp2x, y2: r.cp2y, x3: r.x, y3: r.y }
          : { kind: 'L', x0: x, y0: y, x1: startX, y1: startY };
    const size = curveLength(curve);
    if (remaining >= size) {
      out.push(r.type === 'Z' ? { type: 'L', x: startX, y: startY } : r);
      remaining -= size;
      x = curve.kind === 'L' ? curve.x1 : curve.x3;
      y = curve.kind === 'L' ? curve.y1 : curve.y3;
      continue;
    }
    if (curve.kind === 'L') {
      const t = size === 0 ? 0 : remaining / size;
      out.push({ type: 'L', x: curve.x0 + (curve.x1 - curve.x0) * t, y: curve.y0 + (curve.y1 - curve.y0) * t });
    } else {
      out.push(...splitCubicAt(curve, parameterAt(curve, remaining, size)).first);
    }
    break;
  }
  return serializeInstructions(out);
}

function splitCubicAt(c: Cubic, t: number): { first: CurveTo[] } {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const x01 = lerp(c.x0, c.x1), y01 = lerp(c.y0, c.y1);
  const x12 = lerp(c.x1, c.x2), y12 = lerp(c.y1, c.y2);
  const x23 = lerp(c.x2, c.x3), y23 = lerp(c.y2, c.y3);
  const xa = lerp(x01, x12), ya = lerp(y01, y12);
  const xb = lerp(x12, x23), yb = lerp(y12, y23);
  const xm = lerp(xa, xb), ym = lerp(ya, yb);
  return { first: [{ type: 'C', cp1x: x01, cp1y: y01, cp2x: xa, cp2y: ya, x: xm, y: ym }] };
}

// ---- transforms ----

export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  viewBox: string;
  width: number;
  height: number;
}

function cubicExtremes(p0: number, p1: number, p2: number, p3: number): number[] {
  // Roots of the derivative of one coordinate, in (0, 1).
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

export function getBoundingBox(path: string): BoundingBox {
  const reduced = reduceInstructions(parsePath(path));
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const add = (x: number, y: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const r of reduced) {
    if (r.type === 'M') {
      add(r.x, r.y);
      x = startX = r.x;
      y = startY = r.y;
    } else if (r.type === 'L') {
      add(r.x, r.y);
      x = r.x;
      y = r.y;
    } else if (r.type === 'C') {
      const curve: Cubic = { kind: 'C', x0: x, y0: y, x1: r.cp1x, y1: r.cp1y, x2: r.cp2x, y2: r.cp2y, x3: r.x, y3: r.y };
      add(r.x, r.y);
      for (const t of [...cubicExtremes(x, r.cp1x, r.cp2x, r.x), ...cubicExtremes(y, r.cp1y, r.cp2y, r.y)]) {
        const p = cubicPoint(curve, t);
        add(p.x, p.y);
      }
      x = r.x;
      y = r.y;
    } else {
      x = startX;
      y = startY;
    }
  }
  const width = x2 - x1;
  const height = y2 - y1;
  return { x1, y1, x2, y2, viewBox: `${x1} ${y1} ${width} ${height}`, width, height };
}

/** Moves every absolute instruction by (x, y). Relative instructions are left as written. */
export function translatePath(path: string, x: number, y: number): string {
  return serializeInstructions(
    parsePath(path).map((i): Instruction => {
      switch (i.type) {
        case 'M': case 'L': case 'T': return { ...i, x: i.x + x, y: i.y + y };
        case 'H': return { ...i, x: i.x + x };
        case 'V': return { ...i, y: i.y + y };
        case 'C': return { ...i, cp1x: i.cp1x + x, cp1y: i.cp1y + y, cp2x: i.cp2x + x, cp2y: i.cp2y + y, x: i.x + x, y: i.y + y };
        case 'S': case 'Q': return { ...i, cpx: i.cpx + x, cpy: i.cpy + y, x: i.x + x, y: i.y + y };
        case 'A': return { ...i, x: i.x + x, y: i.y + y };
        default: return i;
      }
    }),
  );
}

/** Moves the path so the top left of its bounding box is at (0, 0). */
export function resetPath(path: string): string {
  const { x1, y1 } = getBoundingBox(path);
  return translatePath(path, -x1, -y1);
}

/** Moves the path so the middle of its bounding box is at (0, 0). */
export function centerPath(path: string): string {
  const { x1, y1, width, height } = getBoundingBox(path);
  return translatePath(path, -(x1 + width / 2), -(y1 + height / 2));
}

/** Scales the path about the top left of its bounding box. Arcs and quadratics come back as cubics. */
export function scalePath(path: string, scaleX: number, scaleY: number): string {
  const { x1, y1 } = getBoundingBox(path);
  const sx = (x: number) => x1 + (x - x1) * scaleX;
  const sy = (y: number) => y1 + (y - y1) * scaleY;
  return serializeInstructions(
    reduceInstructions(parsePath(path)).map((r): ReducedInstruction => {
      switch (r.type) {
        case 'M': case 'L': return { type: r.type, x: sx(r.x), y: sy(r.y) };
        case 'C': return { type: 'C', cp1x: sx(r.cp1x), cp1y: sy(r.cp1y), cp2x: sx(r.cp2x), cp2y: sy(r.cp2y), x: sx(r.x), y: sy(r.y) };
        default: return r;
      }
    }),
  );
}

/** Splits the path into its subpaths. A relative `m` that starts one becomes an absolute `M`; the rest is as written. */
export function getSubpaths(path: string): string[] {
  const written = parsePath(path);
  const absolute = toAbsolute(written);
  const groups: Instruction[][] = [];
  written.forEach((instruction, index) => {
    const starts = instruction.type === 'M' || instruction.type === 'm';
    if (starts || groups.length === 0) groups.push([]);
    groups[groups.length - 1]!.push(instruction.type === 'm' ? absolute[index]! : instruction);
  });
  return groups.map(serializeInstructions);
}

/** The same path drawn the other way. Each subpath is reversed in place; a closed one keeps its `Z`. */
export function reversePath(path: string): string {
  const reduced = reduceInstructions(parsePath(path));
  const subpaths: ReducedInstruction[][] = [];
  for (const r of reduced) {
    if (r.type === 'M' || subpaths.length === 0) subpaths.push([]);
    subpaths[subpaths.length - 1]!.push(r);
  }
  return subpaths
    .map((sub) => {
      const closed = sub[sub.length - 1]!.type === 'Z';
      const body = closed ? sub.slice(0, -1) : sub;
      if (body.length === 0) return '';
      const points: Point[] = [];
      let first = true;
      const segments: { from: Point; instruction: LineTo | CurveTo }[] = [];
      let at: Point = { x: 0, y: 0 };
      for (const r of body) {
        if (r.type === 'M') {
          at = { x: r.x, y: r.y };
          if (first) points.push(at);
          first = false;
        } else if (r.type === 'L' || r.type === 'C') {
          segments.push({ from: at, instruction: r });
          at = { x: r.x, y: r.y };
        }
      }
      const startPoint = points[0] ?? { x: 0, y: 0 };
      const end = segments.length > 0 ? { x: segments[segments.length - 1]!.instruction.x, y: segments[segments.length - 1]!.instruction.y } : startPoint;
      const out: ReducedInstruction[] = [{ type: 'M', x: end.x, y: end.y }];
      for (let s = segments.length - 1; s >= 0; s--) {
        const { from, instruction } = segments[s]!;
        if (instruction.type === 'L') out.push({ type: 'L', x: from.x, y: from.y });
        else {
          out.push({ type: 'C', cp1x: instruction.cp2x, cp1y: instruction.cp2y, cp2x: instruction.cp1x, cp2y: instruction.cp1y, x: from.x, y: from.y });
        }
      }
      return serializeInstructions(out) + (closed ? 'Z' : '');
    })
    .filter((s) => s !== '')
    .join(' ');
}

// ---- interpolation ----

/** A path as a list of cubic-or-line instructions, with its subpaths kept apart, for interpolation. */
function toInterpolable(path: string): ReducedInstruction[] {
  return reduceInstructions(parsePath(path));
}

function segmentLength(from: Point, r: LineTo | CurveTo): number {
  return r.type === 'L'
    ? Math.hypot(r.x - from.x, r.y - from.y)
    : cubicLengthTo({ kind: 'C', x0: from.x, y0: from.y, x1: r.cp1x, y1: r.cp1y, x2: r.cp2x, y2: r.cp2y, x3: r.x, y3: r.y }, 1);
}

/** Splits one drawing instruction in two at its middle. */
function halve(from: Point, r: LineTo | CurveTo): [LineTo | CurveTo, LineTo | CurveTo] {
  if (r.type === 'L') {
    const mid = { x: (from.x + r.x) / 2, y: (from.y + r.y) / 2 };
    return [{ type: 'L', x: mid.x, y: mid.y }, r];
  }
  const c: Cubic = { kind: 'C', x0: from.x, y0: from.y, x1: r.cp1x, y1: r.cp1y, x2: r.cp2x, y2: r.cp2y, x3: r.x, y3: r.y };
  const lerp = (a: number, b: number) => (a + b) / 2;
  const x01 = lerp(c.x0, c.x1), y01 = lerp(c.y0, c.y1);
  const x12 = lerp(c.x1, c.x2), y12 = lerp(c.y1, c.y2);
  const x23 = lerp(c.x2, c.x3), y23 = lerp(c.y2, c.y3);
  const xa = lerp(x01, x12), ya = lerp(y01, y12);
  const xb = lerp(x12, x23), yb = lerp(y12, y23);
  const xm = lerp(xa, xb), ym = lerp(ya, yb);
  return [
    { type: 'C', cp1x: x01, cp1y: y01, cp2x: xa, cp2y: ya, x: xm, y: ym },
    { type: 'C', cp1x: xb, cp1y: yb, cp2x: x23, cp2y: y23, x: c.x3, y: c.y3 },
  ];
}

/** Adds drawing instructions to `list` by halving its longest one, until it has `count` of them. */
function grow(list: ReducedInstruction[], count: number): ReducedInstruction[] {
  const out = [...list];
  const drawing = () => out.filter((r) => r.type !== 'M' && r.type !== 'Z').length;
  while (drawing() < count) {
    let at: Point = { x: 0, y: 0 };
    let best = -1;
    let bestLength = -1;
    let bestFrom: Point = at;
    out.forEach((r, index) => {
      if (r.type === 'M') at = { x: r.x, y: r.y };
      else if (r.type === 'L' || r.type === 'C') {
        const size = segmentLength(at, r);
        if (size > bestLength) {
          bestLength = size;
          best = index;
          bestFrom = at;
        }
        at = { x: r.x, y: r.y };
      }
    });
    if (best < 0) break;
    out.splice(best, 1, ...halve(bestFrom, out[best] as LineTo | CurveTo));
  }
  return out;
}

const toCurve = (from: Point, r: LineTo): CurveTo => ({
  type: 'C',
  cp1x: from.x,
  cp1y: from.y,
  cp2x: r.x,
  cp2y: r.y,
  x: r.x,
  y: r.y,
});

export function interpolatePath(progress: number, firstPath: string, secondPath: string): string {
  // The ends are the paths themselves, whatever their structure.
  if (progress === 0) return firstPath;
  if (progress === 1) return secondPath;
  let a = toInterpolable(firstPath);
  let b = toInterpolable(secondPath);
  const drawing = (list: ReducedInstruction[]) => list.filter((r) => r.type !== 'M' && r.type !== 'Z').length;
  if (drawing(a) < drawing(b)) a = grow(a, drawing(b));
  else if (drawing(b) < drawing(a)) b = grow(b, drawing(a));
  if (a.length !== b.length) {
    throw new Error('The two paths cannot be interpolated: they do not have the same structure');
  }
  const mix = (x: number, y: number) => x + (y - x) * progress;
  const out: ReducedInstruction[] = [];
  let pa: Point = { x: 0, y: 0 };
  let pb: Point = { x: 0, y: 0 };
  for (let k = 0; k < a.length; k++) {
    let ra = a[k]!;
    let rb = b[k]!;
    if (ra.type === 'M' && rb.type === 'M') {
      out.push({ type: 'M', x: mix(ra.x, rb.x), y: mix(ra.y, rb.y) });
    } else if (ra.type === 'Z' && rb.type === 'Z') {
      out.push(ra);
    } else {
      if (ra.type === 'L' && rb.type === 'C') ra = toCurve(pa, ra);
      else if (ra.type === 'C' && rb.type === 'L') rb = toCurve(pb, rb);
      if (ra.type === 'L' && rb.type === 'L') out.push({ type: 'L', x: mix(ra.x, rb.x), y: mix(ra.y, rb.y) });
      else if (ra.type === 'C' && rb.type === 'C') {
        out.push({
          type: 'C',
          cp1x: mix(ra.cp1x, rb.cp1x),
          cp1y: mix(ra.cp1y, rb.cp1y),
          cp2x: mix(ra.cp2x, rb.cp2x),
          cp2y: mix(ra.cp2y, rb.cp2y),
          x: mix(ra.x, rb.x),
          y: mix(ra.y, rb.y),
        });
      } else {
        throw new Error('The two paths cannot be interpolated: their subpaths do not line up');
      }
    }
    if (ra.type !== 'Z') pa = { x: (ra as { x: number }).x, y: (ra as { y: number }).y };
    if (rb.type !== 'Z') pb = { x: (rb as { x: number }).x, y: (rb as { y: number }).y };
  }
  return serializeInstructions(out);
}

/** A view box grown (or shrunk) about its middle by `scale`. */
export function extendViewBox(currentViewBox: string, scale: number): string {
  const [x, y, width, height] = currentViewBox
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(Number) as [number, number, number, number];
  const newWidth = width * scale;
  const newHeight = height * scale;
  return `${x + width / 2 - newWidth / 2} ${y + height / 2 - newHeight / 2} ${newWidth} ${newHeight}`;
}
