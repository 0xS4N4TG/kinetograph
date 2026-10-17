// Shot 9: the numbers. Two bars race on one time scale, the same project (S04, 89 frames, M4, measured 2026-10-15):
// Remotion 8.86 s, Kinetograph 1.25 s. The multiple counts up to 7.0x and a handwritten "IMPACT" lands. The chart is
// styled after bklit's bar chart (rounded bars, a clean grid, a spring on the bars) but is driven by the frame.

import React from 'react';
import { AbsoluteFill, Freeze, Sequence, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import { Video } from '@kinetograph/core';
import { CLAMP, FPS, InkGround, MONO, OUT, PAPER, RED, SANS } from './common.js';

export const REMOTION_S = 8.86;
export const KINETOGRAPH_S = 1.25;
const X0 = 380; // where 0 s sits
const SCALE = 150; // px per second: 10 s is 1500 px
const AXIS = [0, 2, 4, 6, 8, 10];
const ROWS = [
  { name: 'remotion', secs: REMOTION_S, y: 300, fill: 'linear-gradient(90deg,#2b2b2b,#6b6b6b)', tip: '#9a9a9a' },
  { name: 'kinetograph', secs: KINETOGRAPH_S, y: 470, fill: `linear-gradient(90deg,#8f1a11,${RED})`, tip: '#ff6a5c' },
];
const BAR_H = 92;
export const RACE = [12, 84] as const; // frames over which the clock runs from 0 to 8.86 s
export const MULT_AT = 76;
export const IMPACT_AT = 118;
const IMPACT_HOLD = 17;

export const S09: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, RACE, [0, REMOTION_S], CLAMP); // seconds of render time elapsed, both bars racing
  const kDoneAt = RACE[0] + (KINETOGRAPH_S / REMOTION_S) * (RACE[1] - RACE[0]);

  const mult = interpolate(frame, [MULT_AT, MULT_AT + 26], [1, 7.0], { ...CLAMP, easing: OUT });
  const multIn = interpolate(frame, [MULT_AT - 2, MULT_AT + 6], [0, 1], { ...CLAMP, easing: OUT });
  const settle = spring({ frame: frame - (MULT_AT + 26), fps: FPS, config: { damping: 9, stiffness: 160 }, durationInFrames: 22 });
  const pop = 1 + 0.05 * settle * (frame >= MULT_AT + 26 ? 1 : 0) * Math.exp(-(frame - MULT_AT - 26) / 6);

  return (
    <AbsoluteFill>
      <InkGround />
      <div style={{ position: 'absolute', left: 140, top: 112, fontFamily: MONO, fontSize: 24, color: '#8a8a8a', opacity: interpolate(frame, [0, 8], [0, 1], CLAMP) }}>
        same project · same 89 frames · render time
      </div>

      {/* the grid, drawn in from the left, one line every 2 s */}
      {AXIS.map((s, i) => {
        const g = interpolate(frame, [2 + i * 2, 12 + i * 2], [0, 1], { ...CLAMP, easing: OUT });
        return (
          <div key={s} style={{ position: 'absolute', left: X0 + s * SCALE, top: 230, width: 2, height: 360 * g, background: 'repeating-linear-gradient(180deg,#3a3a3a 0 8px,transparent 8px 16px)' }}>
            <div style={{ position: 'absolute', top: 372, left: -22, width: 44, textAlign: 'center', fontFamily: MONO, fontSize: 22, color: '#666', opacity: g }}>{s}s</div>
          </div>
        );
      })}

      {ROWS.map((r, i) => {
        const isK = r.name === 'kinetograph';
        const rowIn = interpolate(frame, [6 + i * 3, 18 + i * 3], [0, 1], { ...CLAMP, easing: OUT });
        const elapsed = Math.min(t, r.secs);
        let w = elapsed * SCALE;
        // A spring on the finish: the bar overshoots its mark a touch and settles.
        const since = frame - (isK ? kDoneAt : RACE[1]);
        if (since >= 0) w += SCALE * 0.07 * Math.exp(-since / 3.2) * Math.sin(since * 0.85);
        const done = t >= r.secs;
        const label = elapsed.toFixed(2);
        const glow = isK ? interpolate(since, [0, 4, 24], [0, 1, 0], CLAMP) : 0;
        return (
          <div key={r.name} style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, opacity: rowIn, transform: `translateX(${(1 - rowIn) * -30}px)` }}>
            <div style={{ position: 'absolute', left: 140, top: r.y + 26, width: 220, fontFamily: SANS, fontWeight: 500, fontSize: 30, color: isK ? PAPER : '#b0b0b0' }}>{r.name}</div>
            <div style={{
              position: 'absolute', left: X0, top: r.y, width: Math.max(4, w), height: BAR_H, borderRadius: 16, background: r.fill,
              boxShadow: glow > 0 ? `0 0 ${40 * glow}px rgba(224,38,27,${0.55 * glow})` : 'none',
            }}>
              {!done && <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 5, borderRadius: 3, background: r.tip, opacity: 0.55 + 0.45 * Math.abs(Math.sin(frame * 0.5)) }} />}
            </div>
            <div style={{ position: 'absolute', left: X0 + Math.max(4, w) + 22, top: r.y + 22, fontFamily: MONO, fontSize: 38, color: isK && done ? '#ff6a5c' : PAPER, fontWeight: 500 }}>
              {label}s
            </div>
          </div>
        );
      })}

      {/* a guide at 1.25 s through both bars once the fast one is done */}
      {(() => {
        const g = interpolate(frame, [kDoneAt + 2, kDoneAt + 12], [0, 1], { ...CLAMP, easing: OUT });
        return <div style={{ position: 'absolute', left: X0 + KINETOGRAPH_S * SCALE, top: 270, width: 3, height: 300 * g, background: 'repeating-linear-gradient(180deg,rgba(224,38,27,0.8) 0 10px,transparent 10px 18px)' }} />;
      })()}

      <div style={{
        position: 'absolute', left: 130, top: 640, fontFamily: SANS, fontWeight: 700, fontSize: 340, lineHeight: 1, color: PAPER, letterSpacing: '-0.04em', paddingRight: 40,
        opacity: multIn, filter: `blur(${(1 - multIn) * 12}px)`, transform: `scale(${pop})`, transformOrigin: '0 60%',
      }}>
        {mult.toFixed(1)}x
      </div>
      <div style={{ position: 'absolute', left: 150, top: 960, fontFamily: SANS, fontWeight: 500, fontSize: 44, color: '#c4c4c4', opacity: interpolate(frame, [MULT_AT + 20, MULT_AT + 30], [0, 1], { ...CLAMP, easing: OUT }), transform: `translateY(${interpolate(frame, [MULT_AT + 20, MULT_AT + 30], [14, 0], { ...CLAMP, easing: OUT })}px)` }}>
        faster, same frames
      </div>

      <AbsoluteFill style={{ mixBlendMode: 'screen' }}>
      {/* the word is drawn on over IMPACT_HOLD frames, then the last picture of it stays (the clip goes on to scribble itself out) */}
      <Sequence from={IMPACT_AT} durationInFrames={IMPACT_HOLD}>
        <Video src={staticFile('fx/hand-impact.mp4')} x={866} y={450} width={1070} height={602} fit="contain" muted />
      </Sequence>
      <Sequence from={IMPACT_AT + IMPACT_HOLD}>
        <Freeze frame={IMPACT_HOLD}>
          <Video src={staticFile('fx/hand-impact.mp4')} x={866} y={450} width={1070} height={602} fit="contain" muted />
        </Freeze>
      </Sequence>
      </AbsoluteFill>

      <div style={{ position: 'absolute', right: 120, bottom: 56, fontFamily: MONO, fontSize: 22, color: '#666' }}>S04 · M4 · measured 2026-10-15</div>
    </AbsoluteFill>
  );
};
