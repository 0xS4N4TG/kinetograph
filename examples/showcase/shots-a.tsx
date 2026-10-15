// Shots 1 to 3: the gradient-mapped figure and its words, which drain away
// in a pixel melt onto the bracket titles ("{ rendered without a browser }",
// then "{ Kine[pictures]tograph }"), and the code card over a false-colour scene.

import React from 'react';
import { Easing, interpolate, random, spring, useCurrentFrame } from 'remotion';
import { Ellipse, Layer, Path, Rect, Text, backdropBlur, blur, dropShadow, glow, gradientMap, grain, linearGradient } from '@kinetograph/core';
import { FPS, H, INK, MONO, SANS, W, blink, clamp, ramp, useSpring } from './common.js';
import { CARD_W, CardArt, Landscape, PROFILE_PATH, roundedPath } from './art.js';
import { WIDTHS as M } from './widths.js';

// ---- shot 1: a gradient-mapped figure cut into sliding bands, words on the voiceover ----

/** Frames (of shot 1) where the pixel melt starts, and how long it takes to drain the picture. */
export const MELT_AT = 57;
const MELT_FRAMES = 34;

// The reference's figure barely moves; its colours do. The gradient map runs
// through these palettes (shadow, body, upper body, head light), and the sky
// goes flat mauve at 1.2 s and then turns over, violet above peach.
const PALETTES: [number, string[]][] = [
  [0, ['#9c8cf2', '#f6d9a6', '#f7b9a0', '#ee6aa8']],
  [10, ['#9c8cf2', '#ef8fb0', '#f5b08a', '#fbe08a']],
  [20, ['#8a84f4', '#c070e0', '#e070c0', '#f070a8']],
  [30, ['#8a84f4', '#c068d8', '#d070d0', '#c27ef0']],
  [40, ['#9c8cf2', '#f2c4a8', '#ec90b4', '#d85cb0']],
  [50, ['#9c8cf2', '#ee98b0', '#f6b494', '#fde08c']],
  [70, ['#9c8cf2', '#e884b4', '#f4a890', '#fbd58c']],
];
const SKIES: [number, string[]][] = [
  [0, ['#f8c898', '#d9b0c6', '#9c8cf2']],
  [24, ['#f4c29a', '#d4aec8', '#a492ee']],
  [29, ['#c8a2c4', '#c8a0c4', '#c6a0c6']],
  [33, ['#c8a2c4', '#c8a0c4', '#c6a0c6']],
  [38, ['#a890ec', '#c8a2c8', '#f0b098']],
  [70, ['#a48cee', '#d0a0b8', '#ee9c80']],
];

/** The colours of `keys` at `frame`: each colour eased from one key to the next. */
function keyed(frame: number, keys: [number, string[]][]): string[] {
  let i = 0;
  while (i < keys.length - 1 && frame >= keys[i + 1]![0]) i++;
  const [f0, c0] = keys[i]!;
  const next = keys[i + 1];
  if (!next) return c0;
  const t = Easing.inOut(Easing.quad)(clamp((frame - f0) / (next[0] - f0)));
  return c0.map((c, j) => mix(c, next[1][j]!, t));
}

function figureMap(frame: number) {
  const [shadow, body, upper, head] = keyed(frame, PALETTES);
  return [
    { offset: 0.0, color: shadow! },
    { offset: 0.55, color: body! },
    { offset: 0.75, color: upper! },
    { offset: 1.0, color: head! },
  ];
}

/** The picture: a warm-to-violet sky and a blurred grey profile whose greys are mapped to colours. */
const Figure: React.FC<{ frame: number }> = ({ frame }) => {
  const push = interpolate(frame, [0, 92], [1, 1.09]);
  const drift = interpolate(frame, [0, 92], [0, 46]);
  return (
    <>
      <Rect width={W} height={H} fill={linearGradient(keyed(frame, SKIES), { angle: 180 })} />
      <Layer x={W / 2} y={H / 2 + drift} scale={push} origin="center" effects={[gradientMap({ stops: figureMap(frame) })]}>
        <Layer x={-W / 2} y={-H / 2} effects={[blur(12)]}>
          <Path d={PROFILE_PATH} fill={linearGradient(['#d0d0d0', '#a4a4a4', '#9c9c9c'], { angle: 180 })} />
        </Layer>
        <Layer x={-W / 2} y={-H / 2} effects={[blur(72)]}>
          <Rect x={850} y={200} width={270} height={170} radius={85} fill="#ffffff" opacity={0.75} />
          <Rect x={1080} y={930} width={200} height={150} radius={75} fill="#f4f4f4" opacity={0.6} />
        </Layer>
      </Layer>
    </>
  );
};

