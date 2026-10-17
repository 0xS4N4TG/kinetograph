// Act 1, shots 1 to 6: the question, the problem, the melt, the camera, the burn.
// Moves follow STORYBOARD.md "Motion rules": entrances ease out over 6 to 10 frames, exits ease in over 4 to 6, overshoot
// on objects only (never type), one move per beat. Shot 3's picture is a function of its own frame count, so shot 4
// melts the live picture (it keeps running while it drains) rather than a still.

import React from 'react';
import { AbsoluteFill, Video, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Rect } from '@kinetograph/core';
import { measureText } from '@remotion/layout-utils';
import { CLAMP, H, HAND, INK, LEN, MONO, MUSTARD, OUT, PAPER, RED, SANS, W } from './common.js';
import { S05 } from './act1-camera.js';
import { BACK, Over, How, IN, IO, InkGround, PaperGround, Words } from './act1-kit.js';

export { S05 };

// ---- shot 1: "how" ----

// The reel's opener: one word, four looks in under a second, a hard cut every 6 frames on the "How" of the VO.
export const LOOK = 6;

const Dashes: React.FC<{ frame: number; color: string; inset: number }> = ({ frame, color, inset }) => (
  <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
    <line x1={0} y1={inset} x2={W} y2={inset} stroke={color} strokeWidth={5} strokeDasharray="40 28" strokeDashoffset={frame * 14} />
    <line x1={0} y1={H - inset} x2={W} y2={H - inset} stroke={color} strokeWidth={5} strokeDasharray="40 28" strokeDashoffset={-frame * 14} />
  </svg>
);

export const S01: React.FC = () => {
  const frame = useCurrentFrame();
  const look = Math.min(3, Math.floor(frame / LOOK));
  const f = frame - look * LOOK;
  // Each look lands 6% big and settles in 4 frames.
  const s = interpolate(f, [0, 4], [1.06, 1], { ...CLAMP, easing: OUT });
  const centre = { alignItems: 'center', justifyContent: 'center', transform: `scale(${s})` } as const;
  if (look === 0) {
    return (
      <>
        <PaperGround />
        <AbsoluteFill style={centre}>
          <div style={{ fontFamily: HAND, fontSize: 300, color: INK, transform: 'rotate(-4deg)', marginTop: -40 }}>How</div>
        </AbsoluteFill>
      </>
    );
  }
  if (look === 1) {
    return (
      <>
        <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 75% at 50% 46%, #E5352A 0%, ${RED} 50%, #9E140D 100%)` }} />
        <AbsoluteFill style={{ ...centre, transform: `scale(${s}) scaleY(2.3)` }}>
          <How color={INK} />
        </AbsoluteFill>
      </>
    );
  }
  if (look === 2) {
    return (
      <>
        <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 75% at 50% 46%, #E6B634 0%, ${MUSTARD} 50%, #A97C10 100%)` }} />
        <Dashes frame={frame} color="#2a210f" inset={110} />
        <AbsoluteFill style={centre}><How color="#2a210f" /></AbsoluteFill>
      </>
    );
  }
  return (
    <>
      <PaperGround />
      <Dashes frame={frame} color="#6b6b6b" inset={360} />
      <AbsoluteFill style={centre}><How color="#2a210f" /></AbsoluteFill>
    </>
  );
};

// ---- shot 2: the question; a redaction bar wipes the big "how" off, the sentence builds, an ink stroke writes itself ----

const BAR_W = 1560;
export const S02_WORDS = 'how do you make a video with code, without a browser?'.split(' ');
export const S02_AT = [12, 16, 19, 22, 27, 29, 35, 40, 48, 55, 61];
const S02_SIZE = 62;
const S02_TOP = 480;

