/**
 * Toile engraving primitives, drawn as SVG paths. Everything is seeded, so a drawing is the same on every load.
 *
 * The look comes from occlusion: each leaf is filled with the ground colour and stroked with the line colour, and
 * leaves are drawn back to front, so a dense clump reads as a copperplate print instead of a pile of outlines.
 */

import type { ReactNode } from 'react';

export const COBALT = '#2238c4';
export const PAPER = '#f7f4ec';
export const NIGHT = '#070a1c';

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

/** Moves (x, y) by a rotation `a` and a translation. */
function at(x: number, y: number, a: number, ox: number, oy: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [ox + x * c - y * s, oy + x * s + y * c];
}

/**
 * One leaf as a single path: the outline (closed, so it fills), the midrib, veins, and hatching on the shaded half.
 * `a` is the direction from stem to tip.
 */
export function leafPath(x: number, y: number, a: number, len: number, width = 0.36, veins = 3, hatch = true) {
  const w = len * width;
  const p = (u: number, v: number) => at(u, v, a, x, y).map(f).join(' ');
  let d = `M${p(0, 0)} C${p(len * 0.25, -w)} ${p(len * 0.7, -w * 0.9)} ${p(len, 0)} C${p(len * 0.7, w * 0.9)} ${p(len * 0.25, w)} ${p(0, 0)}Z`;
  d += ` M${p(len * 0.04, 0)} L${p(len * 0.86, 0)}`;
  for (let k = 1; k <= veins; k++) {
    const u = len * (0.12 + (k / (veins + 1)) * 0.7);
    d += ` M${p(u, 0)} L${p(u + len * 0.13, -w * 0.62)} M${p(u, 0)} L${p(u + len * 0.13, w * 0.62)}`;
  }
  if (hatch) {
    for (let k = 0; k < 4; k++) {
      const u = len * (0.3 + k * 0.13);
      d += ` M${p(u, w * 0.18)} L${p(u - len * 0.05, w * 0.52)}`;
    }
  }
  return d;
}

/** A rosette: two rings of petals and a dotted centre. */
export function rosettePath(x: number, y: number, r: number, petals = 7, turn = 0) {
  let d = '';
  for (const [rr, n, off] of [[1, petals, 0], [0.62, petals, 0.5]] as const) {
    for (let k = 0; k < n; k++) {
      const a = turn + ((k + off) / n) * Math.PI * 2;
      const tip = at(r * rr, 0, a, x, y);
      const l = at(r * rr * 0.55, -r * rr * 0.42, a, x, y);
      const rt = at(r * rr * 0.55, r * rr * 0.42, a, x, y);
      d += `M${f(x)} ${f(y)} Q${f(l[0])} ${f(l[1])} ${f(tip[0])} ${f(tip[1])} Q${f(rt[0])} ${f(rt[1])} ${f(x)} ${f(y)}Z `;
    }
  }
  return d;
}

/** A four-point star glint. */
export function starPath(x: number, y: number, r: number) {
  const q = r * 0.16;
  return `M${f(x)} ${f(y - r)} Q${f(x + q)} ${f(y - q)} ${f(x + r)} ${f(y)} Q${f(x + q)} ${f(y + q)} ${f(x)} ${f(y + r)} Q${f(x - q)} ${f(y + q)} ${f(x - r)} ${f(y)} Q${f(x - q)} ${f(y - q)} ${f(x)} ${f(y - r)}Z`;
}

export interface Ink {
  /** The line colour. */
  line: string;
  /** The ground the lines are cut into: leaf fills use it so leaves occlude. */
  ground: string;
}

/**
 * A tree canopy: leaves scattered in an ellipse, pointing outward from its centre, drawn back to front, with
 * branches behind them and rosettes and berries among them.
 */
export function Canopy({
  cx, cy, rx, ry, count, seed, size = 22, ink, roses = 0.05, berries = 0.04, trunk = true,
}: {
  cx: number; cy: number; rx: number; ry: number; count: number; seed: number; size?: number; ink: Ink;
  roses?: number; berries?: number; trunk?: boolean;
}) {
  const r = rng(seed);
  const items: { y: number; node: ReactNode }[] = [];
  const branches: string[] = [];
  for (let i = 0; i < count; i++) {
    // area-uniform point in the ellipse
    const t = r() * Math.PI * 2;
    const u = Math.sqrt(r());
    const x = cx + Math.cos(t) * rx * u;
    const y = cy + Math.sin(t) * ry * u;
    const out = Math.atan2(y - cy, x - cx);
    const a = out + (r() - 0.5) * 1.6 - 0.35;
    const len = size * (0.65 + r() * 0.7);
    const roll = r();
    if (roll < roses) {
      items.push({ y, node: <path key={i} d={rosettePath(x, y, len * 0.55, 6 + Math.floor(r() * 3), r() * 6)} fill={ink.ground} stroke={ink.line} /> });
    } else if (roll < roses + berries) {
      const br = len * 0.24;
      items.push({
        y,
        node: (
          <g key={i}>
            <circle cx={f(x)} cy={f(y)} r={f(br)} fill={ink.ground} stroke={ink.line} />
            <path d={`M${f(x - br * 0.5)} ${f(y - br * 0.1)} a${f(br * 0.55)} ${f(br * 0.55)} 0 0 1 ${f(br * 0.5)} ${f(-br * 0.45)}`} fill="none" stroke={ink.line} />
          </g>
        ),
      });
    } else {
      items.push({ y, node: <path key={i} d={leafPath(x, y, a, len, 0.3 + r() * 0.12, 2 + Math.floor(r() * 2), r() > 0.35)} fill={ink.ground} stroke={ink.line} /> });
    }
    if (trunk && i % 9 === 0) {
      // a twig from near the trunk out to this leaf
      const bx = cx + (x - cx) * 0.25;
      const by = cy + ry * 0.55 + (y - cy) * 0.2;
      branches.push(`M${f(bx)} ${f(by)} Q${f((bx + x) / 2 + (r() - 0.5) * 30)} ${f((by + y) / 2)} ${f(x)} ${f(y)}`);
    }
  }
  items.sort((p, q) => p.y - q.y);
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
      {trunk && <path d={branches.join(' ')} fill="none" stroke={ink.line} strokeWidth={1.4} />}
      {items.map((it) => it.node)}
    </g>
  );
}

