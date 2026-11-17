// Shared look for the docs animations: the site's paper, ink and cobalt, DM Sans and JetBrains Mono,
// flat shapes with thin strokes. Colours match the SVGs in packages/site/public/docs-media/illustrations.

import React from 'react';
import { Ellipse, Layer, Path, Rect, Text } from '@kinetographdev/core';
import { loadFont as loadSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

const sans = loadSans('normal', { weights: ['400', '700'] });
const mono = loadMono('normal', { weights: ['400', '700'] });

export const C = {
  paper: '#f7f4ec',
  ink: '#1d1b18',
  mute: '#5e5952',
  cobalt: '#2238c4',
  flag: '#c8271c',
  card: '#fbf8f0',
  tint: '#e4e8f8',
  line: '#b9b3a6',
  night: '#14171f',
  amber: '#f6c177',
};

export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 720;
export const DURATION = 180;

/** 0..1, smooth. */
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

interface TProps {
  x: number;
  y: number;
  size?: number;
  weight?: 400 | 700;
  color?: string;
  /** Box width for centred or right-aligned text. */
  w?: number;
  align?: 'left' | 'center' | 'right';
  mono?: boolean;
  opacity?: number;
  children: string;
}

/** Text with its top-left corner at (x, y), or centred in a box of width `w`. */
export const T = ({ x, y, size = 24, weight = 400, color = C.ink, w, align = 'left', mono: isMono = false, opacity = 1, children }: TProps) => (
  <Text
    x={x}
    y={y}
    font={isMono ? mono.fontFamily : sans.fontFamily}
    weight={weight}
    size={size}
    color={color}
    lineHeight={1.2}
    maxWidth={w}
    align={align}
    opacity={opacity}
  >
    {children}
  </Text>
);

interface BoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 is a plain card, 1 the cobalt accent. */
  accent?: number;
  radius?: number;
  dashed?: boolean;
  stroke?: string;
}

export const Box = ({ x, y, w, h, accent = 0, radius = 14, dashed = false, stroke }: BoxProps) => (
  <Rect
    x={x}
    y={y}
    width={w}
    height={h}
    radius={radius}
    fill={accent > 0 ? mix(C.card, C.tint, accent) : C.card}
    stroke={{ color: stroke ?? mix(C.ink, C.cobalt, accent), width: 2 + accent * 1.5, ...(dashed ? { dashArray: [10, 8] } : {}) }}
  />
);

/** A solid colour between two #rrggbb colours. */
export function mix(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const k = clamp01(t);
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(r1 + (r2 - r1) * k)}${h(g1 + (g2 - g1) * k)}${h(b1 + (b2 - b1) * k)}`;
}

/** An arrow from (x1, y1) to (x2, y2), with a head. */
export const Arrow = ({ x1, y1, x2, y2, color = C.ink, width = 2.5 }: { x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = 16;
  const s = 9;
  const bx = x2 - L * Math.cos(a);
  const by = y2 - L * Math.sin(a);
  const head = `M${x2} ${y2} L${bx - s * Math.sin(a)} ${by + s * Math.cos(a)} L${bx + s * Math.sin(a)} ${by - s * Math.cos(a)} Z`;
  return (
    <>
      <Path d={`M${x1} ${y1} L${bx} ${by}`} stroke={{ color, width, cap: 'round' }} />
      <Path d={head} fill={color} />
    </>
  );
};

/** The title card the docs use as a stand-in frame, in a 320 by 200 box. `bar` is 0..1. */
export const Picture = ({ x, y, scale = 1, bar = 0.45 }: { x: number; y: number; scale?: number; bar?: number }) => (
  <Layer x={x} y={y} scale={scale}>
    <Rect width={320} height={200} radius={10} fill={C.night} stroke={{ color: C.ink, width: 2 / scale }} />
    <Rect x={44} y={58} width={190} height={40} radius={5} fill="#ffffff" />
    <Rect x={44} y={120} width={Math.max(1, 190 * bar)} height={18} radius={5} fill={C.amber} />
  </Layer>
);

/** A numbered cobalt dot. */
export const Badge = ({ x, y, n, r = 17 }: { x: number; y: number; n: number; r?: number }) => (
  <>
    <Ellipse x={x - r} y={y - r} width={r * 2} height={r * 2} fill={C.cobalt} />
    <T x={x - r} y={y - r + (r * 2 - 18 * 1.2) / 2} w={r * 2} align="center" size={18} weight={700} color={C.paper}>
      {String(n)}
    </T>
  </>
);

/** A "no" sign: ring and slash. */
export const NoSign = ({ x, y, r = 22, color = C.flag }: { x: number; y: number; r?: number; color?: string }) => {
  const d = r * 0.7;
  return (
    <>
      <Ellipse x={x - r} y={y - r} width={r * 2} height={r * 2} stroke={{ color, width: 3.5 }} />
      <Path d={`M${x - d} ${y + d} L${x + d} ${y - d}`} stroke={{ color, width: 3.5, cap: 'round' }} />
    </>
  );
};
