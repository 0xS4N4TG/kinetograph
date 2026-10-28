// CSS easing functions (CSS Easing Functions Level 2) for the Web Animations API: `linear`, the `ease` keywords,
// `cubic-bezier()`, `steps()` with its jump terms and `step-start`/`step-end`, and `linear()` with its stops.

/** `before` is the "before flag" of the step functions: the input is in the before phase of the effect. */
export type Easing = (t: number, before?: boolean) => number;

const LINEAR: Easing = (t) => t;

/** A cubic Bézier from (0, 0) to (1, 1) with control points (x1, y1), (x2, y2), solved for x as browsers do. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const epsilon = 1e-7;
  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(s) - x;
      if (Math.abs(error) < epsilon) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= error / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    while (lo < hi) {
      const v = sampleX(s);
      if (Math.abs(v - x) < epsilon) return s;
      if (x > v) lo = s;
      else hi = s;
      s = (hi - lo) / 2 + lo;
      if (hi - lo < epsilon) break;
    }
    return s;
  };
  return (t) => {
    // Outside 0..1 the curve goes on along its end tangents (CSS Easing 2, "cubic-bezier").
    if (t < 0) {
      const slope = x1 > 0 ? y1 / x1 : y1 === 0 && x2 > 0 ? y2 / x2 : 0;
      return slope * t;
    }
    if (t > 1) {
      const slope = x2 < 1 ? (y2 - 1) / (x2 - 1) : y1 === 1 && x1 < 1 ? (y1 - 1) / (x1 - 1) : 0;
      return 1 + slope * (t - 1);
    }
    return sampleY(solve(t));
  };
}

function steps(count: number, position: string): Easing {
  return (t, before = false) => {
    let step = Math.floor(t * count);
    if (position === 'jump-start' || position === 'start' || position === 'jump-both') step += 1;
    // At an exact step in the before phase, the output is the step below (CSS Easing 2, "step easing function").
    if (before && Number.isInteger(t * count)) step -= 1;
    if (t >= 0 && step < 0) step = 0;
    const jumps = position === 'jump-none' ? count - 1 : position === 'jump-both' ? count + 1 : count;
    if (t <= 1 && step > jumps) step = jumps;
    return step / jumps;
  };
}

/** `linear(...)`: points with optional input percentages, missing inputs spread evenly (CSS Easing 2). */
function linearStops(args: string): Easing | null {
  const points: Array<{ output: number; input: number | null }> = [];
  for (const part of args.split(',')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const output = Number(words[0]);
    if (!Number.isFinite(output)) return null;
    const inputs = words.slice(1).map((w) => (w.endsWith('%') ? parseFloat(w) / 100 : NaN));
    if (inputs.some((v) => !Number.isFinite(v)) || inputs.length > 2) return null;
    if (inputs.length === 0) points.push({ output, input: null });
    else for (const input of inputs) points.push({ output, input });
  }
  if (points.length < 2) return null;
  if (points[0]!.input === null) points[0]!.input = 0;
  if (points[points.length - 1]!.input === null) points[points.length - 1]!.input = 1;
  // An input below an earlier one is raised to it.
  let largest = -Infinity;
  for (const p of points) {
    if (p.input !== null) {
      p.input = Math.max(p.input, largest);
      largest = p.input;
    }
  }
  // Runs of missing inputs are spread evenly between their neighbours.
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.input !== null) continue;
    let j = i;
    while (points[j]!.input === null) j++;
    const from = points[i - 1]!.input!;
    const to = points[j]!.input!;
    for (let k = i; k < j; k++) points[k]!.input = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  const xs = points.map((p) => p.input!);
  const ys = points.map((p) => p.output);
  return (t) => {
    const n = xs.length;
    // The last pair whose input is at or below t (extrapolated from the first or last pair outside them).
    let i: number;
    if (t <= xs[0]!) i = 0;
    else if (t >= xs[n - 1]!) i = n - 2;
    else {
      i = 0;
      for (let k = 0; k < n - 1; k++) if (xs[k]! <= t) i = k;
    }
    // At an input shared by two points, the later point wins.
    if (t === xs[i + 1] && i + 2 < n && xs[i + 2] === t) return ys[i + 2]!;
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (x1 === x0) return ys[i + 1]!;
    return ys[i]! + ((ys[i + 1]! - ys[i]!) * (t - x0)) / (x1 - x0);
  };
}

const KEYWORDS: Record<string, Easing> = {
  linear: LINEAR,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBezier(0.42, 0, 1, 1),
  'ease-out': cubicBezier(0, 0, 0.58, 1),
  'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
  'step-start': steps(1, 'jump-start'),
  'step-end': steps(1, 'jump-end'),
};

/** An easing function from its CSS text, or null when the text is not one (the API throws a TypeError then). */
export function parseEasing(text: string): Easing | null {
  const value = text.trim();
  const keyword = KEYWORDS[value];
  if (keyword) return keyword;
  const call = /^([a-z-]+)\((.*)\)$/s.exec(value);
  if (!call) return null;
  const [, name, args] = call;
  if (name === 'cubic-bezier') {
    const n = args!.split(',').map(Number);
    if (n.length !== 4 || !n.every(Number.isFinite) || n[0]! < 0 || n[0]! > 1 || n[2]! < 0 || n[2]! > 1) return null;
    return cubicBezier(n[0]!, n[1]!, n[2]!, n[3]!);
  }
  if (name === 'steps') {
    const [count, position = 'end'] = args!.split(',').map((s) => s.trim());
    const n = Number(count);
    const known = ['jump-start', 'jump-end', 'jump-none', 'jump-both', 'start', 'end'];
    if (!Number.isInteger(n) || n < 1 || !known.includes(position) || (position === 'jump-none' && n < 2)) return null;
    return steps(n, position);
  }
  if (name === 'linear') return linearStops(args!);
  return null;
}
