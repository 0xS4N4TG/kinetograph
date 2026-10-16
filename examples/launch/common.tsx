// Shared tokens and pieces of the launch film (see STORYBOARD.md, storyboard.html).

import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

export const W = 1920;
export const H = 1080;
export const FPS = 30;

export const SANS = loadDMSans('normal', { weights: ['400', '500', '700'] }).fontFamily;
export const MONO = loadMono('normal', { weights: ['400', '500'] }).fontFamily;

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

/** Paper texture and vignette over a paper scene. */
export const PaperGround: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: PAPER }} />
    <Img src={staticFile('fx/grunge-06.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'multiply', opacity: 0.22 }} />
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.22) 100%)' }} />
  </>
);

/** Gate dust over an ink scene. */
export const InkGround: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: INK }} />
    <Img src={staticFile('fx/grunge-02.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'screen', opacity: 0.5 }} />
  </>
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

/** Frames of each shot at 30 fps, in order (about 39 s). The cut is the sum; shot 6, the burn, lies over the cut
 *  from shot 5 into shot 7 rather than taking time of its own. Keep a shot inside its length. */
export const LEN = {
  s01: 21, s02: 69, s03: 90, s04: 60, s05: 90, s06: 27,
  s07: 153, s08: 150, s09: 180, s10: 90, s11: 120, s12: 120,
} as const;
