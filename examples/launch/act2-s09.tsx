// Shot 9: "This whole film rendered in twenty-three seconds." This film's own frames run past on a strip of film as a
// render clock counts up beside a frame counter; the strip stops when the counter reaches the last frame, and the
// clock holds at the film's measured render time (RENDER_SECONDS, common.tsx), set very large, with the film's own
// length under it for scale.

import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import { Layer } from '@kinetograph/core';
import { CLAMP, FPS, InkGround, MONO, OUT, RED, RENDER_SECONDS, SANS, TITLE, TITLE_GLOW, TITLE_WEIGHT, W } from './common.js';
import { TOTAL, spoken } from './sound-timing.js';

/** Frames of the shot over which the render runs, start to finish (the strip moving, the clock and counter counting):
 *  the clock reaches the render time as the voiceover says it. */
export const RACE = [8, spoken('09-film')[5]!.from + 2] as const;

const STILLS = [
  'v2-veteran-iron', 'v2-s03', 'v2-hat-1bit', 'v2-m3', 'v2-s05-pass', 'v2-beard-iron', 'v2-crowd-vhs', 'v2-m4', 'v2-s05',
  'v2-veteran-rainbow', 'v2-m5', 'v2-veteran-crt', 'v2-s08', 'v2-hat-crt', 'v2-s10', 'v2-crowd-1bit', 'v2-pair-vhs',
].map((n) => staticFile(`self/${n}.jpg`));
const CELL_W = 400;
const CELL_H = 225;
const GAP = 34;
const STRIP_Y = 210;
const STRIP_H = CELL_H + 92;
/** How far the strip runs over the render, in px: many frames' worth, so it reads as a reel going by. */
const RUN = 46 * (CELL_W + GAP);

const clock = (s: number) => String(Math.floor(s));

export const S09: React.FC = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [...RACE], [0, 1], { ...CLAMP, easing: (t) => t * t * (3 - 2 * t) });
  const done = frame >= RACE[1];
  const offset = p * RUN;
  const counter = Math.round(p * TOTAL);
  const stripIn = interpolate(frame, [0, 8], [0, 1], { ...CLAMP, easing: OUT });
  const settle = done ? spring({ frame: frame - RACE[1], fps: FPS, config: { damping: 10, stiffness: 170 } }) : 0;
  const pop = 1 + 0.04 * Math.sin(settle * Math.PI);
  const capIn = interpolate(frame, [RACE[1] + 4, RACE[1] + 14], [0, 1], { ...CLAMP, easing: OUT });
  const moving = !done && frame > RACE[0];
  const first = Math.floor(offset / (CELL_W + GAP));
  return (
    <AbsoluteFill>
      <InkGround />
      {/* the strip: the film's frames between rows of sprocket holes, lit from behind */}
      <Layer id="s09-strip" opacity={stripIn} motionBlur={moving ? { samples: 10, shutter: 0.5 } : undefined}>
        <div style={{ position: 'absolute', left: 0, top: STRIP_Y, width: W, height: STRIP_H, background: '#0b0a09', boxShadow: '0 0 120px rgba(255,226,190,0.08)' }}>
          {[14, STRIP_H - 30].map((y) => (
            <div key={y} style={{ position: 'absolute', left: -(offset % 52), top: y, width: W + 104, height: 16,
              background: 'repeating-linear-gradient(90deg, #2c2925 0 26px, transparent 26px 52px)', borderRadius: 3 }} />
          ))}
          {Array.from({ length: Math.ceil(W / (CELL_W + GAP)) + 2 }, (_, k) => {
            const i = first + k;
            const x = i * (CELL_W + GAP) - offset + 40;
            return (
              <Img key={i} src={STILLS[i % STILLS.length]!} style={{ position: 'absolute', left: x, top: 46, width: CELL_W, height: CELL_H, objectFit: 'cover', opacity: 0.92 }} />
            );
          })}
        </div>
      </Layer>
      <div style={{ position: 'absolute', right: 120, top: STRIP_Y - 54, fontFamily: MONO, fontSize: 24, color: '#9a948a', letterSpacing: '0.06em' }}>
        {`frame ${String(counter).padStart(4, '0')} / ${TOTAL}`}
      </div>
      {/* the clock */}
      <div style={{ position: 'absolute', left: 110, top: 560, fontFamily: TITLE, fontWeight: TITLE_WEIGHT, fontSize: 340, lineHeight: 1.1, letterSpacing: '-0.045em',
        color: '#f6efe4', textShadow: TITLE_GLOW, transform: `scale(${pop})`, transformOrigin: '0 60%' }}>
        {clock(p * RENDER_SECONDS)}
        <span style={{ fontSize: 120, letterSpacing: '0', marginLeft: 18, color: done ? RED : '#6f6a62' }}>s</span>
      </div>
      <div style={{ position: 'absolute', left: 1010, top: 700, fontFamily: SANS, fontWeight: 500, fontSize: 28, letterSpacing: '0.32em', textTransform: 'uppercase', lineHeight: 1.9, color: '#b9b2a6', opacity: capIn, transform: `translateY(${(1 - capIn) * 14}px)` }}>
        <div style={{ color: '#f6efe4' }}>to render this whole film</div>
        <div>{`${Math.round(TOTAL / FPS)} seconds · ${TOTAL.toLocaleString('en-US')} frames`}</div>
      </div>
    </AbsoluteFill>
  );
};
