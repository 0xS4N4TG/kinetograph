// Shot 7: "Your demo / launch / changelog". The scene of inspire.mp4, rebuilt with our own renders: a line of small type
// swaps its word, cards of our renders (stills and short clips of the showcase, 3D and rajz films) pop in around it
// tinted green and orange and settle to true colour, then everything greys, blurs and pulls to the centre as the
// ground goes dark, and "that render for you" types on with a block cursor.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, interpolateColors, staticFile, useCurrentFrame } from 'remotion';
import { Image, Layer, Video, blur, gradientMap } from '@kinetograph/core';
import { CLAMP, INK, OUT, SANS } from './common.js';

const CREAM = '#F3EFEC';
const DARK = '#121212';
const pool = (n: string) => staticFile(`pool/${n}`);

type Card = { x: number; y: number; w: number; h: number; src: string; video?: boolean; r: number; at: number; hue: 'g' | 'o' };
/** Where each card sits (x, y, w, h; several run off the frame), what it shows and the frame it pops in. */
const CARDS: Card[] = [
  { x: -10, y: 566, w: 572, h: 444, src: pool('clip-pig.mp4'), video: true, r: 0, at: 2, hue: 'g' },
  { x: 1380, y: -50, w: 430, h: 500, src: pool('clip-ep13.mp4'), video: true, r: 30, at: 5, hue: 'g' },
  { x: 330, y: 840, w: 520, h: 292, src: pool('clip-clouds.mp4'), video: true, r: 0, at: 20, hue: 'o' },
  { x: 1230, y: 706, w: 720, h: 405, src: pool('clip-code.mp4'), video: true, r: 0, at: 32, hue: 'g' },
  { x: -30, y: 70, w: 480, h: 300, src: pool('clip-imagine.mp4'), video: true, r: 0, at: 44, hue: 'o' },
  { x: 1640, y: 500, w: 360, h: 203, src: pool('16-ep13-5s.jpg'), r: 0, at: 56, hue: 'g' },
  { x: 700, y: -36, w: 440, h: 248, src: pool('07-showcase-v1.jpg'), r: 0, at: 68, hue: 'o' },
  { x: 560, y: 600, w: 330, h: 186, src: pool('12-showcase-3d.jpg'), r: 0, at: 80, hue: 'g' },
];

const stops = (a: string, b: string, c: string) => [{ offset: 0, color: a }, { offset: 0.5, color: b }, { offset: 1, color: c }];
const GREEN = stops('#26463a', '#6fa07f', '#d6ead9');
const ORANGE = stops('#3d2314', '#c47c45', '#ffe0b3');
const PALE = stops('#7f8c70', '#c2cdb2', '#eef3e2');

/** Little squares scattered over the ground: (x, y, colour, frame it appears). */
const DOTS: [number, number, string, number][] = [
  [300, 184, '#c97a5f', 0], [1712, 160, '#c97a5f', 0], [1552, 628, '#55603f', 0], [984, 784, '#c97a5f', 0], [300, 1264 - 220, '#c97a5f', 0],
  [848, 248, '#55603f', 10], [1170, 960, '#55603f', 14], [1500, 940, '#c97a5f', 22], [560, 700, '#55603f', 30],
];
const WORDS = [{ w: 'demo', at: 3 }, { w: 'launch', at: 36 }, { w: 'changelog', at: 69 }];
const COLLAPSE = [94, 118] as const;
const DARK_AT = [104, 112] as const;
const TYPE_AT = 118;
const TEXT = 'that render for you';

const roundRect = (w: number, h: number, r: number) =>
  `M${r} 0H${w - r}Q${w} 0 ${w} ${r}V${h - r}Q${w} ${h} ${w - r} ${h}H${r}Q0 ${h} 0 ${h - r}V${r}Q0 0 ${r} 0Z`;

const Sq: React.FC<{ c: string; pop: number }> = ({ c, pop }) => (
  <div style={{ width: 13, height: 13, background: c, opacity: pop, transform: `scale(${0.4 + 0.6 * pop})` }} />
);

