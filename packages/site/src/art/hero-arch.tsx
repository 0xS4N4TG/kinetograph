/**
 * The hero plate: a classical arch on a cobalt ground, framed by toile canopies, with a film reel on a pedestal to
 * each side and a strip of film running from each reel into the trees. The inside of the arch is left as open paper
 * for the headline. viewBox 1440 x 800.
 */

import { memo } from 'react';
import { Camera } from './camera';
import { Canopy, COBALT, FilmStrip, Hatch, type Ink, Moon, PAPER, Reel, Stars, Vine, rng } from './engrave';

const W = 1440;
const H = 800;
const CX = 720;
const SPRING = 480; // the arch's springline
const RI = 272;
const RO = 326;
const FLOOR = 762;

const CUT: Ink = { line: PAPER, ground: COBALT }; // cream lines cut into cobalt
const PRINT: Ink = { line: COBALT, ground: PAPER }; // cobalt lines printed on cream

const f = (n: number) => Math.round(n * 10) / 10;

function Voussoirs() {
  const stones: string[] = [];
  const n = 17;
  const mid = Math.floor(n / 2);
  for (let k = 0; k < n; k++) {
    if (k === mid) continue;
    const a0 = Math.PI + (k / n) * Math.PI;
    const a1 = Math.PI + ((k + 1) / n) * Math.PI;
    const p = (r: number, a: number) => `${f(CX + Math.cos(a) * r)} ${f(SPRING + Math.sin(a) * r)}`;
    stones.push(`M${p(RI, a0)} L${p(RO, a0)} A${RO} ${RO} 0 0 1 ${p(RO, a1)} L${p(RI, a1)} A${RI} ${RI} 0 0 0 ${p(RI, a0)}Z`);
  }
  // the keystone stands proud of the arch
  const kw0 = 20;
  const kw1 = 30;
  const key = `M${CX - kw0} ${SPRING - RI + 2} L${CX - kw1} ${SPRING - RO - 22} L${CX + kw1} ${SPRING - RO - 22} L${CX + kw0} ${SPRING - RI + 2}Z`;
  return (
    <g fill={PAPER} stroke={COBALT} strokeWidth={1.4} strokeLinejoin="round">
      <path d={`M${CX - RO - 10} ${SPRING} A${RO + 10} ${RO + 10} 0 0 1 ${CX + RO + 10} ${SPRING}`} fill="none" stroke={PAPER} strokeWidth={2} />
      {stones.map((d, i) => <path key={i} d={d} />)}
      <path d={`M${CX - RI - 12} ${SPRING} A${RI + 12} ${RI + 12} 0 0 1 ${CX + RI + 12} ${SPRING}`} fill="none" strokeWidth={0.9} />
      <path d={`M${CX - RO + 9} ${SPRING} A${RO - 9} ${RO - 9} 0 0 1 ${CX + RO - 9} ${SPRING}`} fill="none" strokeWidth={0.9} />
      <path d={key} strokeWidth={1.6} />
      <path d={`M${CX - kw0 + 6} ${SPRING - RI - 6} L${CX - kw1 + 7} ${SPRING - RO - 15} L${CX + kw1 - 7} ${SPRING - RO - 15} L${CX + kw0 - 6} ${SPRING - RI - 6}Z`} fill="none" strokeWidth={0.9} />
      <Hatch id="key-h" clip={key} x0={CX - kw1} y0={SPRING - RO - 22} x1={CX + kw1} y1={SPRING - RI + 2} gap={4} angle={0.7} ink={PRINT} width={0.6} opacity={0.5} />
    </g>
  );
}

