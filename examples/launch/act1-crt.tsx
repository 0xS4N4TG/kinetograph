// Shots 3 and 4 on an old colour monitor in a dark room. Shot 3: "Right now, a browser screenshots every single frame."
// The pile of browser screenshots (act1.tsx's Problem) plays on the tube, the camera creeping in; a tracker hops from
// screenshot to screenshot on the red ball, and the voiceover writes itself in the dark beside the monitor, in shot 7's
// mixed hands (print/captions.tsx). Shot 4: "With Kinetograph, you don't need one." The tape-fed picture tears, the tube
// switches off (the raster folds to a bright line, the line to a dot, the dot dies), and the rest of the line is set in
// the film's plain face in the dark. From here on the film's own type is the plain one.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Layer, glow, grain } from '@kinetograph/core';
import { CLAMP, H, OUT, SANS, W } from './common.js';
import { IN } from './act1-kit.js';
import { Problem, ballAt } from './act1.js';
import { Captions, type CaptionLine, type Point } from './print/captions.js';
import { crt, vhs } from './looks.js';

/** The voiceover of shot 3 (sound-timing.ts puts it at frame 3). */
export const S03_LINES: CaptionLine[] = [{ file: '03-screenshot', at: 3, split: [2, 3, 3], hot: ['screenshots', 'frame'] }];

/** The monitor across both shots (frame `f` counts on from shot 3 into shot 4): where the tube face sits, creeping
 *  closer. The face is 16:9, as the picture on it. */
function tube(f: number) {
  const k = interpolate(f, [0, 140], [0, 1], CLAMP);
  const hw = 540 + 34 * k;
  const hh = hw * (9 / 16);
  return { cx: 1300 - 20 * k, cy: 540, hw, hh };
}

/** A point of the picture on the tube (picture pixels) to where it shows on the screen: through the face's placement
 *  and the glass's curve (the shader bends screen to picture; this is the inverse, a few fixed-point steps). */
function onTube(p: Point, f: number, curve: number): Point {
  const t = tube(f);
  const sx = (p.x - W / 2) / (W / 2), sy = (p.y - H / 2) / (H / 2);
  let qx = sx, qy = sy;
  for (let i = 0; i < 4; i++) { const d = 1 + curve * (qx * qx + qy * qy); qx = sx / d; qy = sy / d; }
  return { x: t.cx + qx * t.hw, y: t.cy + qy * t.hh };
}

const CURVE = 0.07;

