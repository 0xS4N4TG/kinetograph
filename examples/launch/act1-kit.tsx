// Shared pieces of act 1: eases, the video grounds and the word-by-word line.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { CLAMP, OUT, SANS } from './common.js';

/** Native elements (Rect, Layer, Scene3D, Video) next to DOM ones land in the wrapper's flow, offset from the corner; each goes in
 *  an AbsoluteFill, which overlays its siblings. `blend` turns the AbsoluteFill into a CSS-blended div (the blend is the div's). */
export const Over: React.FC<{ blend?: string; opacity?: number; children: React.ReactNode }> = ({ blend, opacity, children }) => (
  <AbsoluteFill style={blend || opacity !== undefined ? { mixBlendMode: blend as any, opacity } : undefined}>{children}</AbsoluteFill>
);

/** The ease of an object that arrives with a little overshoot (windows, never type). */
export const BACK = Easing.out(Easing.back(1.6));
/** The ease of an exit: slow start, fast finish. */
export const IN = Easing.bezier(0.5, 0, 0.9, 0.4);
export const IO = Easing.bezier(0.65, 0, 0.35, 1);

// ---- grounds: clean, with the reference reel's soft vignette (no film texture) ----

export { PaperGround, InkGround } from './common.js';

/** A line that builds word by word: each word rises 14 px and sharpens in over 6 frames (ease out, no overshoot). */
export const Words: React.FC<{ words: string[]; at: number[]; color: string; size: number; weight?: number; style?: React.CSSProperties }> = ({
  words, at, color, size, weight = 500, style,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ fontFamily: SANS, fontWeight: weight, fontSize: size, color, letterSpacing: '-0.01em', display: 'flex', gap: size * 0.26, ...style }}>
      {words.map((w, i) => {
        const t = interpolate(frame, [at[i]!, at[i]! + 6], [0, 1], { ...CLAMP, easing: OUT });
        return <span key={i} style={{ opacity: Math.min(1, t * 1.6), filter: `blur(${(1 - t) * 8}px)`, transform: `translateY(${(1 - t) * 14}px)` }}>{w}</span>;
      })}
    </div>
  );
};


/** The big "how" of shots 1 and 2. The last glyph is set apart: with the tight tracking the text box ends short of it and the "w" came out cut. */
export const How: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 560, color, lineHeight: 1, marginTop: -60, display: 'flex' }}>
    <span style={{ letterSpacing: '-0.05em' }}>ho</span>
    <span>w</span>
  </div>
);