function Urn() {
  const top = SPRING - RO - 22; // the keystone's top
  const y = top - 4;
  return (
    <g fill={PAPER} stroke={COBALT} strokeWidth={1.3} strokeLinejoin="round">
      <rect x={CX - 34} y={y - 6} width={68} height={10} />
      <path d={`M${CX - 14} ${y - 6} L${CX - 10} ${y - 16} L${CX + 10} ${y - 16} L${CX + 14} ${y - 6}Z`} />
      <path d={`M${CX - 30} ${y - 46} C${CX - 34} ${y - 22} ${CX - 16} ${y - 16} ${CX} ${y - 16} C${CX + 16} ${y - 16} ${CX + 34} ${y - 22} ${CX + 30} ${y - 46}Z`} />
      <path d={`M${CX - 36} ${y - 46} L${CX + 36} ${y - 46} L${CX + 32} ${y - 52} L${CX - 32} ${y - 52}Z`} />
      {[-18, -6, 6, 18].map((dx) => <line key={dx} x1={CX + dx} y1={y - 44} x2={CX + dx * 0.8} y2={y - 20} strokeWidth={0.8} />)}
    </g>
  );
}

/** Where the screen hangs in the arch, in plate units. The page lays the title over this box. */
export const SCREEN = { x: CX - 230, y: 330, w: 460, h: 214 };
/** Where the command bar and buttons go: on the floor under the screen. */
export const CONTROLS = { x: CX - 250, y: 576, w: 500, h: 120 };
/** The front of the camera's lens (the camera is drawn at translate(415 340) scale(-0.72 0.72)). */
const LENS: [number, number] = [415 - 84 * 0.72, 340 + 331 * 0.72];

/** The projection screen: a framed sheet on a rod, hung from the arch by two cords. */
function Screen() {
  const { x, y, w, h } = SCREEN;
  const cordTop = (dx: number) => SPRING - Math.sqrt(RI * RI - dx * dx);
  return (
    <g stroke={COBALT} strokeLinejoin="round">
      {[-200, 200].map((dx) => <line key={dx} x1={CX + dx} y1={f(cordTop(dx))} x2={CX + dx} y2={y - 8} strokeWidth={1.2} />)}
      <rect x={x - 14} y={y - 10} width={w + 28} height={7} rx={3} fill={PAPER} strokeWidth={1.3} />
      <circle cx={x - 18} cy={y - 6.5} r={5} fill={PAPER} strokeWidth={1.2} />
      <circle cx={x + w + 18} cy={y - 6.5} r={5} fill={PAPER} strokeWidth={1.2} />
      <rect x={x - 6} y={y - 3} width={w + 12} height={h + 6} fill={COBALT} strokeWidth={1} />
      <rect x={x} y={y} width={w} height={h} fill="#fffdf7" stroke="none" />
      <rect x={x + 6} y={y + 6} width={w - 12} height={h - 12} fill="none" strokeWidth={0.7} opacity={0.35} />
    </g>
  );
}

/**
 * The beam from the lens to the screen, engraved as rays: each ray is a wide soft cream line under a thin cobalt one,
 * so it reads on the cobalt ground and on the paper of the arch. Dust turns in it.
 */
function Beam() {
  const { x, y, w, h } = SCREEN;
  const [lx, ly] = LENS;
  const targets: [number, number][] = [];
  for (let k = 0; k <= 16; k++) targets.push([x + (k / 16) * w, y]);
  for (let k = 1; k <= 8; k++) targets.push([x + w, y + (k / 8) * h]);
  const rays = targets.map(([tx, ty]) => `M${f(lx)} ${f(ly)} L${f(tx)} ${f(ty)}`).join(' ');
  const hull = `M${f(lx)} ${f(ly)} L${x} ${y} L${x + w} ${y} L${x + w} ${y + h}Z`;
  const r = rng(77);
  const dust = Array.from({ length: 34 }, (_, i) => {
    const u = r();
    const v = r();
    const tx = x + v * w;
    const ty = y + r() * h;
    return <circle key={i} className="kg-dust" style={{ animationDelay: `${f(r() * 6)}s` }} cx={f(lx + (tx - lx) * u)} cy={f(ly + (ty - ly) * u)} r={f(0.8 + r() * 1.4)} fill={PAPER} />;
  });
  return (
    <g className="kg-flicker" pointerEvents="none">
      <defs>
        <linearGradient id="beam-fill" gradientUnits="userSpaceOnUse" x1={lx} y1={ly} x2={x + w} y2={y}>
          <stop offset="0" stopColor={PAPER} stopOpacity="0.8" />
          <stop offset="1" stopColor={PAPER} stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <path d={hull} fill="url(#beam-fill)" />
      <path d={rays} stroke={PAPER} strokeWidth={3} opacity={0.45} fill="none" />
      <path d={rays} stroke={COBALT} strokeWidth={0.7} opacity={0.4} fill="none" />
      <g>{dust}</g>
      <circle cx={lx} cy={ly} r={10} fill={PAPER} opacity={0.9} />
    </g>
  );
}

