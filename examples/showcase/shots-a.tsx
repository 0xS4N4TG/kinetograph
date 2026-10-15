// Shots 1 to 3: the blurred figure and its words, the bracket title that turns
// into "Kinetograph", and the code card over a false-colour scene.

import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import {
  Ellipse,
  Layer,
  Path,
  Rect,
  Text,
  backdropBlur,
  blur,
  dropShadow,
  glow,
  gradientMap,
  grain,
  linearGradient,
} from '@kinetograph/core';
import {
  Center,
  CornerDots,
  H,
  INK,
  MONO,
  RiseText,
  SANS,
  W,
  blink,
  clamp,
  ramp,
  useSpring,
} from './common.js';
import { Landscape, PROFILE_PATH } from './art.js';
import { WIDTHS as M } from './widths.js';

// ---- shot 1: a blurred, gradient-mapped figure, thin rules, words ----

const WORDS = ['Imagine', 'every', 'motion', 'graphic'];

const FigureBackdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 90], [0, -34]);
  const zoom = interpolate(frame, [0, 90], [1, 1.06]);
  return (
    <Layer
      id="figure-map"
      effects={[
        gradientMap({
          stops: [
            { offset: 0.0, color: '#8f6cf2' },
            { offset: 0.35, color: '#b98af0' },
            { offset: 0.55, color: '#f28fba' },
            { offset: 0.78, color: '#ffb184' },
            { offset: 1.0, color: '#ffe3a1' },
          ],
        }),
        grain(0.035, { seed: 3 }),
      ]}
    >
      <Rect width={W} height={H} fill={linearGradient(['#9c9c9c', '#6e6e6e', '#464646'], { angle: 180 })} />
      <Layer x={150 + drift * 0.5} y={-20} scale={zoom} origin="center" effects={[blur(24)]}>
        <Path d={PROFILE_PATH} fill={linearGradient(['#ffffff', '#c9c9c9', '#8e8e8e'], { angle: 115 })} />
      </Layer>
      <Ellipse x={1180 + drift} y={120} width={620} height={620} fill="#ffffff22" effects={[blur(60)]} />
    </Layer>
  );
};

const Rules: React.FC = () => {
  const frame = useCurrentFrame();
  const ys = [64, 176, 318, 742, 884, 1004];
  return (
    <>
      {ys.map((y, i) => {
        const t = ramp(frame, 4 + i * 3, 26 + i * 3, Easing.out(Easing.poly(4)));
        return <Rect key={y} id={`rule-${i}`} x={0} y={y} width={W * t} height={1.5} fill="#ffffff" opacity={0.28 + (i % 2) * 0.14} />;
      })}
    </>
  );
};

const GRADIENT_WORD = linearGradient(['#ff9a3d', '#ff4f93', '#9d5cff'], { angle: 90 });

/** One word: blur and rise in with a gradient fill, then settle to white. */
const Word: React.FC<{ text: string; start: number; size: number }> = ({ text, start, size }) => {
  const frame = useCurrentFrame();
  const t = ramp(frame, start, start + 16, Easing.out(Easing.cubic));
  const settle = ramp(frame, start + 14, start + 38, Easing.inOut(Easing.quad));
  const fx = t < 1 ? [blur((1 - t) * 14)] : [];
  return (
    <Layer layout={{}} layoutItem={{ margin: [0, 13, 0, 13] }} y={(1 - t) * 26} opacity={t} effects={fx}>
      <Text font={SANS} weight={500} size={size} color="#ffffff" opacity={settle}>
        {text}
      </Text>
      <Text layoutItem={{ position: 'absolute' }} font={SANS} weight={500} size={size} color={GRADIENT_WORD} opacity={1 - settle}>
        {text}
      </Text>
    </Layer>
  );
};

export const Shot1: React.FC = () => {
  const frame = useCurrentFrame();
  const out = ramp(frame, 72, 86, Easing.in(Easing.quad));
  return (
    <Layer id="shot1" opacity={1 - out} effects={out > 0 ? [blur(out * 20)] : []}>
      <FigureBackdrop />
      <Rules />
      <Center y={H / 2 - 6} h={120}>
        {WORDS.map((w, i) => (
          <Word key={w} text={w} start={10 + i * 8} size={74} />
        ))}
      </Center>
    </Layer>
  );
};

