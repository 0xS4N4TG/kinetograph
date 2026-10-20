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

function hill(y: number, amp: number, seed: number) {
  const r = rng(seed);
  let d = `M0 ${y}`;
  const n = 8;
  for (let k = 1; k <= n; k++) {
    const x = (k / n) * W;
    d += ` S${f(x - W / n / 2)} ${f(y - amp * (0.3 + r()))} ${f(x)} ${f(y - amp * r() * 0.5)}`;
  }
  return d;
}

/** Edison's Black Maria: a tar-papered shed on a turntable, its roof hinged open to let the sun in. */
function BlackMaria({ x, y, s }: { x: number; y: number; s: number }) {
  const X = (u: number) => f(x + u * s);
  const Y = (v: number) => f(y + v * s);
  const body = `M${X(-60)} ${Y(0)} L${X(-60)} ${Y(-40)} L${X(40)} ${Y(-40)} L${X(40)} ${Y(0)}Z`;
  const tower = `M${X(40)} ${Y(0)} L${X(40)} ${Y(-56)} L${X(64)} ${Y(-50)} L${X(64)} ${Y(0)}Z`;
  const flap = `M${X(-52)} ${Y(-40)} L${X(-38)} ${Y(-76)} L${X(30)} ${Y(-76)} L${X(32)} ${Y(-40)}Z`;
  return (
    <g stroke={COBALT} strokeLinejoin="round">
      {Array.from({ length: 11 }, (_, k) => {
        const a = -Math.PI / 2 + (k - 5) * 0.17;
        return <line key={k} x1={X(-10)} y1={Y(-112)} x2={f(x + (-10 + Math.cos(a) * 70) * s)} y2={f(y + (-112 + Math.sin(a) * 70) * s)} strokeWidth={0.8} opacity={0.5} />;
      })}
      <circle cx={X(-10)} cy={Y(-112)} r={11 * s} fill={PAPER} strokeWidth={1.1} />
      <path d={body} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-body" clip={body} x0={x - 60 * s} y0={y - 40 * s} x1={x + 40 * s} y1={y} gap={2.2} angle={0} ink={PRINT} width={1} />
      <path d={tower} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-tower" clip={tower} x0={x + 40 * s} y0={y - 56 * s} x1={x + 64 * s} y1={y} gap={2.4} angle={0.9} ink={PRINT} width={0.9} />
      <path d={flap} fill={PAPER} strokeWidth={1.4} />
      <Hatch id="bm-flap" clip={flap} x0={x - 52 * s} y0={y - 76 * s} x1={x + 32 * s} y1={y - 40 * s} gap={3.4} angle={1.2} ink={PRINT} width={0.7} opacity={0.7} />
      <line x1={X(-38)} y1={Y(-76)} x2={X(-58)} y2={Y(-40)} strokeWidth={0.9} />
      <rect x={X(-14)} y={Y(-22)} width={12 * s} height={22 * s} fill={PAPER} strokeWidth={1} />
      <ellipse cx={X(0)} cy={Y(4)} rx={96 * s} ry={7 * s} fill="none" strokeWidth={1} />
      <ellipse cx={X(0)} cy={Y(4)} rx={84 * s} ry={5 * s} fill="none" strokeWidth={0.6} strokeDasharray="2 3" />
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

function Balloon({ x, y }: { x: number; y: number }) {
  const gores = [-0.75, -0.4, 0, 0.4, 0.75].map((k) => `M${x} ${y - 30} Q${f(x + k * 34)} ${y} ${x} ${y + 30}`).join(' ');
  return (
    <g stroke={COBALT} fill={PAPER} strokeWidth={1.2}>
      <ellipse cx={x} cy={y} rx={26} ry={30} />
      <path d={gores} fill="none" strokeWidth={0.8} />
      <path d={`M${x - 26} ${y} L${x + 26} ${y}`} fill="none" strokeWidth={0.8} />
      <path d={`M${x - 14} ${y + 25} L${x - 6} ${y + 44} M${x + 14} ${y + 25} L${x + 6} ${y + 44}`} fill="none" strokeWidth={0.8} />
      <rect x={x - 7} y={y + 44} width={14} height={9} />
    </g>
  );
}

function Birds({ seed, x0, x1, y0, y1, n }: { seed: number; x0: number; x1: number; y0: number; y1: number; n: number }) {
  const r = rng(seed);
  const out: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    const s = 4 + r() * 4;
    out.push(<path key={i} d={`M${f(x - s)} ${f(y)} Q${f(x - s / 2)} ${f(y - s * 0.6)} ${f(x)} ${f(y)} Q${f(x + s / 2)} ${f(y - s * 0.6)} ${f(x + s)} ${f(y)}`} fill="none" stroke={COBALT} strokeWidth={1.1} strokeLinecap="round" />);
  }
  return <g>{out}</g>;
}

function Landscape({ className }: { className?: string }) {
  const trees = [
    [70, 250, 60, 46, 150], [190, 262, 44, 36, 90], [520, 262, 50, 40, 110], [600, 250, 34, 44, 80],
    [890, 258, 56, 42, 120], [985, 268, 36, 30, 70], [1300, 252, 54, 46, 130], [1400, 262, 40, 34, 80],
  ] as const;
  const poles = [1080, 1170, 1260];
  const wires = poles.slice(0, -1).map((x, i) => {
    const nx = poles[i + 1]!;
    return [0, 10].map((dy) => `M${x} ${GROUND - 112 + 8 + dy} Q${(x + nx) / 2} ${GROUND - 112 + 28 + dy} ${nx} ${GROUND - 112 + 8 + dy}`).join(' ');
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className={className} aria-hidden>
      <rect width={W} height={H} fill={PAPER} />
      <Birds seed={4} x0={300} x1={700} y0={70} y1={150} n={9} />
      <Birds seed={9} x0={900} x1={1200} y0={60} y1={130} n={6} />
      <Balloon x={1210} y={92} />
      {/* far skyline */}
      <g stroke={COBALT} fill={PAPER} strokeWidth={0.9} opacity={0.7}>
        {[[1310, 60], [1330, 90], [1356, 70], [1376, 110], [1404, 80]].map(([x, h]) => <rect key={x} x={x} y={GROUND - 60 - h!} width={20} height={h} />)}
      </g>
      <path d={`${hill(244, 40, 2)} L${W} ${H} L0 ${H}Z`} fill={PAPER} stroke={COBALT} strokeWidth={1} />
      <Hatch id="hill-back" clip={`${hill(244, 40, 2)} L${W} ${H} L0 ${H}Z`} x0={0} y0={180} x1={W} y1={H} gap={6} angle={0} ink={PRINT} width={0.5} opacity={0.45} />
      <path d={`${hill(276, 26, 6)} L${W} ${H} L0 ${H}Z`} fill={PAPER} stroke={COBALT} strokeWidth={1.2} />
      {/* river and boat */}
      <path d={`M0 ${GROUND - 14} C120 ${GROUND - 30} 260 ${GROUND - 4} 420 ${GROUND - 22} L420 ${GROUND} L0 ${GROUND}Z`} fill={PAPER} stroke={COBALT} strokeWidth={1} />
      <path d={Array.from({ length: 14 }, (_, k) => `M${30 + k * 26} ${GROUND - 8 - (k % 3) * 3} l12 0`).join(' ')} stroke={COBALT} strokeWidth={0.9} />
      <path d={`M250 ${GROUND - 20} L292 ${GROUND - 20} L284 ${GROUND - 12} L258 ${GROUND - 12}Z M271 ${GROUND - 20} L271 ${GROUND - 46} L288 ${GROUND - 24}Z`} fill={PAPER} stroke={COBALT} strokeWidth={1.1} strokeLinejoin="round" />
      {trees.map(([x, y, rx, ry, n], i) => (
        <g key={i}>
          <path d={`M${x} ${GROUND} L${x} ${y}`} stroke={COBALT} strokeWidth={2} />
          <Canopy cx={x} cy={y - ry * 0.4} rx={rx} ry={ry} count={n} seed={100 + i} size={13} ink={PRINT} roses={0.03} />
        </g>
      ))}
      {poles.map((x, i) => <Pole key={x} x={x} h={112 - i * 4} />)}
      <path d={wires} fill="none" stroke={COBALT} strokeWidth={0.8} />
      <BlackMaria x={730} y={GROUND - 6} s={1.25} />
      <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={COBALT} />
      <line x1={0} y1={GROUND - 5} x2={W} y2={GROUND - 5} stroke={COBALT} strokeWidth={0.8} />
    </svg>
  );
}

export default memo(Landscape);