function Column({ x }: { x: number }) {
  const w = 58;
  const top = SPRING + 34;
  const foot = FLOOR - 40;
  const flutes = Array.from({ length: 7 }, (_, k) => x - w / 2 + 6 + k * ((w - 12) / 6));
  return (
    <g fill={PAPER} stroke={COBALT} strokeWidth={1.3} strokeLinejoin="round">
      {/* impost and Ionic capital */}
      <rect x={x - w / 2 - 14} y={SPRING - 2} width={w + 28} height={12} />
      <path d={`M${x - w / 2 - 8} ${SPRING + 10} L${x + w / 2 + 8} ${SPRING + 10} L${x + w / 2 + 2} ${top} L${x - w / 2 - 2} ${top}Z`} />
      {[-1, 1].map((s) => (
        <g key={s} fill="none" strokeWidth={1}>
          <circle cx={x + s * (w / 2 + 4)} cy={SPRING + 20} r={9} fill={PAPER} />
          <circle cx={x + s * (w / 2 + 4)} cy={SPRING + 20} r={5} />
          <circle cx={x + s * (w / 2 + 4)} cy={SPRING + 20} r={1.6} fill={COBALT} />
        </g>
      ))}
      {/* shaft */}
      <rect x={x - w / 2} y={top} width={w} height={foot - top} />
      <path d={flutes.map((fx) => `M${f(fx)} ${top + 6} L${f(fx)} ${foot - 6}`).join(' ')} strokeWidth={0.8} fill="none" />
      <Hatch id={`col-${x}`} clip={`M${x + w / 2 - 14} ${top} L${x + w / 2} ${top} L${x + w / 2} ${foot} L${x + w / 2 - 14} ${foot}Z`} x0={x} y0={top} x1={x + w} y1={foot} gap={3.2} angle={0} ink={PRINT} width={0.6} opacity={0.7} />
      {/* base and plinth */}
      <rect x={x - w / 2 - 6} y={foot} width={w + 12} height={10} />
      <rect x={x - w / 2 - 12} y={foot + 10} width={w + 24} height={30} />
      <rect x={x - w / 2 - 6} y={foot + 16} width={w + 12} height={18} fill="none" strokeWidth={0.8} />
    </g>
  );
}

/** The inside of the arch: open paper, faint rays from a vanishing point, a floor in perspective and a small studio. */
function Interior() {
  const clip = `M${CX - RI} ${FLOOR} L${CX - RI} ${SPRING} A${RI} ${RI} 0 0 1 ${CX + RI} ${SPRING} L${CX + RI} ${FLOOR}Z`;
  const floorTop = 690;
  const lanes = Array.from({ length: 17 }, (_, k) => {
    const bx = CX - RI + (k / 16) * RI * 2;
    return `M${f(CX + (bx - CX) * 0.18)} ${floorTop} L${f(bx)} ${FLOOR}`;
  }).join(' ');
  const rows = Array.from({ length: 6 }, (_, k) => {
    const y = floorTop + Math.pow((k + 1) / 6, 1.7) * (FLOOR - floorTop);
    return `M${CX - RI} ${f(y)} L${CX + RI} ${f(y)}`;
  }).join(' ');
  return (
    <g>
      <clipPath id="arch-in"><path d={clip} /></clipPath>
      <path d={clip} fill={PAPER} />
      <g clipPath="url(#arch-in)" fill="none" stroke={COBALT}>
        <path d={`M${CX - RI} ${floorTop} L${CX + RI} ${floorTop}`} strokeWidth={1} opacity={0.6} />
        <path d={lanes} strokeWidth={0.7} opacity={0.4} />
        <path d={rows} strokeWidth={0.7} opacity={0.4} />
      </g>
      <path d={clip} fill="none" stroke={COBALT} strokeWidth={1.4} />
    </g>
  );
}

