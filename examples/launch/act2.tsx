// Act 2, shots 7 to 9: "Your demo / launch / changelog", the 98% drop-in, the numbers.

import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { CLAMP, FPS, H, INK, InkGround, MONO, MUSTARD, OUT, PAPER, POOL, PaperGround, RED, SANS, W, Build } from './common.js';

export { S07 } from './act2-s07.js';
export { S08 } from './act2-s08.js';

// ---- shot 9: the numbers, bars on one scale ----
export const S09: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [6, 66], [0, 8.86], CLAMP); // seconds of render time elapsed, both racing
  const scale = 1280 / 9;
  const bar = (secs: number) => Math.min(t, secs) * scale;
  const done = t >= 1.25;
  const x = Math.min(7.0, 1 + (6 * (t - 1.25)) / (8.86 - 1.25));
  return (
    <AbsoluteFill>
      <InkGround />
      <div style={{ position: 'absolute', left: 220, top: 170, fontFamily: MONO, fontSize: 22, color: '#8a8a8a' }}>same project · same 89 frames · render time</div>
      {[0, 3, 6, 9].map((s) => (
        <div key={s} style={{ position: 'absolute', left: 220 + s * scale, top: 220, height: 330, borderLeft: '1px dashed #3a3a3a' }}>
          <div style={{ position: 'absolute', top: 340, left: -12, fontFamily: MONO, fontSize: 20, color: '#666' }}>{s}s</div>
        </div>
      ))}
      {[{ name: 'remotion', secs: 8.86, c: 'linear-gradient(90deg,#3a3a3a,#5e5e5e)', y: 290 }, { name: 'kinetograph', secs: 1.25, c: `linear-gradient(90deg,#9e1b12,${RED})`, y: 450 }].map((b) => (
        <div key={b.name}>
          <div style={{ position: 'absolute', left: 220, top: b.y - 44, fontFamily: SANS, fontSize: 28, color: '#cfcfcf' }}>{b.name}</div>
          <div style={{ position: 'absolute', left: 220, top: b.y, width: Math.max(2, bar(b.secs)), height: 70, borderRadius: 10, background: b.c }} />
          <div style={{ position: 'absolute', left: 240 + bar(b.secs), top: b.y + 16, fontFamily: MONO, fontSize: 30, color: PAPER }}>
            {Math.min(t, b.secs).toFixed(2)}s
          </div>
        </div>
      ))}
      {done && (
        <div style={{ position: 'absolute', left: 210, top: 650, fontFamily: SANS, fontWeight: 700, fontSize: 300, lineHeight: 1, color: PAPER, letterSpacing: '-0.04em' }}>
          {x.toFixed(1)}x
        </div>
      )}
      {frame > 60 && <Img src={staticFile('fx/hand-impact.png')} style={{ position: 'absolute', left: 900, top: 560, width: 960, height: 540, mixBlendMode: 'screen' }} />}
      <div style={{ position: 'absolute', right: 120, bottom: 60, fontFamily: MONO, fontSize: 20, color: '#666' }}>S04 · M4 · measured 2026-10-15</div>
    </AbsoluteFill>
  );
};