export const S07: React.FC = () => {
  const frame = useCurrentFrame();
  const collapse = interpolate(frame, COLLAPSE, [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const dark = interpolate(frame, DARK_AT, [0, 1], CLAMP);
  const ground = interpolateColors(dark, [0, 1], [CREAM, DARK]);
  const lineAlpha = interpolate(frame, [96, 112], [1, 0], CLAMP);
  const cardsOut = interpolate(frame, [114, 128], [1, 0], { ...CLAMP, easing: Easing.in(Easing.quad) });

  const cur = [...WORDS].reverse().find((s) => frame >= s.at) ?? WORDS[0]!;
  const idx = WORDS.indexOf(cur);
  const age = frame - cur.at;
  const wordIn = interpolate(age, [0, 8], [0, 1], CLAMP);
  const wordColor = interpolateColors(wordIn, [0, 1], ['#bdb6ae', INK]);
  const sq = interpolate(age, [0, 6], [0, 1], { ...CLAMP, easing: OUT });

  const typedCount = Math.max(0, Math.min(TEXT.length, Math.floor((frame - TYPE_AT) / 1.1) + 1));
  const typing = frame >= TYPE_AT;
  const cursorOn = typing && (typedCount < TEXT.length || frame < TYPE_AT + 22 + 10) && (typedCount < TEXT.length || Math.floor(frame / 5) % 2 === 0);

  return (
    <AbsoluteFill style={{ background: ground }}>
      {DOTS.map(([x, y, c, at], i) => (
        <div key={i} style={{ position: 'absolute', left: x, top: y, width: 11, height: 11, background: c, opacity: frame >= at ? 1 - collapse : 0 }} />
      ))}
      {frame < 114 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, height: 80, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, fontFamily: SANS, fontWeight: 400, fontSize: 64, color: INK, opacity: lineAlpha }}>
          <div style={{ display: 'flex', gap: 6, width: 32, justifyContent: 'flex-end' }}>
            {idx >= 1 && <Sq c="#55603f" pop={idx === 1 ? sq : 1} />}
            {idx >= 2 && <Sq c="#cfc9c2" pop={sq} />}
          </div>
          <span>Your <span style={{ color: wordColor }}>{cur.w}</span></span>
          <div style={{ display: 'flex', gap: 6, width: 32 }}>
            {idx >= 2 && <Sq c="#cfc9c2" pop={sq} />}
            {idx >= 1 && <Sq c="#55603f" pop={idx === 1 ? sq : 1} />}
          </div>
        </div>
      )}
      {CARDS.map((c, i) => {
        const a = frame - c.at;
        if (a < 0 || cardsOut <= 0) return null;
        const pop = interpolate(a, [0, 7], [0, 1], { ...CLAMP, easing: OUT });
        // Green first, crossing through orange, then true colour.
        const g = interpolate(a, [0, 4, 8], [1, 1, 0], CLAMP);
        const o = interpolate(a, [3, 7, 15], [0, 1, 0], CLAMP);
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        const k = collapse * 0.78;
        const s = (0.94 + 0.06 * pop) * (1 - collapse * 0.55) * (1 - (1 - cardsOut) * 0.5);
        const x = cx + (960 - cx) * k - (c.w * s) / 2;
        const y = cy + (540 - cy) * k - (c.h * s) / 2;
        const first = c.hue === 'g' ? GREEN : ORANGE;
        const second = c.hue === 'g' ? ORANGE : GREEN;
        const effects = [
          ...(g > 0.01 ? [gradientMap({ stops: first, amount: g })] : []),
          ...(o > 0.01 ? [gradientMap({ stops: second, amount: o })] : []),
          ...(collapse > 0.01 ? [gradientMap({ stops: PALE, amount: collapse * 0.85 }), blur(collapse * 12)] : []),
        ];
        return (
          <Layer
            key={i}
            id={`card-${i}`}
            x={x}
            y={y}
            scale={s}
            opacity={Math.min(1, a / 2) * cardsOut}
            clip={c.r ? { kind: 'path', d: roundRect(c.w, c.h, c.r) } : undefined}
            effects={effects}
            motionBlur={frame >= COLLAPSE[0] - 2 && frame <= COLLAPSE[1] + 4 ? { samples: 8, shutter: 0.4 } : undefined}
          >
            {c.video
              ? <Video src={c.src} width={c.w} height={c.h} fit="cover" loop muted />
              : <Image src={c.src} width={c.w} height={c.h} fit="cover" />}
          </Layer>
        );
      })}
      {typing && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, height: 80, display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: SANS, fontSize: 64, color: '#F3EFEC', whiteSpace: 'pre' }}>
          <span>{TEXT.slice(0, typedCount)}</span>
          <span style={{ display: 'inline-block', width: 28, height: 50, marginLeft: 3, marginRight: -3, background: '#F3EFEC', opacity: cursorOn ? 1 : 0 }} />
          <span style={{ opacity: 0 }}>{TEXT.slice(typedCount)}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};