/** Edison's Kinetoscope (1893), the viewer for Kinetograph films: a wooden cabinet with a peephole hood on top. */
function Kinetoscope({ x }: { x: number }) {
  const w = 150;
  const top = 486;
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const d = 20; // the side face's depth, drawn in oblique
  const side = `M${x1} ${top} L${x1 + d} ${top - 14} L${x1 + d} ${FLOOR - 30} L${x1} ${FLOOR - 16}Z`;
  const grain = Array.from({ length: 22 }, (_, k) => {
    const y = top + 18 + k * 11.5;
    return `M${x0 + 6} ${y} C${x0 + 50} ${y + 3 * Math.sin(k)} ${x1 - 50} ${y - 2} ${x1 - 6} ${y + 1.5 * Math.cos(k)}`;
  }).join(' ');
  return (
    <g fill={PAPER} stroke={COBALT} strokeWidth={1.3} strokeLinejoin="round">
      {/* hood and eyepiece */}
      <path d={`M${x - 34} ${top - 12} L${x - 22} ${top - 56} L${x + 22} ${top - 56} L${x + 34} ${top - 12}Z`} />
      <Hatch id="ks-hood" clip={`M${x + 10} ${top - 12} L${x + 14} ${top - 56} L${x + 22} ${top - 56} L${x + 34} ${top - 12}Z`} x0={x} y0={top - 56} x1={x + 34} y1={top} gap={2.4} angle={0} ink={PRINT} width={0.7} />
      <rect x={x - 26} y={top - 66} width={52} height={10} rx={3} />
      <ellipse cx={x - 10} cy={top - 61} rx={7} ry={3} fill={COBALT} />
      <ellipse cx={x + 10} cy={top - 61} rx={7} ry={3} fill={COBALT} />
      {/* lid */}
      <path d={`M${x0 - 10} ${top - 12} L${x1 + 10} ${top - 12} L${x1 + 10 + d} ${top - 24} L${x0 - 10 + d} ${top - 24}Z`} />
      <rect x={x0 - 10} y={top - 12} width={w + 20} height={12} />
      {/* cabinet */}
      <path d={side} />
      <Hatch id="ks-side" clip={side} x0={x1} y0={top - 14} x1={x1 + d} y1={FLOOR} gap={2.2} angle={0} ink={PRINT} width={0.7} />
      <rect x={x0} y={top} width={w} height={FLOOR - 16 - top} />
      <path d={grain} fill="none" strokeWidth={0.5} opacity={0.55} />
      {/* the upper panel is glass: the film loop turns behind it */}
      <rect x={x0 + 14} y={top + 16} width={w - 28} height={104} fill={PAPER} />
      <rect x={x0 + 20} y={top + 22} width={w - 40} height={92} fill="none" strokeWidth={0.8} />
      <Reel x={x - 22} y={top + 68} r={30} ink={PRINT} className="kg-spin" />
      <Reel x={x + 30} y={top + 68} r={22} ink={PRINT} className="kg-spin-rev" />
      {/* the lower panel: maker's plate and coin slot */}
      <rect x={x0 + 14} y={top + 134} width={w - 28} height={FLOOR - 46 - (top + 134)} fill="none" />
      <rect x={x - 32} y={top + 156} width={64} height={28} rx={2} />
      <path d={`M${x - 20} ${top + 166} L${x + 20} ${top + 166} M${x - 14} ${top + 174} L${x + 14} ${top + 174}`} strokeWidth={0.9} />
      <rect x={x - 12} y={top + 200} width={24} height={5} rx={2} fill={COBALT} />
      <Hatch id="ks-front" clip={`M${x1 - 16} ${top} L${x1} ${top} L${x1} ${FLOOR - 16} L${x1 - 16} ${FLOOR - 16}Z`} x0={x1 - 16} y0={top} x1={x1} y1={FLOOR} gap={3} angle={0} ink={PRINT} width={0.6} opacity={0.7} />
      {/* plinth */}
      <rect x={x0 - 8} y={FLOOR - 16} width={w + 16 + d} height={16} />
    </g>
  );
}

