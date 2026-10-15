// The pictures. No photos: each one is built from shapes, paths, gradients and
// mesh gradients, so the engine draws every pixel of the video.

import React from 'react';
import { random } from 'remotion';
import { Ellipse, Layer, MeshGradient, Path, Rect, linearGradient, radialGradient } from '@kinetograph/core';
import type { CommonProps } from '@kinetograph/core';

/** A rounded rectangle as path data, for `clip`. */
export function roundedPath(w: number, h: number, r: number): string {
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

// ---- a stylised portrait, 460 x 620 ----

export interface PortraitPalette {
  bg1: string;
  bg2: string;
  glow: string;
  cloth: string;
  collar: string;
  skin: string;
  skinShade: string;
  hair: string;
}

export const PORTRAITS: PortraitPalette[] = [
  { bg1: '#ffd9c2', bg2: '#f2a0c0', glow: '#fff1c9', cloth: '#1d1b2c', collar: '#f6e7d8', skin: '#f6c9a8', skinShade: '#e3a483', hair: '#241522' },
  { bg1: '#bfd7ff', bg2: '#a98bff', glow: '#e6f0ff', cloth: '#2b1f3d', collar: '#ffd6ec', skin: '#e9b896', skinShade: '#cf9473', hair: '#14101c' },
  { bg1: '#ffe2a8', bg2: '#ff8f70', glow: '#fff7de', cloth: '#26302f', collar: '#f1e0c8', skin: '#d99d78', skinShade: '#b97b5a', hair: '#2b1a12' },
];

export const PORTRAIT_W = 460;
export const PORTRAIT_H = 620;

export const Portrait: React.FC<{ palette?: PortraitPalette } & CommonProps> = ({
  palette: p = PORTRAITS[0]!,
  ...props
}) => (
  <Layer {...props}>
    <Rect width={PORTRAIT_W} height={PORTRAIT_H} fill={linearGradient([p.bg1, p.bg2], { angle: 160 })} />
    <Ellipse
      x={40}
      y={20}
      width={380}
      height={380}
      fill={radialGradient([p.glow, [1, `${p.glow}00`]], { r: 0.5 })}
    />
    {/* back hair, then shoulders, neck, face, fringe */}
    <Path d="M 128 200 C 128 96 332 96 332 200 L 352 408 L 108 408 Z" fill={p.hair} />
    <Path d="M 14 620 C 26 520 124 468 230 460 C 336 468 434 520 446 620 Z" fill={p.cloth} />
    <Path d="M 190 380 L 190 470 Q 230 496 270 470 L 270 380 Z" fill={p.skinShade} />
    <Path d="M 182 470 L 230 548 L 278 470" stroke={{ color: p.collar, width: 7 }} />
    <Ellipse x={148} y={192} width={164} height={216} fill={linearGradient([p.skin, p.skinShade], { angle: 105 })} />
    <Path d="M 142 276 C 128 168 184 136 232 136 C 292 136 330 178 318 276 C 298 214 256 188 214 184 C 180 190 156 222 142 276 Z" fill={p.hair} />
    <Path d="M 204 336 Q 230 350 256 336" stroke={{ color: p.skinShade, width: 5 }} />
    <Ellipse x={190} y={286} width={26} height={7} fill={p.hair} />
    <Ellipse x={244} y={286} width={26} height={7} fill={p.hair} />
  </Layer>
);

// ---- the profile in shot 1, facing right, long hair down the back; blurred to a glow, in canvas pixels ----

export const PROFILE_PATH =
  'M 540 1080 C 600 800 680 520 720 360 C 740 230 840 160 960 160 C 1080 160 1140 230 1148 320 L 1140 345 ' +
  'L 1175 385 L 1150 412 L 1160 432 L 1148 452 L 1152 495 C 1140 520 1100 540 1080 560 ' +
  'C 1040 610 1010 660 1000 700 C 1060 750 1240 860 1330 1080 Z';

/**
 * The profile, posed: the head turned `nod` degrees about the neck (it fades
 * out down the neck), the shoulders raised by `breathe` px and the ends of the
 * hair swung by `sway` px.
 */
export function profilePath(nod: number, breathe: number, sway: number): string {
  const r = (nod * Math.PI) / 180;
  const [px, py] = [1010, 640];
  return PROFILE_PATH.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_m, xs: string, ys: string) => {
    let x = Number(xs);
    let y = Number(ys);
    const head = Math.min(1, Math.max(0, (640 - y) / 280));
    if (head > 0) {
      const a = r * head;
      const dx = x - px;
      const dy = y - py;
      [x, y] = [px + dx * Math.cos(a) - dy * Math.sin(a), py + dx * Math.sin(a) + dy * Math.cos(a)];
    }
    if (x > 990 && y > 650) y -= breathe * Math.min(1, (y - 650) / 200);
    if (y > 700 && x < 760) x += sway * Math.min(1, (y - 700) / 380);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
}

// ---- cards for shot 7: 220 x 300, centred on (0, 0) ----

export const CARD_W = 220;
export const CARD_H = 300;

const CARD_COLORS: [string, string, string][] = [
  ['#ffd6a5', '#ff8fab', '#ffffff'],
  ['#a0c4ff', '#bdb2ff', '#fff3d6'],
  ['#b8f2e6', '#5e60ce', '#ffe0f0'],
  ['#ffc6ff', '#ffd6a5', '#ffffff'],
  ['#ff9e7a', '#c77dff', '#fff6d0'],
  ['#9bf6ff', '#a0c4ff', '#ffe5ec'],
];

/** The picture on a card, in a 220 x 300 box: a portrait or a sun over hills, picked by `seed`. */
export const CardArt: React.FC<{ seed: number }> = ({ seed }) => {
  const [c1, c2, c3] = CARD_COLORS[Math.floor(random(`pal-${seed}`) * CARD_COLORS.length)]!;
  if (random(`kind-${seed}`) > 0.55) {
    const palette = PORTRAITS[Math.floor(random(`pp-${seed}`) * PORTRAITS.length)]!;
    return <Portrait palette={palette} scale={CARD_W / PORTRAIT_W} />;
  }
  const sunX = 50 + random(`sx-${seed}`) * 120;
  const sunY = 70 + random(`sy-${seed}`) * 60;
  return (
    <Layer>
      <Rect width={CARD_W} height={CARD_H} fill={linearGradient([c1, c2], { angle: 170 })} />
      <Ellipse x={sunX - 48} y={sunY - 48} width={96} height={96} fill={c3} opacity={0.9} />
      <Path d={`M 0 ${200 + random(`h1-${seed}`) * 30} C 60 150 130 230 220 170 L 220 300 L 0 300 Z`} fill={c2} opacity={0.85} />
      <Path d={`M 0 ${240 + random(`h2-${seed}`) * 20} C 80 200 150 270 220 230 L 220 300 L 0 300 Z`} fill="#1d1b2c" opacity={0.78} />
    </Layer>
  );
};

// ---- a landscape for the false-colour shot, 1920 x 1080 ----

export const Landscape: React.FC<{ shift?: number }> = ({ shift = 0 }) => (
  <Layer>
    <MeshGradient
      width={1920}
      height={1080}
      columns={3}
      rows={3}
      colors={[
        '#9ad8e8', '#ffe3c2', '#ffc2d4',
        '#7fc4e0', '#ffd0a8', '#f6a2c0',
        '#6fb0d8', '#f4b890', '#c79bdc',
      ]}
    />
    <Ellipse
      x={1130 + shift}
      y={250}
      width={420}
      height={420}
      fill={radialGradient(['#fffbe6', '#ffd9a0', [1, '#ffd9a000']], { r: 0.5 })}
    />
    <Path d="M 0 700 C 260 560 420 640 640 600 C 860 560 1040 700 1300 640 C 1560 580 1740 640 1920 600 L 1920 1080 L 0 1080 Z" fill="#7aa7c9" opacity={0.85} />
    <Path d="M 0 800 C 300 700 560 780 820 740 C 1100 700 1400 800 1920 720 L 1920 1080 L 0 1080 Z" fill="#5b7fb4" />
    <Path d="M 0 900 C 400 840 700 920 1100 880 C 1500 840 1700 920 1920 880 L 1920 1080 L 0 1080 Z" fill="#3a4f86" />
    <Rect x={1700} y={490} width={14} height={150} fill="#2b3a6b" />
    <Ellipse x={1616} y={420} width={190} height={120} fill="#2b3a6b" />
  </Layer>
);
