// Shared pieces of the showcase: the clock (every shot's start, in seconds,
// then frames), fonts, small helpers and the bracket-and-dots motif.

import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadSerif } from '@remotion/google-fonts/InstrumentSerif';
import { makeGoogleFont } from '@kinetographdev/core/google-fonts';
import { Layer, Rect, Text } from '@kinetographdev/core';

export const W = 1920;
export const H = 1080;
export const FPS = 25;
export const BACKDROP = '#e8e8e8';
export const INK = '#111111';
export const GREY = '#9a9a9a';

export const SANS = loadInter('normal', { weights: ['400', '500', '600'] }).fontFamily;
export const SERIF = loadSerif('normal', { weights: ['400'] }).fontFamily;
// `@remotion/google-fonts/JetBrainsMono` would be bundled as "Jet Brains Mono" (the CLI's own name splitter has no
// exception for it), so the family is asked for by its real name.
export const MONO = makeGoogleFont('JetBrains Mono').loadFont('normal', { weights: ['400', '500'] }).fontFamily;

// ---- the numbers on the speed slide ----
// Never write a number here that was not measured. Source: the go/no-go benchmark
// (Remotion 9.2-9.5 s, TSX port 2.86-2.92 s, 3.2x). The pair
// below is the faster end of both ranges, which is also where the 3.2x headline
// comes from.
export const REMOTION_SECONDS = 9.2; // MEASURED: update from perf/gpu-passes
export const KINETOGRAPH_SECONDS = 2.86; // MEASURED: update from perf/gpu-passes
export const SPEEDUP = 3.2; // MEASURED: update from perf/gpu-passes
export const BENCH_LABEL = 'papercut scene, 89 frames, 1080×1920, M4'; // MEASURED: update from perf/gpu-passes
/** Length of the voiceover line for the speed slide (09-speed.wav is not recorded yet). */
export const SPEED_LINE_SECONDS = 3.0;

// ---- the clock: seconds, timed to the voiceover ----
export const VO = {
  imagine: 4.217,
  thisIs: 1.577,
  react: 1.897,
  engine: 5.737,
  type: 3.497,
  looks: 2.777,
  camera: 3.177,
  noChrome: 3.497,
  speed: SPEED_LINE_SECONDS,
  outro: 3.657,
};

/** Where each shot starts, in seconds. A voiceover line starts 0.15 s into its shot, except line 01, which spans two. */
export const T = {
  s1: 0,
  s2: 2.4, // under the melt of shot 1: `{ rendered without a browser }`, then `{ Kinetograph }` on line 02 (4.55)
  s3: 6.4,
  s4: 8.7,
  s5: 14.7,
  s6: 18.5,
  s7: 21.5,
  whip: 24.85, // the cards leave
  s8: 25.0, // the glow rises under the whip; line 08 at 25.55
  s9: 29.2,
  s10: 29.2 + SPEED_LINE_SECONDS + 0.45,
  end: 29.2 + SPEED_LINE_SECONDS + 0.45 + 4.45,
  vo: {
    imagine: 0.15,
    thisIs: 4.55,
    react: 6.55,
    engine: 8.85,
    type: 14.85,
    looks: 18.65,
    camera: 21.65,
    noChrome: 25.55,
    speed: 29.35,
    outro: 29.2 + SPEED_LINE_SECONDS + 0.6,
  },
};

export const fr = (seconds: number): number => Math.round(seconds * FPS);
export const DURATION = fr(T.end);

// ---- helpers ----

export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

/** 0 to 1 over frames `a` to `b`, eased, held outside. */
export function ramp(frame: number, a: number, b: number, easing: (t: number) => number = Easing.out(Easing.cubic)): number {
  return interpolate(frame, [a, b], [0, 1], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/** A spring from 0 to 1 that starts at frame `delay` of the current sequence. */
export function useSpring(delay = 0, config: { damping?: number; mass?: number; stiffness?: number } = {}): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 18, ...config } });
}

/** A blinking caret: on for `period / 2` frames, off for as long. */
export const blink = (frame: number, period = 16): number => (Math.floor(frame / (period / 2)) % 2 === 0 ? 1 : 0);

/** A row of children centred on the canvas at height `y` (the flex layout does the centring). */
export const Center: React.FC<{
  y: number;
  h?: number;
  gap?: number;
  children?: React.ReactNode;
  x?: number;
  opacity?: number;
  id?: string;
}> = ({ y, h = 200, gap = 0, children, x = 0, ...rest }) => (
  <Layer
    {...rest}
    x={x}
    y={y - h / 2}
    layout={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: W, height: h, gap }}
  >
    {children}
  </Layer>
);

/** A small square, the motif of the reference's `{ }` titles. */
export const Dot: React.FC<{ x: number; y: number; size?: number; color?: string; opacity?: number }> = ({
  x,
  y,
  size = 8,
  color = INK,
  opacity = 1,
}) => <Rect x={x - size / 2} y={y - size / 2} width={size} height={size} fill={color} opacity={opacity} />;

/** Four dots at the corners of a `w` x `h` box centred on (`cx`, `cy`). `t` grows them from the centre. */
export const CornerDots: React.FC<{
  cx: number;
  cy: number;
  w: number;
  h: number;
  t?: number;
  size?: number;
  color?: string;
}> = ({ cx, cy, w, h, t = 1, size = 8, color = INK }) => (
  <>
    <Dot x={cx - (w / 2) * t} y={cy - (h / 2) * t} size={size} color={color} opacity={t} />
    <Dot x={cx + (w / 2) * t} y={cy - (h / 2) * t} size={size} color={color} opacity={t} />
    <Dot x={cx - (w / 2) * t} y={cy + (h / 2) * t} size={size} color={color} opacity={t} />
    <Dot x={cx + (w / 2) * t} y={cy + (h / 2) * t} size={size} color={color} opacity={t} />
  </>
);

/** Text whose letters rise into place one after another, from frame `start`. */
export const RiseText: React.FC<{
  text: string;
  start: number;
  size: number;
  weight?: number;
  color?: React.ComponentProps<typeof Text>['color'];
  font?: string;
  stagger?: number;
  rise?: number;
  /** 0 to 1: letters leave (up and fade) instead of arriving. */
  out?: number;
  id?: string;
  y?: number;
  x?: number;
  opacity?: number;
}> = ({ text, start, size, weight = 500, color = INK, font = SANS, stagger = 1.6, rise = 0.5, out = 0, ...rest }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const count = Array.from(text).length;
  return (
    <Text
      {...rest}
      font={font}
      weight={weight}
      size={size}
      color={color}
      chars={(_c, i) => {
        const s = spring({ frame: frame - start - i * stagger, fps, config: { damping: 17, mass: 0.7 } });
        const leave = ramp(out * (count * 0.35 + 1) - i * 0.35, 0, 1, Easing.in(Easing.quad));
        return { y: (1 - s) * size * rise - leave * size * 0.5, opacity: clamp(s * 1.4) * (1 - leave) };
      }}
    >
      {text}
    </Text>
  );
};