// ---- shot 2: { without a browser } -> { Kinetograph } with a card inside the word ----

const S2_SIZE = 84;
const S2_LINE = S2_SIZE * 1.2;
const BRACE_GAP = 26;
const CARD_PAD = 8;
const CARD_BOX_W = 92;
const CARD_BOX_H = 66;

export const Shot2: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = useSpring(0, { damping: 22, stiffness: 160 });
  const morph = ramp(frame, 34, 58, Easing.inOut(Easing.cubic));
  const cardT = useSpring(52, { damping: 14 });
  const cardSlot = cardT * (CARD_BOX_W + CARD_PAD * 2);
  const wordB = M.kine + M.tograph + cardSlot;
  const slotW = M.without + (wordB - M.without) * morph;
  const total = M.brace * 2 + BRACE_GAP * 2 + slotW;
  const left = (W - total) / 2;
  const y = H / 2 - S2_LINE / 2;
  const yOut = ramp(frame, 32, 42, Easing.in(Easing.quad));
  const dotsW = total + 190;
  const dotsH = 330;
  const dots = useSpring(8, { damping: 16 });
  const bx = left + M.brace + BRACE_GAP + (slotW - wordB) / 2;
  return (
    <Layer id="shot2" opacity={enter}>
      <CornerDots cx={W / 2} cy={H / 2} w={dotsW} h={dotsH} t={dots} />
      <Text id="lbrace" x={left} y={y} font={SANS} weight={400} size={S2_SIZE} lineHeight={1.2} color={INK}>
        {'{'}
      </Text>
      <Text id="rbrace" x={left + M.brace + BRACE_GAP * 2 + slotW} y={y} font={SANS} weight={400} size={S2_SIZE} lineHeight={1.2} color={INK}>
        {'}'}
      </Text>
      {/* the old words leave upward while the new word rises in */}
      {yOut < 1 ? (
        <RiseText
          id="without"
          text="without a browser"
          start={4}
          size={S2_SIZE}
          out={ramp(frame, 31, 41, Easing.linear)}
          x={left + M.brace + BRACE_GAP + (slotW - M.without) / 2}
          y={y}
        />
      ) : null}
      {morph > 0 ? (
        <>
          <RiseText id="kine" text="Kine" start={40} size={S2_SIZE} x={bx} y={y} stagger={2} />
          <RiseText id="tograph" text="tograph" start={44} size={S2_SIZE} x={bx + M.kine + cardSlot} y={y} stagger={2} />
          <Layer
            id="inline-card"
            x={bx + M.kine + CARD_PAD + CARD_BOX_W / 2}
            y={y + S2_LINE / 2}
            scale={cardT}
            rotation={(1 - cardT) * -24}
            opacity={clamp(cardT * 1.5)}
          >
            <Layer x={-CARD_BOX_W / 2} y={-CARD_BOX_H / 2}>
              <Rect
                width={CARD_BOX_W}
                height={CARD_BOX_H}
                radius={12}
                fill={linearGradient(['#ffb184', '#f28fba', '#9d7cf2'], { angle: 135 })}
                effects={[dropShadow({ y: 6, blur: 9, color: '#00000030' })]}
              />
              <Ellipse x={54} y={10} width={26} height={26} fill="#fff6d0" opacity={0.92} />
              <Path d="M 0 66 L 0 48 C 24 36 46 54 92 40 L 92 66 Z" fill="#2a2140" opacity={0.7} />
            </Layer>
          </Layer>
        </>
      ) : null}
    </Layer>
  );
};

// ---- shot 3: code typed over a false-colour scene that dissolves to its true colours ----

const CODE = [
  '<Sequence from={30}>',
  '  <Title text="Hello" />',
  '</Sequence>',
  '',
  'const y = spring({ frame, fps });',
];
const CODE_TEXT = CODE.join('\n');
const CODE_SIZE = 34;
const CODE_CHAR_W = CODE_SIZE * 0.6;
const CODE_LINE_H = CODE_SIZE * 1.55;

