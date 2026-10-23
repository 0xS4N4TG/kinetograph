// Shared tokens and pieces of the launch film (see STORYBOARD.md, storyboard.html).

import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadRockSalt } from '@remotion/google-fonts/RockSalt';

export const W = 1920;
export const H = 1080;
export const FPS = 30;

export const SANS = loadDMSans('normal', { weights: ['400', '500', '700'] }).fontFamily;
export const MONO = loadMono('normal', { weights: ['400', '500'] }).fontFamily;
export const HAND = loadRockSalt('normal', { weights: ['400'] }).fontFamily;

export const PAPER = '#ECEAE6';
export const INK = '#111111';
export const RED = '#E0261B';
export const MUSTARD = '#D9A621';
export const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const OUT = Easing.bezier(0.16, 1, 0.3, 1);

/** Our own renders (showcase, showcase-3d, rajz cards, papercut ep13), the picture pool of the collage and flicker. */
export const POOL = [
  '01-showcase-v1', '02-showcase-v1', '03-showcase-v1', '04-showcase-v1', '06-showcase-v1', '07-showcase-v1',
  '08-showcase-v1', '10-showcase-v1', '11-showcase-3d', '12-showcase-3d', '13-showcase-3d',
  '16-ep13-5s', '17-ep13-5s', '18-ep13-5s', '19-open-v4', '20-open-v4',
].map((n) => staticFile(`pool/${n}.jpg`));

/** Paper: a bright centre falling off to soft grey edges, the reference reel's ground. */
export const PaperGround: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 75% at 50% 46%, #F4F3F1 0%, ${PAPER} 45%, #CFCCC7 100%)` }} />
);

/** Ink: a lifted centre falling off to black. */
export const InkGround: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 75% at 50% 46%, #262626 0%, ${INK} 55%, #050505 100%)` }} />
);

/** A line that builds word by word: each word blurs in over 4 frames, `per` frames apart. */
export const Build: React.FC<{ words: string[]; start: number; per: number; color: string; size: number; style?: React.CSSProperties }> = ({
  words, start, per, color, size, style,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: size, color, letterSpacing: '-0.01em', display: 'flex', gap: size * 0.26, ...style }}>
      {words.map((w, i) => {
        const t = interpolate(frame, [start + i * per, start + i * per + 4], [0, 1], CLAMP);
        return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>;
      })}
    </div>
  );
};

/** Frames of each shot at 30 fps, in order (about 50 s). The cut is the sum; shot 6, the burn, lies over the cut
 *  from shot 5 into shot 7 rather than taking time of its own. Keep a shot inside its length. */
export const LEN = {
  s01: 24, s02: 80, s03: 84, s04: 56, s05: 80, s06: 27,
  s07: 174, m1: 92, m2: 64, m3: 60, m4: 48, m5: 80, s08: 210, s09: 160, s10: 75, s11: 120, s12: 135,
} as const;
