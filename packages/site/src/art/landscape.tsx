'use client';

/**
 * The footer frieze: hills, a river with a boat, Edison's Black Maria (1893, the first film studio) at the centre,
 * telegraph wires and a balloon. Cobalt lines on paper, ending in a cobalt band that runs into the footer.
 * viewBox 1440 x 360.
 */

import { memo, type ReactNode } from 'react';
import { Canopy, COBALT, Hatch, type Ink, PAPER, rng } from './engrave';

const W = 1440;
const H = 360;
const GROUND = 312;
const PRINT: Ink = { line: COBALT, ground: PAPER };
const f = (n: number) => Math.round(n * 10) / 10;

/** A ridge line across the whole frieze. */
function ridge(y: number, amp: number, seed: number) {
  const r = rng(seed);
  let d = `M0 ${y}`;
  const n = 6;
  for (let k = 1; k <= n; k++) {
    const x = (k / n) * W;
    d += ` S${f(x - W / n / 2)} ${f(y - amp * (0.4 + r() * 0.6))} ${f(x)} ${f(y - amp * r() * 0.4)}`;
  }
  return d;
}

/** A hill: its ridge, then the same line repeated below it as engraved contours that fade out. */
function Hill({ id, y, amp, seed, contours, gap }: { id: string; y: number; amp: number; seed: number; contours: number; gap: number }) {
  const line = ridge(y, amp, seed);
  const shape = `${line} L${W} ${H} L0 ${H}Z`;
  return (
    <g>
      <clipPath id={id}><path d={shape} /></clipPath>
      <path d={shape} fill={PAPER} />
      <g clipPath={`url(#${id})`} fill="none" stroke={COBALT} strokeWidth={0.7}>
        {Array.from({ length: contours }, (_, k) => (
          <path key={k} d={line} transform={`translate(0 ${(k + 1) * gap})`} opacity={0.55 - k * (0.45 / contours)} />
        ))}
      </g>
      <path d={line} fill="none" stroke={COBALT} strokeWidth={1.2} />
    </g>
  );
}

/** A broadleaf tree: a tapered trunk that forks into the crown. */
function Tree({ x, top, rx, ry, seed }: { x: number; top: number; rx: number; ry: number; seed: number }) {
  const cy = top + ry;
  const fork = cy + ry * 0.35;
  const trunk = `M${x - 5} ${GROUND} C${x - 3} ${f(GROUND - 20)} ${x - 3} ${f(fork + 10)} ${x - 2} ${f(fork)} L${x + 2} ${f(fork)} C${x + 3} ${f(fork + 10)} ${x + 3} ${f(GROUND - 20)} ${x + 5} ${GROUND}Z`;
  const limbs = `M${x} ${f(fork)} Q${f(x - rx * 0.3)} ${f(cy + 4)} ${f(x - rx * 0.55)} ${f(cy - ry * 0.2)} M${x} ${f(fork)} Q${f(x + rx * 0.25)} ${f(cy)} ${f(x + rx * 0.5)} ${f(cy - ry * 0.35)} M${x} ${f(fork)} L${x} ${f(cy - ry * 0.5)}`;
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
      <path d={limbs} fill="none" stroke={COBALT} strokeWidth={2.2} />
      <path d={trunk} fill={PAPER} stroke={COBALT} strokeWidth={1.2} />
      <path d={`M${x - 1.5} ${GROUND - 4} L${x - 1} ${f(fork + 6)}`} stroke={COBALT} strokeWidth={0.7} />
      <Canopy cx={x} cy={cy} rx={rx} ry={ry} count={Math.round((rx * ry) / 34)} seed={seed} size={19} ink={PRINT} roses={0.04} berries={0.03} trunk={false} />
    </g>
  );
}

/** A poplar: a tall, narrow crown on a short trunk. */
function Poplar({ x, top, h, seed }: { x: number; top: number; h: number; seed: number }) {
  return (
    <g>
      <path d={`M${x} ${GROUND} L${x} ${top + h * 0.6}`} stroke={COBALT} strokeWidth={2.4} />
      <Canopy cx={x} cy={top + h / 2} rx={17} ry={h / 2} count={Math.round(h * 0.55)} seed={seed} size={14} ink={PRINT} roses={0} berries={0} trunk={false} />
    </g>
  );
}

