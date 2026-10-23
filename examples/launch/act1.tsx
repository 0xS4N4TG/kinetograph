// Act 1, shots 1, 2 and 6: the question, and the burn; and shot 3's window pile, which act1-crt.tsx shows on a tube.
// Moves follow STORYBOARD.md "Motion rules": entrances ease out over 6 to 10 frames, exits ease in over 4 to 6, overshoot
// on objects only (never type), one move per beat. Shot 3's picture is a function of its own frame count, so shot 4
// switches off the live picture (it keeps running as the tube folds it away) rather than a still.

import React from 'react';
import { AbsoluteFill, Video, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Rect } from '@kinetograph/core';
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

export const WINDOWS = 15;
export const WIN_EVERY = 4;

/** Window `i` of the pile: its size, place, tilt and the frame it lands on. */
function windowOf(i: number) {
  const r = (k: string) => random(`s3-${i}-${k}`);
  const w = 900 + Math.round(r('w') * 160);
  return { w, h: w * 0.62, left: 120 + r('x') * 760 + (i % 3) * 30, top: 70 + r('y') * 320, rot: (r('r') - 0.5) * 9, start: i * WIN_EVERY - 6 };
}

/** The push of the pile at shot-3 frame `t`. */
const pushOf = (t: number) => 1 + 0.06 * (t / LEN.s03);

/** The window pile, the shutter glint and the counter, at shot-3 frame `t` (it may run past the shot). Each window
 *  lands once on its WIN_EVERY beat and then stays put: the only per-frame change is the counter. */
export const Problem: React.FC<{ t: number }> = ({ t }) => {
  const push = pushOf(t);
  const count = Math.min(1350, 1 + Math.floor(t * 15.2));
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
          const g = windowOf(i);
          if (t < g.start) return null;
          const a = interpolate(t, [g.start, g.start + 6], [0, 1], { ...CLAMP, easing: BACK });
          return (
            <BrowserWindow
              key={i}
              shot={i * 4}
              w={g.w}
              style={{ left: g.left, top: g.top, transform: `rotate(${g.rot}deg) scale(${0.86 + 0.14 * a})`, opacity: Math.min(1, a * 1.5) }}
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
      <div style={{ position: 'absolute', right: 110, top: 80, fontFamily: MONO, fontSize: 34, color: '#e6e6e6', textShadow: '0 2px 12px rgba(0,0,0,0.7)' }}>
        {`screenshot ${String(count).padStart(4, '0')} / 1350`}
      </div>
    </>
  );
};

/** The red ball of the newest window in the pile at shot-3 frame `t`, in the pile's frame pixels: the thing shot 3's
 *  tracker follows from screenshot to screenshot. */
export function ballAt(t: number): { x: number; y: number } | null {
  const i = Math.min(WINDOWS - 1, Math.floor((t + 6) / WIN_EVERY));
  if (i < 0) return null;
  const g = windowOf(i);
  const a = interpolate(t, [g.start, g.start + 6], [0, 1], { ...CLAMP, easing: BACK });
  const s = 0.86 + 0.14 * a;
  // the ball's centre in the window (BrowserWindow's drawing), about the window's centre
  const bodyH = g.h - 44;
  const u = ((i * 4) % 60) / 59;
  const lx = 80 + u * (g.w - 220) + 30 - g.w / 2;
  const ly = 44 + bodyH * 0.62 - Math.sin(u * Math.PI) * bodyH * 0.38 + 30 - g.h / 2;
  const th = (g.rot * Math.PI) / 180;
  const x = g.left + g.w / 2 + s * (lx * Math.cos(th) - ly * Math.sin(th));
  const y = g.top + g.h / 2 + s * (lx * Math.sin(th) + ly * Math.cos(th));
  const p = pushOf(t);
  return { x: W / 2 + (x - W / 2) * p, y: H / 2 + (y - H / 2) * p };
}

// ---- shot 6: 16mm burn over the cut, screen-blended onto whatever is under it ----

export const S06: React.FC = () => (
  <Over blend="screen"><Video muted src={staticFile('fx/burn-16mm-01.mp4')} width={W} height={H} fit="cover" /></Over>
);