const TOKEN = /("[^"]*")|(\d+)|(\bconst\b)|(\bspring\b)|(<\/?)([A-Za-z]+)|([A-Za-z_]+)(?==)|([A-Za-z_]+)|(\s+)|([\s\S])/g;

/** One colour per character of `code`, from a tiny tokeniser. */
function syntaxColors(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(TOKEN)) {
    const text = m[0];
    let color = '#8b93a7';
    if (m[1]) color = '#9ee7a6';
    else if (m[2]) color = '#ffc16d';
    else if (m[3]) color = '#c3a1ff';
    else if (m[4]) color = '#ffd98a';
    else if (m[5] !== undefined && m[6] !== undefined) {
      for (const _c of m[5]) out.push('#8b93a7');
      for (const _c of m[6]) out.push('#ff7ab6');
      continue;
    } else if (m[7]) color = '#8ecbff';
    else if (m[8]) color = '#e8ebf2';
    for (const _c of text) out.push(color);
  }
  return out;
}
const CODE_COLORS = syntaxColors(CODE_TEXT);

const THERMAL = [
  { offset: 0.0, color: '#0a0030' },
  { offset: 0.22, color: '#5c1ea8' },
  { offset: 0.42, color: '#d4146a' },
  { offset: 0.62, color: '#ff6a1a' },
  { offset: 0.82, color: '#ffd23a' },
  { offset: 1.0, color: '#fffbe0' },
];

export const Shot3: React.FC = () => {
  const frame = useCurrentFrame();
  const total = Array.from(CODE_TEXT).length;
  const typed = clamp(Math.floor((frame - 10) * 2.3), 0, total);
  const card = useSpring(0, { damping: 18, stiffness: 120 });
  const heat = 1 - ramp(frame, 8, 54, Easing.inOut(Easing.quad));
  const pan = interpolate(frame, [0, 60], [0, -40]);
  // The caret sits after the last typed character (a monospace font makes that arithmetic).
  const before = Array.from(CODE_TEXT).slice(0, typed);
  const row = before.filter((c) => c === '\n').length;
  const col = before.length - (before.lastIndexOf('\n') + 1);
  const CARD_W = 980;
  const CARD_H = 430;
  const PAD = 56;
  return (
    <Layer id="shot3">
      <Layer id="scene-heat" x={pan} scale={1.04} effects={[gradientMap({ stops: THERMAL, amount: heat }), grain(0.05, { seed: 9 })]}>
        <Landscape />
      </Layer>
      <Layer id="code-card" x={W / 2} y={H / 2 + (1 - card) * 60} scale={0.92 + 0.08 * card} opacity={card} origin="center">
        <Layer x={-CARD_W / 2} y={-CARD_H / 2}>
          <Rect
            width={CARD_W}
            height={CARD_H}
            radius={28}
            fill="#0e1017f2"
            effects={[backdropBlur(22), dropShadow({ y: 24, blur: 30, color: '#00000055' })]}
          />
          <Ellipse x={34} y={30} width={16} height={16} fill="#ff6b6b" />
          <Ellipse x={62} y={30} width={16} height={16} fill="#ffd166" />
          <Ellipse x={90} y={30} width={16} height={16} fill="#5ee08a" />
          <Text x={CARD_W / 2 - 60} y={22} font={MONO} weight={400} size={22} color="#6b7285">
            title.tsx
          </Text>
          <Text
            x={PAD}
            y={96}
            font={MONO}
            weight={400}
            size={CODE_SIZE}
            lineHeight={1.55}
            color="#e8ebf2"
            chars={(_c, i) => ({ color: CODE_COLORS[i] ?? '#e8ebf2', opacity: i < typed ? 1 : 0 })}
          >
            {CODE_TEXT}
          </Text>
          <Rect
            id="caret"
            x={PAD + col * CODE_CHAR_W + 1}
            y={96 + row * CODE_LINE_H + 6}
            width={3}
            height={CODE_SIZE * 1.15}
            fill="#ffffff"
            opacity={typed < total ? 1 : blink(frame, 16)}
            effects={[glow({ radius: 8, color: '#ffffff', intensity: 0.5 })]}
          />
        </Layer>
      </Layer>
    </Layer>
  );
};