/**
 * Edison's Black Maria: a long tar-papered shed with a taller room at one end, set on a turntable so it could follow
 * the sun, with a roof panel hinged open to let the light in.
 */
function BlackMaria({ x, s }: { x: number; s: number }) {
  const X = (u: number) => f(x + u * s);
  const Y = (v: number) => f(GROUND - 8 * s + v * s);
  const P = (pts: [number, number][]) => `M${pts.map(([u, v]) => `${X(u)} ${Y(v)}`).join(' L')}Z`;
  const wall = P([[-72, 0], [-72, -30], [48, -30], [48, 0]]);
  const roof = P([[-77, -30], [-68, -42], [44, -42], [52, -30]]);
  const opening = P([[-54, -42], [16, -42], [20, -36], [-50, -36]]);
  const lid = P([[-54, -42], [-66, -84], [4, -84], [16, -42]]);
  const room = P([[48, 0], [48, -54], [78, -54], [78, 0]]);
  const gable = P([[44, -54], [63, -70], [82, -54]]);
  const box = (u0: number, v0: number, u1: number, v1: number) => ({ x0: x + u0 * s, y0: GROUND - 8 * s + v0 * s, x1: x + u1 * s, y1: GROUND - 8 * s + v1 * s });
  return (
    <g stroke={COBALT} strokeLinejoin="round">
      {/* the turntable: a ring of track around a centre pivot */}
      <ellipse cx={X(0)} cy={Y(2)} rx={f(104 * s)} ry={f(8 * s)} fill={PAPER} strokeWidth={1.1} />
      <ellipse cx={X(0)} cy={Y(2)} rx={f(96 * s)} ry={f(6 * s)} fill="none" strokeWidth={0.6} strokeDasharray="1.5 3.5" />
      <path d={wall} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-wall" clip={wall} {...box(-72, -30, 48, 0)} gap={f(4.2 * s)} angle={0} ink={PRINT} width={0.8} opacity={0.85} />
      <path d={room} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-room" clip={room} {...box(48, -54, 78, 0)} gap={f(3.6 * s)} angle={0} ink={PRINT} width={0.9} opacity={0.85} />
      <path d={gable} fill={PAPER} strokeWidth={1.3} />
      <path d={roof} fill={PAPER} strokeWidth={1.3} />
      <Hatch id="bm-roof" clip={roof} {...box(-77, -42, 52, -30)} gap={f(4.5 * s)} angle={0.5} ink={PRINT} width={0.7} opacity={0.7} />
      <path d={opening} fill={COBALT} strokeWidth={1} />
      {/* the hinged roof panel, propped open on two struts */}
      <path d={lid} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-lid" clip={lid} {...box(-66, -84, 16, -42)} gap={f(5 * s)} angle={-0.28} ink={PRINT} width={0.7} opacity={0.6} />
      <path d={`M${X(-54)} ${Y(-42)} L${X(16)} ${Y(-42)}`} strokeWidth={1.8} />
      <path d={`M${X(-46)} ${Y(-40)} L${X(-58)} ${Y(-66)} M${X(8)} ${Y(-40)} L${X(-2)} ${Y(-66)}`} strokeWidth={1.1} />
      {/* door and windows */}
      <rect x={X(-16)} y={Y(-21)} width={f(11 * s)} height={f(21 * s)} fill={PAPER} strokeWidth={1.1} />
      <rect x={X(56)} y={Y(-44)} width={f(14 * s)} height={f(10 * s)} fill={PAPER} strokeWidth={1.1} />
      <path d={`M${X(63)} ${Y(-44)} L${X(63)} ${Y(-34)}`} strokeWidth={0.8} />
    </g>
  );
}

function Pole({ x, h }: { x: number; h: number }) {
  return (
    <g stroke={COBALT} strokeWidth={1.3} strokeLinecap="round">
      <line x1={x} y1={GROUND} x2={x} y2={GROUND - h} />
      <line x1={x - 16} y1={GROUND - h + 8} x2={x + 16} y2={GROUND - h + 8} />
      <line x1={x - 11} y1={GROUND - h + 18} x2={x + 11} y2={GROUND - h + 18} />
    </g>
  );
}

