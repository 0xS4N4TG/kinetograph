// Act 3, shots 10 to 12: no chrome, the logo-flicker, the end card.

import React from 'react';
import { AbsoluteFill, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { LogoFlicker } from '@/components/snap-cn/logo-flicker';
import { CLAMP, FPS, H, INK, InkGround, MONO, MUSTARD, OUT, PAPER, POOL, PaperGround, RED, SANS, W, Build } from './common.js';

// ---- shot 10: no chrome, no screenshots, just pixels ----
export const S10: React.FC = () => {
  const frame = useCurrentFrame();
  const s1 = interpolate(frame, [14, 22], [1, 0], CLAMP);
  const s2 = interpolate(frame, [30, 38], [1, 0], CLAMP);
  const c = interpolate(frame, [46, 60], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill>
      <PaperGround />
      <Build words={['no', 'chrome.', 'no', 'screenshots.', 'just', 'pixels.']} start={4} per={7} color={INK} size={72} style={{ position: 'absolute', left: 0, right: 0, top: 480, justifyContent: 'center' }} />
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path d="M296 528 c70 -28 140 28 210 -4 s140 22 214 -8 M306 548 c110 8 230 -16 410 0" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={s1} />
        <path d="M712 530 c120 -26 260 30 380 -6 s100 20 150 -4" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={s2} />
        <ellipse cx={1428} cy={522} rx={215} ry={88} transform="rotate(-4 1440 520)" fill="none" stroke={RED} strokeWidth={6} pathLength={1} strokeDasharray="1 1" strokeDashoffset={c} />
      </svg>
    </AbsoluteFill>
  );
};

// ---- shot 11: snapcn's logo-flicker over our own renders ----
export const S11: React.FC = () => (
  <LogoFlicker images={POOL} brandName="kinetograph" logoSrc={staticFile('fx/clear.png')} mode="dark" fontFamily={SANS} background={INK} />
);

// ---- shot 12: end card ----
export const S12: React.FC = () => (
  <AbsoluteFill>
    <PaperGround />
    <div style={{ position: 'absolute', left: 0, right: 0, top: 330, textAlign: 'center', fontFamily: SANS, color: INK }}>
      <div style={{ fontWeight: 700, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1 }}>kinetograph<span style={{ color: RED }}>.</span></div>
      <div style={{ fontSize: 50, marginTop: 34 }}>write remotion. render native.</div>
      <div style={{ fontFamily: MONO, fontSize: 36, marginTop: 110 }}>kinetograph.dev</div>
      <div style={{ fontFamily: MONO, fontSize: 22, marginTop: 120, color: '#7a7670' }}>this video was rendered by kinetograph in N s</div>
    </div>
  </AbsoluteFill>
);