/** Band edges (y) and, per band, how far the picture in it is shifted: the image breaks into slices at 0.9 s. */
const BANDS = [0, 118, 262, 492, 660, 842, 1080];
function bandShift(i: number, frame: number): number {
  // Two hard steps, each eased over four frames, then a drift.
  const a = ramp(frame, 22, 26, Easing.out(Easing.cubic));
  const b = ramp(frame, 40, 44, Easing.out(Easing.cubic));
  const s1 = (random(`band-a-${i}`) - 0.5) * 120;
  const s2 = (random(`band-b-${i}`) - 0.5) * 160;
  return s1 * a + (s2 - s1) * b * 0.8 + Math.sin(frame * 0.07 + i) * 6 * a;
}

const Bands: React.FC<{ frame: number }> = ({ frame }) => (
  <Layer id="figure" effects={[grain(0.04, { seed: 3 })]}>
    {BANDS.slice(0, -1).map((top, i) => {
      const bottom = BANDS[i + 1]!;
      return (
        <Layer key={top} id={`band-${i}`} clip={{ kind: 'polygon', points: [[0, top], [W, top], [W, bottom], [0, bottom]] }}>
          <Layer y={bandShift(i, frame)}>
            <Figure frame={frame} />
          </Layer>
        </Layer>
      );
    })}
  </Layer>
);

/** The thin rules on the band edges: they draw in from the left when the image breaks. */
const Rules: React.FC<{ frame: number }> = ({ frame }) => (
  <>
    {BANDS.slice(1, -1).map((y, i) => {
      const t = ramp(frame, 20 + i * 2, 30 + i * 2, Easing.out(Easing.poly(4)));
      return <Rect key={y} id={`rule-${i}`} x={0} y={y} width={W * t} height={1.5} fill="#ffffff" opacity={0.42} />;
    })}
  </>
);

const LINE = 'Imagine every motion graphic you need';
/** The frame each word starts, from the voiceover (line 01 starts at 0.15 s). */
const WORD_AT = [4, 14, 24, 31, 42, 47];
const WORD_HUES = ['#ff7a3d', '#ff3f8e', '#c25cff', '#ff7a3d', '#ff3f8e', '#c25cff'];

function mix(a: string, b: string, t: number): string {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * clamp(t)));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The line, a word at a time: each word's letters fade in on its colour, then the word turns white. */
const Words: React.FC<{ frame: number }> = ({ frame }) => {
  const wordOf: number[] = [];
  let w = 0;
  for (const c of LINE) {
    wordOf.push(w);
    if (c === ' ') w++;
  }
  const starts: number[] = [];
  wordOf.forEach((wi, i) => starts.push(i > 0 && wordOf[i - 1] === wi ? starts[i - 1]! + 1 : 0));
  return (
    <Layer layout={{ width: W, height: 120, justifyContent: 'center', alignItems: 'center' }} y={H / 2 - 60}>
      <Text
        font={SANS}
        weight={400}
        size={62}
        color="#ffffff"
        chars={(_c, i) => {
          const wi = wordOf[i]!;
          const at = WORD_AT[wi]! + starts[i]! * 0.7;
          const t = ramp(frame, at, at + 4, Easing.linear);
          const white = ramp(frame, WORD_AT[wi]! + 10, WORD_AT[wi]! + 14, Easing.inOut(Easing.quad));
          return { opacity: t, y: (1 - t) * 10, color: mix(WORD_HUES[wi]!, '#ffffff', white) };
        }}
      >
        {LINE}
      </Text>
    </Layer>
  );
};

// The melt: the picture's top edge falls in columns of 40 px, in steps of 24 px,
// leading on the left, with a rim of bright cells; the grey backdrop is left.
const COLS = 48;
const CELL_W = W / COLS;
const CELL_H = 24;
const RIM = ['#fff38a', '#f7a6f0', '#d56cf2', '#f2b07c', '#f8c9cf', '#ffe066'];