/** A hot-air balloon: a round-crowned envelope in striped gores, ropes to a wicker basket, a small flame at the throat. */
function Balloon({ x, y }: { x: number; y: number }) {
  const top = y - 34;
  const base = y + 34;
  /** A gore seam at fraction `k` of the full width: leaves the crown flat, then closes on the throat. */
  const seam = (k: number) => ({
    c1: [x + k * 50, top] as const,
    c2: [x + k * 40, y + 10] as const,
    end: [x + k * 7, base] as const,
  });
  const curve = (k: number) => {
    const { c1, c2, end } = seam(k);
    return `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
  };
  const back = (k: number) => {
    const { c1, c2 } = seam(k);
    return `C${f(c2[0])} ${f(c2[1])} ${f(c1[0])} ${f(c1[1])} ${x} ${top}`;
  };
  const ks = [-1, -0.6, -0.2, 0.2, 0.6, 1];
  const stripes = [0, 2, 4].map((i) => {
    const k0 = ks[i]!;
    const k1 = ks[i + 1]!;
    return `M${x} ${top} ${curve(k0)} L${f(x + k1 * 7)} ${base} ${back(k1)}Z`;
  }).join(' ');
  const seams = ks.slice(1, -1).map((k) => `M${x} ${top} ${curve(k)}`).join(' ');
  const outline = `M${x} ${top} ${curve(-1)} L${x + 7} ${base} ${back(1)}Z`;
  // where a rope leaves the envelope: the right edge at t = 0.8
  const t = 0.8;
  const e = seam(1);
  const bz = (p0: number, p1: number, p2: number, p3: number) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  const rx = bz(x, e.c1[0], e.c2[0], e.end[0]) - x;
  const ry = bz(top, e.c1[1], e.c2[1], e.end[1]);
  const bt = base + 16;
  return (
    <g stroke={COBALT} strokeLinejoin="round" strokeLinecap="round">
      <path d={outline} fill={PAPER} strokeWidth={1.3} />
      <path d={stripes} fill={COBALT} stroke="none" />
      <path d={seams} fill="none" strokeWidth={0.7} />
      <path d={outline} fill="none" strokeWidth={1.3} />
      <path d={`M${f(x - rx)} ${f(ry)} L${x - 8} ${bt} M${f(x + rx)} ${f(ry)} L${x + 8} ${bt} M${x - 7} ${base} L${x - 3} ${bt - 6} M${x + 7} ${base} L${x + 3} ${bt - 6}`} fill="none" strokeWidth={0.8} />
      <path d={`M${x} ${base + 3} Q${x + 3} ${base + 8} ${x} ${base + 11} Q${x - 3} ${base + 8} ${x} ${base + 3}Z`} fill={COBALT} strokeWidth={0.6} />
      <rect x={x - 10} y={bt} width={20} height={12} fill={PAPER} strokeWidth={1.2} />
      <path d={`M${x - 10} ${bt + 4} L${x + 10} ${bt + 4} M${x - 5} ${bt + 4} L${x - 5} ${bt + 12} M${x} ${bt + 4} L${x} ${bt + 12} M${x + 5} ${bt + 4} L${x + 5} ${bt + 12}`} fill="none" strokeWidth={0.6} />
    </g>
  );
}

/** The sun, engraved like the hero's moons: a disc, short rays, a dotted ring. */
function Sun({ x, y, r }: { x: number; y: number; r: number }) {
  const rays = Array.from({ length: 24 }, (_, k) => {
    const a = (k / 24) * Math.PI * 2;
    const r0 = r * 1.35;
    const r1 = r * (k % 2 ? 1.65 : 1.95);
    return `M${f(x + Math.cos(a) * r0)} ${f(y + Math.sin(a) * r0)} L${f(x + Math.cos(a) * r1)} ${f(y + Math.sin(a) * r1)}`;
  }).join(' ');
  return (
    <g stroke={COBALT} fill="none">
      <path d={rays} strokeWidth={1} strokeLinecap="round" />
      <circle cx={x} cy={y} r={r * 2.3} strokeWidth={0.8} strokeDasharray="1.5 5" opacity={0.6} />
      <circle cx={x} cy={y} r={r} fill={PAPER} strokeWidth={1.3} />
      <circle cx={x} cy={y} r={r * 0.7} strokeWidth={0.6} opacity={0.6} />
    </g>
  );
}

const BIRDS: [number, number, number][] = [
  [330, 78, 7], [356, 92, 5], [384, 72, 6], [880, 64, 6], [904, 80, 5], [930, 58, 7], [1010, 96, 5],
];

function Birds() {
  return (
    <g fill="none" stroke={COBALT} strokeWidth={1.1} strokeLinecap="round">
      {BIRDS.map(([x, y, s]) => <path key={x} d={`M${x - s} ${y} Q${x - s / 2} ${f(y - s * 0.6)} ${x} ${y} Q${x + s / 2} ${f(y - s * 0.6)} ${x + s} ${y}`} />)}
    </g>
  );
}

function Landscape({ className }: { className?: string }) {
  const river = `M0 ${GROUND - 30} C150 ${GROUND - 36} 300 ${GROUND - 16} 470 ${GROUND} L0 ${GROUND}Z`;
  const ripples: ReactNode[] = [];
  const r = rng(12);
  for (let k = 0; k < 22; k++) {
    const x = 14 + r() * 420;
    const y = GROUND - 3 - r() * 22;
    ripples.push(<path key={k} d={`M${f(x)} ${f(y)} l${f(8 + r() * 14)} 0`} />);
  }
  const poles = [1070, 1160, 1250];
  const wires = poles.slice(0, -1).map((x, i) => {
    const nx = poles[i + 1]!;
    return [-14, 14].map((dx) => `M${x + dx} ${GROUND - 104} Q${(x + nx) / 2} ${GROUND - 88} ${nx + dx} ${GROUND - 104}`).join(' ');
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className={className} aria-hidden>
      <rect width={W} height={H} fill={PAPER} />
      <Sun x={230} y={92} r={18} />
      <Birds />
      <Balloon x={1190} y={84} />
      <Hill id="hill-back" y={238} amp={46} seed={2} contours={5} gap={7} />
      <Hill id="hill-front" y={280} amp={22} seed={6} contours={2} gap={6} />
      {/* river and boat */}
      <clipPath id="river"><path d={river} /></clipPath>
      <path d={river} fill={PAPER} />
      <g clipPath="url(#river)" stroke={COBALT} strokeWidth={0.9} strokeLinecap="round" opacity={0.75}>{ripples}</g>
      <path d={`M0 ${GROUND - 30} C150 ${GROUND - 36} 300 ${GROUND - 16} 470 ${GROUND}`} fill="none" stroke={COBALT} strokeWidth={1.1} />
      <path d={`M250 ${GROUND - 22} L294 ${GROUND - 22} L285 ${GROUND - 13} L259 ${GROUND - 13}Z M272 ${GROUND - 22} L272 ${GROUND - 50} L290 ${GROUND - 26}Z`} fill={PAPER} stroke={COBALT} strokeWidth={1.1} strokeLinejoin="round" />
      <Tree x={70} top={176} rx={62} ry={48} seed={101} />
      <Tree x={182} top={214} rx={42} ry={34} seed={102} />
      <Poplar x={492} top={196} h={104} seed={103} />
      <Tree x={548} top={196} rx={46} ry={40} seed={104} />
      <Poplar x={892} top={190} h={110} seed={105} />
      <Tree x={966} top={198} rx={50} ry={40} seed={106} />
      {poles.map((x, i) => <Pole key={x} x={x} h={112 - i * 4} />)}
      <path d={wires} fill="none" stroke={COBALT} strokeWidth={0.8} />
      <Tree x={1330} top={180} rx={56} ry={46} seed={107} />
      <Tree x={1418} top={218} rx={38} ry={32} seed={108} />
      <BlackMaria x={724} s={1.3} />
      <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={COBALT} />
    </svg>
  );
}

export default memo(Landscape);
