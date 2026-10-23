// Shots 3 and 4 on an old colour tube that fills the frame. Shot 3: "Today, to make a video with code, a browser
// screenshots every single frame." The pile of browser screenshots (act1.tsx's Problem) plays on the tube, curved by its glass and drawn in
// scanlines; a tracker hops from screenshot to screenshot on the red ball, and the voiceover writes itself under the
// pile, on the same glass, in shot 7's mixed hands (print/captions.tsx). Shot 4: "With Kinetograph, you don't need one."
// The tape-fed picture tears, the tube switches off (the raster folds to a bright line, the line to a dot, the dot
// dies), and the rest of the line is set in the film's plain face in the dark. From here on the film's own type is the
// plain one.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Layer, glow, grain } from '@kinetograph/core';
import { CLAMP, H, LEN, OUT, SANS, W } from './common.js';
import { IN } from './act1-kit.js';
import { Problem, ballAt } from './act1.js';
import { Captions, type CaptionLine, type Point } from './print/captions.js';
import { crt, vhs } from './looks.js';
import { VO, spoken } from './sound-timing.js';

/** The voiceover of shot 3: "Today," / "to make a video" / "with code," / "a browser screenshots" / "every single frame." */
export const S03_LINES: CaptionLine[] = [{ file: '03-today', at: VO.find((v) => v.file === '03-today')!.at, split: [1, 4, 2, 3, 3], hot: ['today', 'screenshots', 'frame'] }];

/** The pile sits up and to the right on the tube, leaving the dark under it for the words. */
const PILE = { x: 330, y: 10, s: 0.8 };
const onPile = (p: Point): Point => ({ x: PILE.x + p.x * PILE.s, y: PILE.y + p.y * PILE.s });

/** The captions are set at this scale, a little smaller than on shot 7's film. */
const K = 0.64;

/** The shot on film stock: grain over everything, moving frame to frame. */
const Stock: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <Layer id={id} effects={[grain(0.07, { seed: 31, animate: true })]}>{children}</Layer>
);

/** The tube: everything under it is the picture on its glass. `tear` runs the picture through a failing tape first;
 *  `offy` and `offx` switch it off. */
const Tube: React.FC<{ id: string; tear?: number; offy?: number; offx?: number; opacity?: number; children: React.ReactNode }> = ({ id, tear, offy = 1, offx = 1, opacity = 1, children }) => {
  const effects = [
    ...(tear === undefined ? [] : [vhs({ track: tear, trackAt: 0.25 + tear * 0.5, trackW: 40 + tear * 160, jitter: 1 + tear * 8, wobble: 1 + tear * 6, snow: 0.04 + tear * 0.2, drops: 0.004 + tear * 0.03 })]),
    crt({ curve: 0.09, pitch: 4, scan: 0.75, mask: 0.3, conv: 1.8, offy, offx }),
    glow({ radius: 30, intensity: 0.45 }),
  ];
  return <Layer id={id} opacity={opacity} effects={effects}>{children}</Layer>;
};

/** The pile at shot-3 frame `t`, placed on the tube. */
const Picture: React.FC<{ t: number }> = ({ t }) => (
  <AbsoluteFill style={{ background: '#000' }}>
    <AbsoluteFill style={{ transform: `translate(${PILE.x}px, ${PILE.y}px) scale(${PILE.s})`, transformOrigin: '0 0' }}>
      <Problem t={t} />
    </AbsoluteFill>
  </AbsoluteFill>
);

export const S03: React.FC = () => {
  const frame = useCurrentFrame();
  const ball = (f: number) => { const b = ballAt(f); if (!b) return null; const p = onPile(b); return { x: p.x / K, y: p.y / K }; };
  // the words hang along the bottom, under the pile, from the left
  const place = () => ({ x: 120 / K, y: H / K, side: 'right' as const });
  return (
    <Stock id="s03">
      <Tube id="s03-tube">
        <Picture t={frame} />
        <AbsoluteFill style={{ transform: `scale(${K})`, transformOrigin: '0 0', width: W / K, height: H / K }}>
          <Captions lines={S03_LINES} anchor={ball} place={place} width={W / K} height={H / K} top={60} />
        </AbsoluteFill>
      </Tube>
    </Stock>
  );
};

/** Shot 4's switch-off, in shot frames: the picture tears, folds to a line, the line to a dot, the dot dies. */
export const S04_OFF = { tear: [0, 9], line: [9, 14], dot: [14, 19], die: [19, 28] } as const;
/** "you don't need one." lands on the voiceover's words. */
export const S04_WORDS = ['you', 'don’t', 'need', 'one.'];
export const S04_AT = spoken('04-you-dont').slice(2).map((w) => w.from);

export const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const o = S04_OFF;
  const tear = interpolate(frame, [o.tear[0], o.tear[1]], [0.15, 1], { ...CLAMP, easing: IN });
  const offy = interpolate(frame, [o.line[0], o.line[1]], [1, 0.006], { ...CLAMP, easing: IN });
  const offx = interpolate(frame, [o.dot[0], o.dot[1]], [1, 0.012], { ...CLAMP, easing: IN });
  const dot = interpolate(frame, [o.die[0], o.die[1]], [1, 0], { ...CLAMP, easing: OUT });
  const drift = interpolate(frame, [20, 56], [1, 1.03], CLAMP);
  return (
    <Stock id="s04">
      <AbsoluteFill style={{ background: '#000' }} />
      {dot > 0 && (
        <Tube id="s04-tube" tear={tear} offy={offy} offx={offx} opacity={dot}>
          <Picture t={LEN.s03 + frame} />
        </Tube>
      )}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${drift})`, display: 'flex', gap: 28, marginTop: -20,
          fontFamily: SANS, fontWeight: 500, fontSize: 92, letterSpacing: '-0.015em', color: '#f3efe8', textShadow: '0 0 24px rgba(255,244,230,0.18)' }}>
          {S04_WORDS.map((w, i) => {
            const t = interpolate(frame, [S04_AT[i]!, S04_AT[i]! + 7], [0, 1], { ...CLAMP, easing: OUT });
            return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 10}px)` }}>{w}</span>;
          })}
        </div>
      </AbsoluteFill>
    </Stock>
  );
};
