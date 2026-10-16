// Act 1, shots 1 to 6: the question, the problem, the melt, the camera, the burn.

import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Camera3D, DirectionalLight, Image, Layer, Model, Rect, Scene3D, glow, gradientMap, grain } from '@kinetograph/core';
import { CLAMP, FPS, H, INK, InkGround, MONO, MUSTARD, OUT, PAPER, POOL, PaperGround, RED, SANS, W, Build } from './common.js';

// ---- shot 1: "how" ----
export const S01: React.FC = () => (
  <AbsoluteFill style={{ background: MUSTARD, alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 96, borderTop: `6px dashed ${INK}` }} />
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 96, borderTop: `6px dashed ${INK}` }} />
    <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 560, color: '#2a210f', letterSpacing: '-0.05em', lineHeight: 1, marginTop: -60 }}>how</div>
  </AbsoluteFill>
);

// ---- shot 2: the question, with an ink stroke writing itself ----
export const S02: React.FC = () => {
  const frame = useCurrentFrame();
  const words = 'how do you make a video without a browser?'.split(' ');
  const draw = interpolate(frame, [40, 62], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill>
      <PaperGround />
      <Build words={words} start={4} per={4} color={INK} size={58} style={{ position: 'absolute', left: 300, top: 600 }} />
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path
          d="M1268 690 C1320 712 1372 662 1420 694 S1520 732 1580 676 C1606 652 1618 700 1652 692"
          fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw}
        />
        <path d="M1470 740 c18 -36 36 36 54 0 s28 -28 46 8" fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" opacity={0.5} pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw} />
      </svg>
    </AbsoluteFill>
  );
};

/** A browser window drawn in CSS, holding one of our frames: what other tools screenshot. */
const BrowserWindow: React.FC<{ src: string; w: number; style?: React.CSSProperties }> = ({ src, w, style }) => {
  const h = w * 0.62;
  return (
    <div style={{ position: 'absolute', width: w, height: h, borderRadius: 14, overflow: 'hidden', background: '#202124', boxShadow: '0 30px 80px rgba(0,0,0,0.45)', ...style }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '0 16px', background: '#2b2c2f' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
        <div style={{ marginLeft: 18, flex: 1, height: 26, borderRadius: 13, background: '#3a3b3e', color: '#aaa', fontFamily: MONO, fontSize: 14, display: 'flex', alignItems: 'center', paddingLeft: 14 }}>
          localhost:3000/render?frame=0047
        </div>
      </div>
      <Img src={src} style={{ width: w, height: h - 44, objectFit: 'cover' }} />
    </div>
  );
};

// ---- shot 3: every frame, a screenshot ----
export const S03: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.floor(frame / 2);
  return (
    <AbsoluteFill>
      <InkGround />
      {[0, 1, 2].map((k) => (
        <BrowserWindow key={k} src={POOL[(n + k * 5) % POOL.length]} w={980} style={{ left: 420 + k * 54, top: 170 + k * 40, transform: `rotate(${(k - 1) * 3}deg)`, opacity: 0.55 + k * 0.22 }} />
      ))}
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, background: '#fff', opacity: frame % 6 === 0 ? 0.35 : 0 }} />
      <div style={{ position: 'absolute', left: -200, top: 330, width: 2400, height: 22, background: RED, transform: 'rotate(-9deg)', opacity: 0.9 }} />
      <div style={{ position: 'absolute', right: 120, top: 90, fontFamily: MONO, fontSize: 34, color: '#ddd' }}>
        screenshot {String(47 + n).padStart(4, '0')} / 1350
      </div>
      <Build words={['every', 'frame.', 'a', 'screenshot.']} start={0} per={0} color={PAPER} size={56} style={{ position: 'absolute', left: 140, top: 930 }} />
    </AbsoluteFill>
  );
};

// ---- shot 4: the browser drains away in the showcase's pixel melt, onto paper ----
// The melt (from examples/showcase, shot 1): the picture's top edge falls in columns of 40 px, in steps of 24 px,
// leading on the left, with a rim of bright cells; what is behind is left.
const COLS = 48;
const CELL_W = W / COLS;
const CELL_H = 24;
const RIM = ['#ffe9b8', '#f5902a', '#E0261B', '#ECEAE6', '#ffd166'];
const MELT_FRAMES = 34;

function meltTops(frame: number): number[] | null {
  const t = frame / MELT_FRAMES;
  if (t <= 0) return null;
  const base = -420 + (H + 600) * Math.pow(Math.min(1, t), 1.35);
  return Array.from({ length: COLS }, (_, c) => {
    const u = c / (COLS - 1);
    const wave = 95 * Math.sin(u * 7.5 + t * 4.2) + 45 * Math.sin(u * 19 - t * 6.5 + 1.3) + (random(`melt-${c}`) - 0.5) * 40;
    return Math.floor((base + (1 - u) * 380 + wave) / CELL_H) * CELL_H;
  });
}