/** A trailing vine: a stem that wanders along a direction with leaves on alternating sides. */
export function Vine({
  x, y, angle, length, seed, size = 16, ink, curl = 0.6,
}: { x: number; y: number; angle: number; length: number; seed: number; size?: number; ink: Ink; curl?: number }) {
  const r = rng(seed);
  const steps = Math.max(8, Math.round(length / 9));
  const pts: [number, number, number][] = [];
  let a = angle;
  let px = x;
  let py = y;
  const phase = r() * 6;
  for (let i = 0; i <= steps; i++) {
    pts.push([px, py, a]);
    a += Math.sin(i * 0.35 + phase) * 0.09 * curl;
    px += Math.cos(a) * (length / steps);
    py += Math.sin(a) * (length / steps);
  }
  const stem = pts.map(([sx, sy], i) => `${i ? 'L' : 'M'}${f(sx)} ${f(sy)}`).join(' ');
  const leaves: ReactNode[] = [];
  for (let i = 2; i < pts.length; i += 2) {
    const [lx, ly, la] = pts[i]!;
    const side = (i / 2) % 2 ? 1 : -1;
    const len = size * (0.7 + r() * 0.5) * (1 - (i / pts.length) * 0.45);
    leaves.push(<path key={i} d={leafPath(lx, ly, la + side * (0.7 + r() * 0.4), len, 0.34, 2, false)} fill={ink.ground} stroke={ink.line} />);
  }
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
      <path d={stem} fill="none" stroke={ink.line} strokeWidth={1.3} />
      {leaves}
    </g>
  );
}

/** A crescent moon with a dotted halo and two thin rings. */
export function Moon({ x, y, r, ink }: { x: number; y: number; r: number; ink: Ink }) {
  return (
    <g fill="none" stroke={ink.line}>
      <circle cx={x} cy={y} r={r * 1.9} strokeWidth={0.8} opacity={0.45} />
      <circle cx={x} cy={y} r={r * 2.35} strokeWidth={0.8} strokeDasharray="1.5 5" opacity={0.6} />
      <circle cx={x} cy={y} r={r} fill={ink.line} stroke="none" />
      <circle cx={x + r * 0.42} cy={y - r * 0.1} r={r * 0.84} fill={ink.ground} stroke="none" />
      {Array.from({ length: 6 }, (_, k) => {
        const yy = y - r * 0.7 + k * r * 0.28;
        return <line key={k} x1={x - r * 0.95} y1={yy} x2={x - r * 0.62} y2={yy + r * 0.1} strokeWidth={0.8} />;
      })}
    </g>
  );
}

/** Parallel hatching clipped to a shape: pass the shape as `clip` (an SVG path). */
export function Hatch({ id, clip, x0, y0, x1, y1, gap = 5, angle = -0.6, ink, width = 0.8, opacity = 1 }: {
  id: string; clip: string; x0: number; y0: number; x1: number; y1: number; gap?: number; angle?: number; ink: Ink; width?: number; opacity?: number;
}) {
  const span = Math.hypot(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let d = '';
  for (let s = -span / 2; s <= span / 2; s += gap) {
    const a = at(s, -span / 2, angle, cx, cy);
    const b = at(s, span / 2, angle, cx, cy);
    d += `M${f(a[0])} ${f(a[1])} L${f(b[0])} ${f(b[1])} `;
  }
  return (
    <g>
      <clipPath id={id}><path d={clip} /></clipPath>
      <path d={d} clipPath={`url(#${id})`} stroke={ink.line} strokeWidth={width} opacity={opacity} fill="none" />
    </g>
  );
}

/** Small engraved stars scattered over a rectangle, skipping a keep-out rectangle. */
export function Stars({ x0, y0, x1, y1, count, seed, ink, avoid }: {
  x0: number; y0: number; x1: number; y1: number; count: number; seed: number; ink: Ink; avoid?: [number, number, number, number];
}) {
  const r = rng(seed);
  const out: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    if (avoid && x > avoid[0] && x < avoid[2] && y > avoid[1] && y < avoid[3]) continue;
    const big = r() < 0.18;
    out.push(big
      ? <path key={i} className="kg-twinkle" style={{ animationDelay: `${f(r() * 4)}s` }} d={starPath(x, y, 5 + r() * 4)} fill={ink.line} />
      : <circle key={i} cx={f(x)} cy={f(y)} r={f(0.8 + r() * 0.9)} fill={ink.line} opacity={0.8} />);
  }
  return <g>{out}</g>;
}