function meltTops(frame: number): number[] | null {
  const t = (frame - MELT_AT) / MELT_FRAMES;
  if (t <= 0) return null;
  const base = -420 + (H + 600) * Math.pow(clamp(t), 1.35);
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
      const rows = clamp(Math.round((below - y) / CELL_H), 1, 3);
      return Array.from({ length: rows }, (_, j) => {
        const row = Math.round(y / CELL_H) + j;
        if (random(`rim-${c}-${row}`) > 0.72) return null;
        const color = RIM[Math.floor(random(`rim-c-${c}-${row}`) * RIM.length)]!;
        return <Rect key={`${c}-${j}`} x={c * CELL_W} y={y + j * CELL_H} width={CELL_W} height={CELL_H} fill={color} />;
      });
    })}
  </>
);

export const Shot1: React.FC = () => {
  const frame = useCurrentFrame();
  const tops = meltTops(frame);
  return (
    <Layer id="shot1">
      <Layer id="picture" clip={tops ? meltClip(tops) : undefined}>
        <Bands frame={frame} />
        <Rules frame={frame} />
        <Words frame={frame} />
      </Layer>
      {tops ? <MeltRim tops={tops} /> : null}
    </Layer>
  );
};

// ---- shot 2: bracket titles on grey, words added on the voiceover, squares that jump ----

const S2_SIZE = 84;
const S2_LINE = S2_SIZE * 1.2;
const BRACE_GAP = 30;
const MAROON = '#9b1d4a';

/** Phrase A: each word and the frame (of shot 2) it lands, from the voiceover. */
const PHRASE_A: [string, number][] = [
  ['rendered', 4],
  ['without', 17],
  ['a', 24],
  ['browser', 33],
];
/** Frame (of shot 2) where phrase A is cut to "{ Kine tograph }" (line 02, "This is"). */
const CUT = 52;
/** Where the gap in "Kinetograph" opens, on the word itself. */
const OPEN = 67;
const THUMB_W = 50;
const THUMB_H = 58;
const THUMB_GAP = 8;
const THUMBS = 3;
const GAP_W = THUMBS * THUMB_W + (THUMBS + 1) * THUMB_GAP;

/** A word that lands in maroon, rises a little and turns to ink. */
const Landing: React.FC<{ text: string; at: number; x: number; y: number; frame: number; inkAt?: number }> = ({
  text,
  at,
  x,
  y,
  frame,
  inkAt = at + 8,
}) => {
  const t = ramp(frame, at, at + 4, Easing.out(Easing.cubic));
  const ink = ramp(frame, inkAt, inkAt + 8, Easing.inOut(Easing.quad));
  return (
    <Text x={x} y={y + (1 - t) * 16} font={SANS} weight={500} size={S2_SIZE} lineHeight={1.2} color={mix(MAROON, INK, ink)} opacity={t}>
      {text}
    </Text>
  );
};

const Braces: React.FC<{ left: number; slot: number; y: number }> = ({ left, slot, y }) => (
  <>
    <Text id="lbrace" x={left} y={y} font={SANS} weight={400} size={S2_SIZE} lineHeight={1.2} color={INK}>
      {'{'}
    </Text>
    <Text id="rbrace" x={left + M.brace + BRACE_GAP * 2 + slot} y={y} font={SANS} weight={400} size={S2_SIZE} lineHeight={1.2} color={INK}>
      {'}'}
    </Text>
  </>
);

/**
 * Four squares that jump between places near the corners of a `w` x `h` box (a
 * new place every three frames, some hidden), then sit on the corners from
 * frame `settle`.
 */
const JumpDots: React.FC<{ frame: number; from: number; settle: number; w: number; h: number; seed: string }> = ({
  frame,
  from,
  settle,
  w,
  h,
  seed,
}) => {
  if (frame < from) return null;
  const step = Math.floor((frame - from) / 3);
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  return (
    <>
      {corners.map(([sx, sy], i) => {
        let x = W / 2 + (sx * w) / 2;
        let y = H / 2 + (sy * h) / 2;
        if (frame < settle) {
          if (random(`${seed}-v-${i}-${step}`) < 0.35) return null;
          x += Math.round((random(`${seed}-x-${i}-${step}`) - 0.5) * 6) * 40;
          y += Math.round((random(`${seed}-y-${i}-${step}`) - 0.5) * 4) * 40;
        }
        return <Rect key={i} x={x - 9} y={y - 9} width={18} height={18} fill={INK} />;
      })}
    </>
  );
};

