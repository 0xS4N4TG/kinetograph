'use client';

/**
 * The hero plate: a length of film running across a cobalt toile engraving. The frame in the gate is a window for the
 * live clip (the hero lays a <video> over GATE); the frames either side hold stills from the same film.
 * viewBox 840 x 720, drawn to fill its box exactly, so HTML can sit on it in percentages.
 */

import { memo } from 'react';
import { Canopy, COBALT, type Ink, Moon, PAPER, Stars, Vine } from './engrave';

export const PLATE = { w: 840, h: 720 };

const STRIP = { y: 196, h: 328 };
const FRAME_H = 232;
const FRAME_W = Math.round((FRAME_H * 16) / 9);
const FRAME_Y = STRIP.y + (STRIP.h - FRAME_H) / 2;
const GAP = 26;
const CX = PLATE.w / 2;

/** The frame in the gate, in plate units. */
export const GATE = { x: CX - FRAME_W / 2, y: FRAME_Y, w: FRAME_W, h: FRAME_H };
/** The strip's bottom margin, below the sprockets, where film carries its edge code. */
export const EDGE = { x: GATE.x, y: STRIP.y + STRIP.h - 17, w: FRAME_W, h: 15 };

const ON_COBALT: Ink = { line: PAPER, ground: COBALT };

function Strip() {
  const top = STRIP.y;
  const bottom = STRIP.y + STRIP.h;
  const holes: string[] = [];
  for (let x = -14; x < PLATE.w + 20; x += 34) {
    for (const y of [top + 18, bottom - 18 - 20]) holes.push(`M${x} ${y + 3} q0 -3 3 -3 h12 q3 0 3 3 v14 q0 3 -3 3 h-12 q-3 0 -3 -3Z`);
  }
  const side = [
    { x: GATE.x - GAP - FRAME_W, src: '/film/poster.jpg' },
    { x: GATE.x + FRAME_W + GAP, src: '/film/s09-150.jpg' },
  ];
  return (
    <g>
      <rect x={-10} y={top} width={PLATE.w + 20} height={STRIP.h} fill={PAPER} />
      <path d={holes.join(' ')} fill={COBALT} />
      <path d={`M-10 ${top + 5} H${PLATE.w + 10}`} stroke={COBALT} strokeWidth={0.8} opacity={0.5} />
      {side.map((s) => (
        <g key={s.src}>
          <image href={s.src} x={s.x} y={FRAME_Y} width={FRAME_W} height={FRAME_H} preserveAspectRatio="xMidYMid slice" />
          <rect x={s.x} y={FRAME_Y} width={FRAME_W} height={FRAME_H} fill={COBALT} opacity={0.55} />
        </g>
      ))}
      <rect x={GATE.x} y={FRAME_Y} width={FRAME_W} height={FRAME_H} fill={COBALT} />
      {[GATE.x - GAP - FRAME_W, GATE.x, GATE.x + FRAME_W + GAP].map((x) => (
        <rect key={x} x={x} y={FRAME_Y} width={FRAME_W} height={FRAME_H} fill="none" stroke={COBALT} strokeWidth={1.4} />
      ))}
      {[GATE.x - GAP - FRAME_W, GATE.x, GATE.x + FRAME_W + GAP].map((x) => (
        <text key={x} x={x} y={top + 14} fill={COBALT} fontSize={9} letterSpacing={3} fontFamily="'Geist Mono Variable', ui-monospace, monospace" opacity={0.7}>
          KINETOGRAPH
        </text>
      ))}
    </g>
  );
}

function HeroPlate({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${PLATE.w} ${PLATE.h}`} className={className} aria-hidden>
      <rect width={PLATE.w} height={PLATE.h} fill={COBALT} />
      <Stars x0={20} y0={20} x1={PLATE.w - 20} y1={STRIP.y - 10} count={26} seed={7} ink={ON_COBALT} avoid={[0, 0, 300, 190]} />
      <Stars x0={20} y0={STRIP.y + STRIP.h + 10} x1={PLATE.w - 20} y1={PLATE.h - 20} count={20} seed={8} ink={ON_COBALT} avoid={[560, 540, 840, 720]} />
      <Moon x={560} y={104} r={24} ink={ON_COBALT} />
      <Vine x={300} y={36} angle={0.05} length={200} seed={21} size={20} ink={ON_COBALT} />
      <Canopy cx={70} cy={92} rx={190} ry={130} count={90} seed={11} size={34} ink={ON_COBALT} roses={0.06} berries={0.04} />
      <Canopy cx={830} cy={60} rx={130} ry={110} count={56} seed={12} size={32} ink={ON_COBALT} roses={0.05} />
      <Canopy cx={110} cy={690} rx={200} ry={130} count={90} seed={13} size={34} ink={ON_COBALT} roses={0.06} berries={0.04} />
      <Canopy cx={790} cy={680} rx={170} ry={120} count={70} seed={14} size={32} ink={ON_COBALT} roses={0.05} />
      <Vine x={360} y={PLATE.h - 40} angle={-0.04} length={190} seed={22} size={20} ink={ON_COBALT} />
      <Strip />
      <rect x={10} y={10} width={PLATE.w - 20} height={PLATE.h - 20} fill="none" stroke={PAPER} strokeWidth={1} opacity={0.45} />
    </svg>
  );
}

export default memo(HeroPlate);