/** The set: the room's dark, the monitor's case round the face, and the light the screen throws on the room. */
const Room: React.FC<{ f: number; light: number }> = ({ f, light }) => {
  const t = tube(f);
  return (
    <AbsoluteFill style={{ background: '#050505' }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse ${t.hw * 2.3}px ${t.hh * 2.6}px at ${t.cx}px ${t.cy}px, rgba(190,205,230,${0.13 * light}) 0%, rgba(120,130,150,${0.05 * light}) 45%, rgba(0,0,0,0) 75%)` }} />
      <div style={{
        position: 'absolute', left: t.cx - t.hw - 46, top: t.cy - t.hh - 42, width: (t.hw + 46) * 2, height: (t.hh + 42) * 2, borderRadius: 54,
        background: 'linear-gradient(160deg, #1c1c1b 0%, #101010 55%, #0a0a0a 100%)',
        boxShadow: `inset 0 2px 0 rgba(255,255,255,0.06), inset 0 -3px 8px rgba(0,0,0,0.8), 0 40px 120px rgba(0,0,0,0.9)`,
      }} />
      {/* the face's recess, a shade darker than the case */}
      <div style={{ position: 'absolute', left: t.cx - t.hw - 10, top: t.cy - t.hh - 10, width: (t.hw + 10) * 2, height: (t.hh + 10) * 2, borderRadius: 40, background: '#030303' }} />
      {/* the badge and the power lamp */}
      <div style={{ position: 'absolute', left: t.cx - 30, top: t.cy + t.hh + 14, width: 60, height: 6, borderRadius: 3, background: '#2a2a28' }} />
      <div style={{ position: 'absolute', left: t.cx + t.hw - 4, top: t.cy + t.hh + 13, width: 8, height: 8, borderRadius: 4, background: light > 0.05 ? '#7dff9a' : '#1d2a20', boxShadow: light > 0.05 ? '0 0 10px #4dff7a' : 'none' }} />
    </AbsoluteFill>
  );
};

/** The tube itself: `t` is shot 3's frame for the picture (it runs on into shot 4), `fold` switches it off. */
const Tube: React.FC<{ f: number; t: number; tear?: number; offy?: number; offx?: number; opacity?: number }> = ({ f, t, tear, offy = 1, offx = 1, opacity = 1 }) => {
  const g = tube(f);
  const effects = [
    ...(tear === undefined ? [] : [vhs({ track: tear, trackAt: 0.25 + tear * 0.5, trackW: 40 + tear * 160, jitter: 1 + tear * 8, wobble: 1 + tear * 6, snow: 0.04 + tear * 0.2, drops: 0.004 + tear * 0.03 })]),
    crt({ ...g, curve: CURVE, pitch: 7, scan: 0.75, mask: 0.3, conv: 1.6, offy, offx }),
    glow({ radius: 26, intensity: 0.45 }),
  ];
  return (
    <Layer id="s03-tube" opacity={opacity} effects={effects}>
      <Problem t={t} />
    </Layer>
  );
};

/** The shot on film stock: grain over everything, moving frame to frame. */
const Stock: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <Layer id={id} effects={[grain(0.07, { seed: 31, animate: true })]}>{children}</Layer>
);

/** The captions are set at this scale: the room is the monitor's, so the hand is smaller than on shot 7's film. */
const K = 0.62;

export const S03: React.FC = () => {
  const frame = useCurrentFrame();
  const ball = (f: number) => { const b = ballAt(f); if (!b) return null; const p = onTube(b, f, CURVE); return { x: p.x / K, y: p.y / K }; };
  const place = () => ({ x: 690 / K, y: 790 / K, side: 'left' as const });
  return (
    <Stock id="s03">
      <Room f={frame} light={1} />
      <Tube f={frame} t={frame} />
      <AbsoluteFill style={{ transform: `scale(${K})`, transformOrigin: '0 0', width: W / K, height: H / K }}>
        <Captions lines={S03_LINES} anchor={ball} place={place} width={W / K} height={H / K} top={60} />
      </AbsoluteFill>
    </Stock>
  );
};

/** Shot 4's switch-off, in shot frames: the picture tears, folds to a line, the line to a dot, the dot dies. */
export const S04_OFF = { tear: [0, 9], line: [9, 14], dot: [14, 19], die: [19, 28] } as const;
/** "you don't need one." lands on the voiceover's words (04-you-dont at frame 0). */
export const S04_WORDS = ['you', 'don’t', 'need', 'one.'];
export const S04_AT = [22, 26, 30, 35];

export const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const f = 84 + frame; // the monitor carries on from shot 3 (LEN.s03)
  const o = S04_OFF;
  const tear = interpolate(frame, [o.tear[0], o.tear[1]], [0.15, 1], { ...CLAMP, easing: IN });
  const offy = interpolate(frame, [o.line[0], o.line[1]], [1, 0.006], { ...CLAMP, easing: IN });
  const offx = interpolate(frame, [o.dot[0], o.dot[1]], [1, 0.012], { ...CLAMP, easing: IN });
  const dot = interpolate(frame, [o.die[0], o.die[1]], [1, 0], { ...CLAMP, easing: OUT });
  const light = interpolate(frame, [o.line[0], o.dot[1]], [1, 0.05], CLAMP) * dot;
  const drift = interpolate(frame, [20, 56], [1, 1.03], CLAMP);
  return (
    <Stock id="s04">
      <Room f={f} light={light} />
      {dot > 0 && <Tube f={f} t={84 + frame} tear={tear} offy={offy} offx={offx} opacity={dot} />}
      <div style={{ position: 'absolute', left: 150, top: 470, transform: `scale(${drift})`, transformOrigin: '0 50%', display: 'flex', gap: 30,
        fontFamily: SANS, fontWeight: 500, fontSize: 92, letterSpacing: '-0.015em', color: '#f3efe8', textShadow: '0 0 24px rgba(255,244,230,0.18)' }}>
        {S04_WORDS.map((w, i) => {
          const t = interpolate(frame, [S04_AT[i]!, S04_AT[i]! + 7], [0, 1], { ...CLAMP, easing: OUT });
          return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 10}px)` }}>{w}</span>;
        })}
      </div>
    </Stock>
  );
};