/** The ink stroke under the last word, placed from the measured line (centred, the gap of Words). */
function s02Stroke() {
  const font = { fontFamily: SANS, fontSize: S02_SIZE, fontWeight: '500', letterSpacing: `${-0.01 * S02_SIZE}px` };
  const widths = S02_WORDS.map((text) => measureText({ text, ...font }).width);
  const gap = S02_SIZE * 0.26;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const x1 = (W + total) / 2;
  const x0 = x1 - widths[widths.length - 1]!;
  const y = S02_TOP + S02_SIZE * 1.18;
  const w = x1 - x0;
  return {
    d: `M${x0 - 6} ${y} C${x0 + w * 0.3} ${y + 16} ${x0 + w * 0.6} ${y - 14} ${x1 + 10} ${y + 2}`,
    flick: `M${x1 + 22} ${y - 30} c14 -26 28 26 42 0 s22 -22 36 6`,
  };
}

export const S02: React.FC = () => {
  const frame = useCurrentFrame();
  const words = S02_WORDS;
  // The big "how" carries on from shot 1's push, then the bar takes it: in over 6 frames (ease in-out), out over 6 (ease in).
  const push = 1.035 + interpolate(frame, [0, 10], [0, 0.02], CLAMP);
  const barIn = interpolate(frame, [4, 10], [-BAR_W, 0], { ...CLAMP, easing: IO });
  const barOut = interpolate(frame, [11, 17], [0, W + 40], { ...CLAMP, easing: IN });
  const covered = frame >= 10;
  // Each word lands on the voiceover (02-question at frame 12 of the shot, see sound-timing.ts).
  const at = S02_AT;
  const last = at[at.length - 1]!;
  const draw = interpolate(frame, [last + 4, last + 20], [1, 0], { ...CLAMP, easing: OUT });
  const draw2 = interpolate(frame, [last + 12, last + 24], [1, 0], { ...CLAMP, easing: OUT });
  const S02_STROKE = s02Stroke();
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
        <Words words={words} at={at} color={INK} size={S02_SIZE} style={{ position: 'absolute', left: 0, right: 0, top: S02_TOP, justifyContent: 'center' }} />
        <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <path d={S02_STROKE.d} fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw} />
          <path d={S02_STROKE.flick} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" opacity={0.5} pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw2} />
        </svg>
      </AbsoluteFill>
      {frame >= 4 && frame < 18 && <Over><Rect x={frame < 11 ? barIn : barOut} y={250} width={BAR_W} height={560} fill={INK} motionBlur={{ samples: 10, shutter: 0.6 }} /></Over>}
    </>
  );
};

// ---- shot 3: every frame, a screenshot (a function of the shot's own frame count `t`, so shot 4 can carry on from it) ----

/** A browser window drawn in CSS holding frame `shot` of a tiny animation (a red ball crossing a paper page, its frame
 *  number in the corner): one screenshot per frame, the way browser renderers work. */