function meltClip(tops: number[]) {
  const points: [number, number][] = [];
  tops.forEach((y, c) => points.push([c * CELL_W, y], [(c + 1) * CELL_W, y]));
  points.push([W, H + 40], [0, H + 40]);
  return { kind: 'polygon' as const, points };
}

const MeltRim: React.FC<{ tops: number[] }> = ({ tops }) => (
  <>
    {tops.flatMap((y, c) => {
      if (y >= H) return [];
      const below = Math.max(tops[c - 1] ?? y, tops[c + 1] ?? y);
      const rows = Math.min(3, Math.max(1, Math.round((below - y) / CELL_H)));
      return Array.from({ length: rows }, (_, j) => {
        const row = Math.round(y / CELL_H) + j;
        if (random(`rim-${c}-${row}`) > 0.72) return null;
        const color = RIM[Math.floor(random(`rim-c-${c}-${row}`) * RIM.length)]!;
        return <Rect key={`${c}-${j}`} x={c * CELL_W} y={y + j * CELL_H} width={CELL_W} height={CELL_H} fill={color} />;
      });
    })}
  </>
);

export const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const tops = meltTops(frame - 4);
  return (
    <>
      <AbsoluteFill>
        <PaperGround />
        <Build words={['you', 'don\u2019t.']} start={26} per={5} color={INK} size={80} style={{ position: 'absolute', left: 0, right: 0, top: 490, justifyContent: 'center' }} />
      </AbsoluteFill>
      <Layer id="melt" clip={tops ? meltClip(tops) : undefined}>
        <Image src={staticFile('stills/s03-frame.png')} width={W} height={H} />
      </Layer>
      {tops ? <MeltRim tops={tops} /> : null}
    </>
  );
};

/** The thermal duotone of the reference reel: shadows to deep red, mids orange, highlights pale gold. */
const THERMAL = gradientMap({
  stops: [
    { offset: 0, color: '#0d0605' },
    { offset: 0.18, color: '#5a0d08' },
    { offset: 0.42, color: '#d42a14' },
    { offset: 0.68, color: '#f5902a' },
    { offset: 1, color: '#ffe9b8' },
  ],
});

// ---- shot 5: the real camera (Poly Haven "Vintage Video Camera", CC0) in the thermal grade ----
export const S05: React.FC<{ graded?: boolean }> = ({ graded = true }) => {
  const frame = useCurrentFrame();
  const orbit = interpolate(frame, [6, 40], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <>
      <Rect width={W} height={H} fill={INK} />
      <Scene3D
        id="camera" width={W} height={H}
        environment={{ src: staticFile('hdri/studio_small_08_1k.hdr'), intensity: 0.6 }}
        effects={graded ? [THERMAL, glow({ radius: 40, intensity: 0.5 }), grain(0.05, { seed: 3 })] : []}
      >
        <Camera3D fov={24} position={[0.3, 0.13, 0.36]} target={[-0.045, 0.07, 0.0]} />
        <DirectionalLight direction={[0.7, -0.6, -0.5]} intensity={2.6} castShadow />
        <DirectionalLight direction={[-0.9, -0.1, 0.6]} intensity={1.4} />
        <Model src={staticFile('models/vintage_video_camera/vintage_video_camera_2k.gltf')} rotation={[0, -25 + frame * 0.6, 0]} />
      </Scene3D>
      {graded && (
        <AbsoluteFill>
          <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
            <ellipse cx={1150} cy={560} rx={560} ry={150} transform="rotate(-14 1150 560)" fill="none" stroke={PAPER} strokeWidth={4} pathLength={1} strokeDasharray="1 1" strokeDashoffset={orbit} />
          </svg>
          <Img src={staticFile('fx/hand-film.png')} style={{ position: 'absolute', left: 980, top: 600, width: 860, height: 484, mixBlendMode: 'screen', opacity: 0.95 }} />
          <Build words={['you', 'just', 'render', 'it.']} start={0} per={5} color={PAPER} size={56} style={{ position: 'absolute', left: 140, top: 510 }} />
        </AbsoluteFill>
      )}
    </>
  );
};

// ---- shot 6: 16mm burn over the cut ----
export const S06: React.FC = () => (
  <AbsoluteFill style={{ background: INK }}>
    <Img src={staticFile('pool/11-showcase-3d.jpg')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, opacity: 0.6 }} />
    <Img src={staticFile('fx/burn-16mm-01.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'screen' }} />
  </AbsoluteFill>
);

