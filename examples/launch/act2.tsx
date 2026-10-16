// Act 2, shots 7 to 9: "Your demo / launch / changelog", the 98% drop-in, the numbers.

import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { CLAMP, FPS, H, INK, InkGround, MONO, MUSTARD, OUT, PAPER, POOL, PaperGround, RED, SANS, W, Build } from './common.js';

// ---- shot 7: "Your demo / launch / changelog" collage of our renders, collapsing to "that render for you" ----
/** Card boxes (x, y, w, h, pool index) around the centre line, in the order they arrive; several run off the frame. */
const CARDS: [number, number, number, number, number][] = [
  [1330, 0, 450, 445, 12],
  [-40, 120, 410, 390, 8],
  [0, 570, 545, 440, 1],
  [330, 48, 430, 252, 3],
  [1205, 712, 755, 420, 14],
  [1635, 272, 330, 348, 9],
  [330, 806, 600, 330, 6],
  [760, -60, 380, 240, 15],
];
const WORDS = ['demo', 'launch', 'changelog'];
export const S07: React.FC = () => {
  const frame = useCurrentFrame();
  const collapse = interpolate(frame, [96, 120], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const dark = interpolate(frame, [108, 116], [0, 1], CLAMP);
  const word = WORDS[Math.min(WORDS.length - 1, Math.floor(frame / 30))];
  const wordIn = interpolate(frame % 30, [0, 8], [0.35, 1], CLAMP);
  const typed = 'that render for you'.slice(0, Math.max(0, Math.floor((frame - 122) / 1.6)));
  return (
    <AbsoluteFill style={{ background: '#F3EFEC' }}>
      <AbsoluteFill style={{ background: INK, opacity: dark }} />
      {([[120, 70, '#c97a5f'], [560, 88, '#55603f'], [1700, 1010, '#55603f'], [880, 980, '#c97a5f'], [1520, 640, '#55603f']] as [number, number, string][]).map(([x, y, c], i) => (
        <div key={i} style={{ position: 'absolute', left: x, top: y, width: 9, height: 9, background: c, opacity: 1 - collapse }} />
      ))}
      {CARDS.map(([x, y, w, h, p], i) => {
        const at = 6 + i * 9;
        const t = interpolate(frame, [at, at + 10], [0, 1], { ...CLAMP, easing: OUT });
        const tint = interpolate(frame, [at, at + 12], [1, 0], CLAMP);
        if (t <= 0) return null;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const tx = (W / 2 - cx) * collapse * 0.55;
        const ty = (H / 2 - cy) * collapse * 0.55;
        const sepia = Math.max(tint, collapse * 0.8);
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden', borderRadius: i % 3 === 0 ? 18 : 4,
            transform: `translate(${tx}px, ${ty + (1 - t) * 30}px) scale(${(0.94 + t * 0.06) * (1 - collapse * 0.45)})`,
            opacity: t * (1 - interpolate(frame, [116, 126], [0, 1], CLAMP)),
            filter: `sepia(${sepia}) hue-rotate(${sepia * 50}deg) saturate(${1 - sepia * 0.4}) blur(${collapse * 6}px)`,
          }}>
            <Img src={POOL[p]} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
        );
      })}
      {frame < 112 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, fontFamily: SANS, fontSize: 64, color: INK, opacity: 1 - dark }}>
          <div style={{ display: 'flex', gap: 6 }}><div style={{ width: 14, height: 14, background: '#55603f' }} /><div style={{ width: 14, height: 14, background: '#cfcac4' }} /></div>
          <span>Your <span style={{ opacity: wordIn }}>{word}</span></span>
          <div style={{ display: 'flex', gap: 6 }}><div style={{ width: 14, height: 14, background: '#cfcac4' }} /><div style={{ width: 14, height: 14, background: '#55603f' }} /></div>
        </div>
      )}
      {frame >= 122 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: SANS, fontSize: 64, color: PAPER }}>
          <span>{typed}</span>
          <div style={{ width: 30, height: 56, background: PAPER, marginLeft: 6, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.15 }} />
        </div>
      )}
    </AbsoluteFill>
  );
};

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