function side(seed: number, mirror: boolean) {
  const X = (x: number) => (mirror ? W - x : x);
  const r = rng(seed);
  const canopies = [
    { cx: 110, cy: 300, rx: 175, ry: 250, count: 620 },
    { cx: 60, cy: 650, rx: 170, ry: 170, count: 360 },
    { cx: 360, cy: 300, rx: 70, ry: 150, count: 200 },
    { cx: 350, cy: 600, rx: 80, ry: 190, count: 260 },
    { cx: 230, cy: 770, rx: 170, ry: 70, count: 200 },
  ];
  return (
    <g>
      {canopies.map((c, i) => (
        <Canopy key={i} cx={X(c.cx)} cy={c.cy} rx={c.rx} ry={c.ry} count={c.count} seed={seed * 31 + i} size={21 + r() * 4} ink={CUT} roses={0.06} />
      ))}
    </g>
  );
}

function HeroArch({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <defs>
        <pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse">
          <rect width="4" height="1" fill={PAPER} opacity="0.06" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill={COBALT} />
      <Stars x0={20} y0={20} x1={W - 20} y1={460} count={90} seed={7} ink={CUT} avoid={[CX - RO - 20, 120, CX + RO + 20, 800]} />
      <Moon x={300} y={104} r={22} ink={CUT} />
      <Moon x={W - 300} y={104} r={22} ink={CUT} />
      {side(3, false)}
      {side(11, true)}

      <Interior />
      <Voussoirs />
      <Urn />
      <Canopy cx={CX} cy={SPRING - RO - 92} rx={58} ry={30} count={70} seed={41} size={15} ink={CUT} roses={0.18} berries={0} trunk={false} />
      <Column x={CX - RI - 30} />
      <Column x={CX + RI + 30} />
      <Vine x={CX - RO + 4} y={SPRING + 150} angle={-1.95} length={240} seed={23} size={16} ink={CUT} />
      <Vine x={CX + RO - 4} y={SPRING + 150} angle={-1.19} length={240} seed={24} size={16} ink={CUT} />

      {/* the Kinetograph on its tripod, its lens turned toward the arch */}
      <Beam />
      <Screen />
      <FilmStrip p0={[134, 440]} c1={[60, 380]} c2={[190, 240]} p1={[70, 96]} width={30} frames={9} ink={CUT} />
      <g transform="translate(415 340) scale(-0.72 0.72)">
        <Camera idp="hero" />
      </g>
      {/* and the Kinetoscope its films were watched in */}
      <FilmStrip p0={[W - 222, 432]} c1={[W - 90, 380]} c2={[W - 200, 240]} p1={[W - 70, 96]} width={30} frames={9} ink={CUT} />
      <Kinetoscope x={W - 222} />

      <rect x={0} y={FLOOR} width={W} height={H - FLOOR} fill={COBALT} />
      <line x1={0} y1={FLOOR} x2={W} y2={FLOOR} stroke={PAPER} strokeWidth={2} />
      <line x1={0} y1={FLOOR + 6} x2={W} y2={FLOOR + 6} stroke={PAPER} strokeWidth={0.8} />
      <rect width={W} height={H} fill="url(#scan)" pointerEvents="none" />
    </svg>
  );
}

export default memo(HeroArch);
