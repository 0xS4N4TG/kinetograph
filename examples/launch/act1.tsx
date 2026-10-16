// Act 1, shots 1 to 6: the question, the problem, the melt, the camera, the burn.
// Moves follow STORYBOARD.md "Motion rules": entrances ease out over 6 to 10 frames, exits ease in over 4 to 6, overshoot
// on objects only (never type), one move per beat. Shot 3's picture is a function of its own frame count, so shot 4
// melts the live picture (it keeps running while it drains) rather than a still.

import React from 'react';
import { AbsoluteFill, Easing, Img, Video, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Rect } from '@kinetograph/core';
import { CLAMP, H, INK, LEN, MONO, MUSTARD, OUT, PAPER, RED, W } from './common.js';
import { S05 } from './act1-camera.js';
import { BACK, Over, How, IN, IO, InkGround, PaperGround, Words } from './act1-kit.js';

export { S05 };

// ---- shot 1: "how" ----

export const S01: React.FC = () => {
  const frame = useCurrentFrame();
  // 104% to 100% in 5 frames, then the slow push that carries into the cut.
  const settle = interpolate(frame, [0, 5], [1.04, 1], { ...CLAMP, easing: OUT });
  const push = interpolate(frame, [0, LEN.s01], [1, 1.035], CLAMP);
  const crawl = frame * 15;
  return (
    <>
      <AbsoluteFill style={{ background: MUSTARD }} />
      <Over blend="multiply" opacity={0.18}><Video muted src={staticFile('fx/grunge-06.mp4')} loop /></Over>
      <AbsoluteFill>
        <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <line x1={0} y1={96} x2={W} y2={96} stroke={INK} strokeWidth={6} strokeDasharray="44 30" strokeDashoffset={crawl} />
          <line x1={0} y1={H - 96} x2={W} y2={H - 96} stroke={INK} strokeWidth={6} strokeDasharray="44 30" strokeDashoffset={crawl} />
        </svg>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${settle * push})` }}>
          <How color="#2a210f" />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, rgba(60,30,0,0.2) 100%)' }} />
    </>
  );
};

// ---- shot 2: the question; a redaction bar wipes the big "how" off, the sentence builds, an ink stroke writes itself ----

const BAR_W = 1560;

export const S02: React.FC = () => {
  const frame = useCurrentFrame();
  const words = 'how do you make a video without a browser?'.split(' ');
  // The big "how" carries on from shot 1's push, then the bar takes it: in over 6 frames (ease in-out), out over 6 (ease in).
  const push = 1.035 + interpolate(frame, [0, 10], [0, 0.02], CLAMP);
  const barIn = interpolate(frame, [4, 10], [-BAR_W, 0], { ...CLAMP, easing: IO });
  const barOut = interpolate(frame, [11, 17], [0, W + 40], { ...CLAMP, easing: IN });
  const covered = frame >= 10;
  const at = words.map((_, i) => 13 + i * 4);
  const draw = interpolate(frame, [at[8]! + 4, at[8]! + 20], [1, 0], { ...CLAMP, easing: OUT });
  const draw2 = interpolate(frame, [at[8]! + 12, at[8]! + 24], [1, 0], { ...CLAMP, easing: OUT });
  const drift = interpolate(frame, [12, LEN.s02], [1, 1.035], CLAMP);
  return (
    <>
      <PaperGround />
      {!covered && (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${push})` }}>
          <How color="#2a210f" />
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ transform: `scale(${drift})` }}>
        <Words words={words} at={at} color={INK} size={74} style={{ position: 'absolute', left: 0, right: 0, top: 480, justifyContent: 'center' }} />
        <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <path
            transform="translate(1430 588) scale(0.83) translate(-1268 -690)" d="M1268 690 C1320 712 1372 662 1420 694 S1520 732 1580 676 C1606 652 1618 700 1652 692"
            fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw}
          />
          <path transform="translate(1500 20)" d="M1470 640 c18 -36 36 36 54 0 s28 -28 46 8" fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" opacity={0.5} pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw2} />
        </svg>
      </AbsoluteFill>
      {frame >= 4 && frame < 18 && <Over><Rect x={frame < 11 ? barIn : barOut} y={250} width={BAR_W} height={560} fill={INK} motionBlur={{ samples: 10, shutter: 0.6 }} /></Over>}
    </>
  );
};