const BrowserWindow: React.FC<{ w: number; shot: number; style?: React.CSSProperties }> = ({ w, shot, style }) => {
  const h = w * 0.62;
  const bodyH = h - 44;
  const u = (shot % 60) / 59;
  const bx = 80 + u * (w - 220);
  const by = bodyH * 0.62 - Math.sin(u * Math.PI) * bodyH * 0.38;
  return (
    <div style={{ position: 'absolute', width: w, height: h, borderRadius: 14, overflow: 'hidden', background: '#202124', boxShadow: '0 30px 80px rgba(0,0,0,0.5)', ...style }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '0 16px', background: '#2b2c2f' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
        <div style={{ marginLeft: 18, flex: 1, height: 26, borderRadius: 13, background: '#3a3b3e', color: '#aaa', fontFamily: MONO, fontSize: 14, display: 'flex', alignItems: 'center', paddingLeft: 14 }}>
          {`localhost:3000/render?frame=${String(shot).padStart(4, '0')}`}
        </div>
      </div>
      <div style={{ position: 'relative', width: w, height: bodyH, background: '#ECEAE6' }}>
        <div style={{ position: 'absolute', left: 60, right: 60, top: bodyH * 0.62 + 30, height: 3, background: '#c9c6c0' }} />
        <div style={{ position: 'absolute', left: bx, top: by, width: 60, height: 60, borderRadius: 30, background: RED }} />
        <div style={{ position: 'absolute', right: 26, bottom: 18, fontFamily: MONO, fontSize: 22, color: '#8a8780' }}>{`frame ${String(shot).padStart(4, '0')}`}</div>
      </div>
    </div>
  );
};

/** "every frame. a screenshot." lands on the VO's "every single frame" (03-screenshot at frame 3). */
export const S03_AT = [31, 45, 55, 63];
export const WINDOWS = 15;
export const WIN_EVERY = 4;

/** The pile of screenshots, the flash, the slash, the counter and the line, at shot-3 frame `t` (it may run past the shot). */
/** The window pile, the shutter glint, the counter and the line, at shot-3 frame `t` (it may run past the shot). Each
 *  window lands once on its WIN_EVERY beat and then stays put: the only per-frame change is the counter. */
const Problem: React.FC<{ t: number }> = ({ t }) => {
  const push = 1 + 0.06 * (t / LEN.s03);
  const count = Math.min(1350, 1 + Math.floor(t * 15.2));
  const at = S03_AT;
  // A four-point star glints on the window that just landed (the reel's accent), over 5 frames.
  const last = Math.min(WINDOWS - 1, Math.floor((t + 6) / WIN_EVERY));
  const since = t - (last * WIN_EVERY - 6);
  const rl = (k: string) => random(`s3-${last}-${k}`);
  const glint = interpolate(since, [0, 2, 6], [0, 1, 0], CLAMP);
  return (
    <>
      <InkGround />
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        {Array.from({ length: WINDOWS }, (_, i) => {
          const start = i * WIN_EVERY - 6;
          if (t < start) return null;
          const a = interpolate(t, [start, start + 6], [0, 1], { ...CLAMP, easing: BACK });
          const r = (k: string) => random(`s3-${i}-${k}`);
          return (
            <BrowserWindow
              key={i}
              shot={i * 4}
              w={900 + Math.round(r('w') * 160)}
              style={{ left: 120 + r('x') * 760 + (i % 3) * 30, top: 70 + r('y') * 320, transform: `rotate(${(r('r') - 0.5) * 9}deg) scale(${0.86 + 0.14 * a})`, opacity: Math.min(1, a * 1.5) }}
            />
          );
        })}
      </AbsoluteFill>
      {glint > 0 && (
        <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <g transform={`translate(${260 + rl('x') * 760 + 880} ${120 + rl('y') * 320}) scale(${0.4 + glint})`}>
            <path d="M0 -70 Q6 -6 70 0 Q6 6 0 70 Q-6 6 -70 0 Q-6 -6 0 -70 Z" fill="#fff" opacity={glint} />
          </g>
        </svg>
      )}
      <AbsoluteFill style={{ background: 'linear-gradient(0deg, rgba(10,10,10,0.97) 0%, rgba(10,10,10,0.9) 16%, rgba(10,10,10,0) 42%)' }} />
      <div style={{ position: 'absolute', right: 110, top: 80, fontFamily: MONO, fontSize: 34, color: '#e6e6e6', textShadow: '0 2px 12px rgba(0,0,0,0.7)' }}>
        {`screenshot ${String(count).padStart(4, '0')} / 1350`}
      </div>
      <Words words={['every', 'frame.', 'a', 'screenshot.']} at={at} color={PAPER} size={78} style={{ position: 'absolute', left: 130, top: 880 }} />
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
export const RISE_AT = 47;

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
        <Words words={['you', 'don’t.']} at={[22, 26]} color={INK} size={110} weight={700} style={{ position: 'absolute', left: 0, right: 0, top: 440, justifyContent: 'center' }} />
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