/** One small picture in the gap of "Kinetograph": a different one every two frames until it settles. */
const Thumb: React.FC<{ i: number; frame: number; x: number; y: number }> = ({ i, frame, x, y }) => {
  const seed = frame < OPEN + 16 ? 40 + i * 13 + Math.floor(frame / 2) : 7 + i * 5;
  const s = THUMB_W / CARD_W;
  return (
    <Layer x={x} y={y} clip={{ kind: 'path', d: roundedPath(THUMB_W, THUMB_H, 7) }}>
      <Layer scale={s} y={-THUMB_W * 0.2}>
        <CardArt seed={seed} />
      </Layer>
    </Layer>
  );
};

export const Shot2: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = (delay: number, config: { damping: number; stiffness: number }) => spring({ frame: frame - delay, fps: FPS, config });
  const y = H / 2 - S2_LINE / 2;
  if (frame < CUT) {
    // Each word's slot opens two frames before it lands, so the brace moves first.
    const widths = PHRASE_A.map(([word, at], i) => sp(at - 2, { damping: 20, stiffness: 220 }) * (M[word as keyof typeof M] + (i > 0 ? M.space : 0)));
    const slot = widths.reduce((a, b) => a + b, 0);
    const left = (W - (M.brace * 2 + BRACE_GAP * 2 + slot)) / 2;
    let x = left + M.brace + BRACE_GAP;
    return (
      <Layer id="shot2a">
        <JumpDots frame={frame} from={6} settle={40} w={M.brace * 2 + BRACE_GAP * 2 + slot + 320} h={330} seed="a" />
        <Braces left={left} slot={slot} y={y} />
        {PHRASE_A.map(([word, at], i) => {
          const wx = x + (i > 0 ? M.space : 0);
          x += widths[i]!;
          return frame >= at ? <Landing key={word} text={word} at={at} x={wx} y={y} frame={frame} /> : null;
        })}
      </Layer>
    );
  }
  const open = sp(OPEN, { damping: 16, stiffness: 170 });
  const gap = open * GAP_W;
  const slot = M.kine + gap + M.tograph;
  const left = (W - (M.brace * 2 + BRACE_GAP * 2 + slot)) / 2;
  const x0 = left + M.brace + BRACE_GAP;
  const arrows = ramp(frame, OPEN - 4, OPEN + 10, Easing.out(Easing.cubic));
  const arrowsOut = ramp(frame, OPEN + 14, OPEN + 22, Easing.in(Easing.quad));
  const inkAt = OPEN + 12;
  return (
    <Layer id="shot2b">
      <JumpDots frame={frame} from={CUT} settle={OPEN + 10} w={slot + 330} h={290} seed="b" />
      <Braces left={left} slot={slot} y={y} />
      <Landing text="Kine" at={CUT - 4} x={x0} y={y} frame={frame} inkAt={inkAt} />
      <Landing text="tograph" at={CUT - 4} x={x0 + M.kine + gap} y={y} frame={frame} inkAt={inkAt} />
      {Array.from({ length: THUMBS }, (_, i) => {
        const tx = x0 + M.kine + THUMB_GAP + i * (THUMB_W + THUMB_GAP);
        // A picture shows once the gap has opened past it.
        return gap > (i + 1) * (THUMB_W + THUMB_GAP) ? <Thumb key={i} i={i} frame={frame} x={tx} y={H / 2 - THUMB_H / 2 + 4} /> : null;
      })}
      <Text x={left - 250 + arrows * 120} y={y} font={SANS} weight={400} size={S2_SIZE} lineHeight={1.2} color="#b9b9b9" opacity={arrows * (1 - arrowsOut)}>
        ←
      </Text>
      <Text
        x={left + M.brace * 2 + BRACE_GAP * 2 + slot + 160 - arrows * 120}
        y={y}
        font={SANS}
        weight={400}
        size={S2_SIZE}
        lineHeight={1.2}
        color="#b9b9b9"
        opacity={arrows * (1 - arrowsOut)}
      >
        →
      </Text>
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