/** Our own renders for the screenshots (the files present in public/pool; common's POOL names one that is missing). */
const POOL = [
  '01-showcase-v1', '02-showcase-v1', '03-showcase-v1', '04-showcase-v1', '06-showcase-v1', '07-showcase-v1', '08-showcase-v1',
  '10-showcase-v1', '11-showcase-3d', '12-showcase-3d', '13-showcase-3d', '16-ep13-5s', '17-ep13-5s', '18-ep13-5s', '19-open-v4', '20-open-v4',
].map((n) => staticFile(`pool/${n}.jpg`));

// ---- shot 3: every frame, a screenshot (a function of the shot's own frame count `t`, so shot 4 can carry on from it) ----

/** A browser window drawn in CSS, holding one of our frames: what other tools screenshot. */
const BrowserWindow: React.FC<{ src: string; w: number; shot: number; style?: React.CSSProperties }> = ({ src, w, shot, style }) => {
  const h = w * 0.62;
  return (
    <div style={{ position: 'absolute', width: w, height: h, borderRadius: 14, overflow: 'hidden', background: '#202124', boxShadow: '0 30px 80px rgba(0,0,0,0.5)', ...style }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '0 16px', background: '#2b2c2f' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
        <div style={{ marginLeft: 18, flex: 1, height: 26, borderRadius: 13, background: '#3a3b3e', color: '#aaa', fontFamily: MONO, fontSize: 14, display: 'flex', alignItems: 'center', paddingLeft: 14 }}>
          {`localhost:3000/render?frame=${String(shot).padStart(4, '0')}`}
        </div>
      </div>
      <Img src={src} style={{ width: w, height: h - 44, objectFit: 'cover' }} />
    </div>
  );
};

const WINDOWS = 15;
const WIN_EVERY = 4;

/** The pile of screenshots, the flash, the slash, the counter and the line, at shot-3 frame `t` (it may run past the shot). */
const Problem: React.FC<{ t: number }> = ({ t }) => {
  const n = Math.floor(t / 2);
  const push = 1 + 0.07 * (t / LEN.s03);
  const slash = interpolate(t, [44, 50], [-W - 200, 0], { ...CLAMP, easing: OUT });
  const count = Math.min(1350, 1 + Math.floor(t * 15.2));
  // Flash on every sixth frame, decaying over the next two.
  const phase = t % 6;
  const flash = phase === 0 ? 0.3 : phase === 1 ? 0.12 : phase === 2 ? 0.04 : 0;
  const at = [6, 10, 24, 28];
  return (
    <>
      <InkGround />
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        {Array.from({ length: WINDOWS }, (_, i) => {
          const start = i * WIN_EVERY - 6;
          const a = interpolate(t, [start, start + 6], [0, 1], { ...CLAMP, easing: BACK });
          if (t < start) return null;
          const r = (k: string) => random(`s3-${i}-${k}`);
          const left = 120 + r('x') * 760 + (i % 3) * 30;
          const top = 70 + r('y') * 320;
          return (
            <BrowserWindow
              key={i}
              src={POOL[(i * 5 + n) % POOL.length]!}
              shot={47 + i * 31 + n}
              w={900 + Math.round(r('w') * 160)}
              style={{ left, top, transform: `rotate(${(r('r') - 0.5) * 9}deg) scale(${0.86 + 0.14 * a})`, opacity: Math.min(1, a * 1.5) }}
            />
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: '#fff', opacity: flash }} />
      <AbsoluteFill style={{ background: 'linear-gradient(0deg, rgba(17,17,17,0.92) 0%, rgba(17,17,17,0) 30%)' }} />
      <div style={{ position: 'absolute', left: -200, top: 330, width: 2400, height: 22, background: RED, transform: `translateX(${slash}px) rotate(-9deg)`, opacity: 0.92 }} />
      <div style={{ position: 'absolute', right: 110, top: 80, fontFamily: MONO, fontSize: 34, color: '#e6e6e6', textShadow: '0 2px 12px rgba(0,0,0,0.7)' }}>
        {`screenshot ${String(count).padStart(4, '0')} / 1350`}
      </div>
      <Words words={['every', 'frame.', 'a', 'screenshot.']} at={at.map((a) => a)} color={PAPER} size={78} style={{ position: 'absolute', left: 130, top: 880 }} />
    </>
  );
};

export const S03: React.FC = () => {
  const frame = useCurrentFrame();
  return <Problem t={frame} />;
};

// ---- shot 4: the live shot-3 picture drains away in the showcase's pixel melt, onto paper; then ink rises for shot 5 ----
// The melt (from examples/showcase, shot 1): the picture's top edge falls in columns of 40 px, in steps of 24 px,
// leading on the left, with a rim of bright cells; what is behind is left.
const COLS = 48;
const CELL_W = W / COLS;
const CELL_H = 24;
const RIM = ['#ffe9b8', '#f5902a', '#E0261B', '#ECEAE6', '#ffd166'];
const MELT_FRAMES = 34;
const RISE_AT = 47;

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

/** Ink coming up from the bottom for the cut to shot 5: the melt's grid run backwards, leading on the right. */
function riseTops(frame: number): number[] | null {
  const t = interpolate(frame, [RISE_AT, RISE_AT + 8], [0, 1], { ...CLAMP, easing: IN });
  if (t <= 0) return null;
  const base = H + 500 - (H + 1000) * t;
  return Array.from({ length: COLS }, (_, c) => {
    const u = c / (COLS - 1);
    const wave = 40 * Math.sin(u * 9 + t * 5) + (random(`rise-${c}`) - 0.5) * 50;
    return Math.floor((base + u * 300 + wave) / CELL_H) * CELL_H;
  });
}

function meltClip(tops: number[]) {
  const points: [number, number][] = [];
  tops.forEach((y, c) => points.push([c * CELL_W, y], [(c + 1) * CELL_W, y]));
  points.push([W, H + 40], [0, H + 40]);
  return { kind: 'polygon' as const, points };
}

const MeltRim: React.FC<{ tops: number[]; seed: string }> = ({ tops, seed }) => (
  <>
    {tops.flatMap((y, c) => {
      if (y >= H || y < -CELL_H) return [];
      const below = Math.max(tops[c - 1] ?? y, tops[c + 1] ?? y);
      const rows = Math.min(3, Math.max(1, Math.round((below - y) / CELL_H)));
      return Array.from({ length: rows }, (_, j) => {
        const row = Math.round(y / CELL_H) + j;
        if (random(`${seed}-${c}-${row}`) > 0.72) return null;
        const color = RIM[Math.floor(random(`${seed}-c-${c}-${row}`) * RIM.length)]!;
        return <Rect key={`${c}-${j}`} x={c * CELL_W} y={y + j * CELL_H} width={CELL_W} height={CELL_H} fill={color} />;
      });
    })}
  </>
);

export const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const tops = meltTops(frame - 3);
  const rise = riseTops(frame);
  // "you don't." lands as the picture clears, drifts forward, and leaves with the rising ink.
  const grow = interpolate(frame, [24, LEN.s04], [1, 1.06], CLAMP);
  return (
    <>
      <PaperGround />
      <AbsoluteFill style={{ transform: `scale(${grow})` }}>
        <Words words={['you', 'don’t.']} at={[22, 27]} color={INK} size={110} weight={700} style={{ position: 'absolute', left: 0, right: 0, top: 440, justifyContent: 'center' }} />
      </AbsoluteFill>
      <Over>
        <Layer id="melt" clip={tops ? meltClip(tops) : undefined}>
          <Problem t={LEN.s03 + frame} />
        </Layer>
      </Over>
      {tops ? <Over><MeltRim tops={tops} seed="rim" /></Over> : null}
      {rise ? <Over><Rect id="rise" width={W} height={H} fill={INK} clip={meltClip(rise)} /></Over> : null}
      {rise ? <Over><MeltRim tops={rise} seed="rise-rim" /></Over> : null}
    </>
  );
};

// ---- shot 6: 16mm burn over the cut, screen-blended onto whatever is under it ----

export const S06: React.FC = () => (
  <Over blend="screen"><Video muted src={staticFile('fx/burn-16mm-01.mp4')} width={W} height={H} fit="cover" /></Over>
);
