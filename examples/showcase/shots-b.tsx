// Shots 4 to 6: halftone clouds with a frosted band and typed command, the
// "Rendering frame" step list, and three portraits treated three ways.

import React from 'react';
import { Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';
import {
  Ellipse,
  Layer,
  Noise,
  Path,
  Rect,
  Text,
  backdropBlur,
  blur,
  brightness,
  chromaticAberration,
  contrast,
  dither,
  dotMatrix,
  dropShadow,
  glow,
  gradientMap,
  halftone,
  linearGradient,
  lut,
} from '@kinetograph/core';
import { Center, H, INK, GREY, SANS, SERIF, W, blink, clamp, ramp, useSpring } from './common.js';
import { CARET_X } from './widths.js';
import { PORTRAITS, PORTRAIT_H, PORTRAIT_W, Portrait, roundedPath } from './art.js';

// ---- shot 4: halftone clouds, a prompt bar that becomes a frosted band ----

const CLOUD = { type: 'fractalNoise', baseFrequency: 0.0034, numOctaves: 5, seed: 12 } as const;

const Clouds: React.FC<{ dots: number }> = ({ dots }) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 150], [0, -90]);
  const place = { x: -150 + drift, y: -110 };
  return (
    <Layer id="clouds">
      <Rect width={W} height={H} fill={linearGradient(['#27b4f0', '#5cccf7'], { angle: 180 })} />
      <Noise
        id="cloud-soft"
        {...place}
        width={2300}
        height={1300}
        turbulence={CLOUD}
        channels="gray"
        opacity={0.95}
        effects={[
          brightness(0.66),
          contrast(1.9),
          gradientMap({
            stops: [
              { offset: 0.0, color: '#1fa6ea' },
              { offset: 0.5, color: '#56c8f6' },
              { offset: 0.78, color: '#c9f0fd' },
              { offset: 1.0, color: '#ffffff' },
            ],
          }),
        ]}
      />
      <Noise
        id="cloud-dots"
        {...place}
        width={2300}
        height={1300}
        turbulence={CLOUD}
        channels="gray"
        opacity={0.55}
        effects={[brightness(0.66), contrast(2.4), halftone({ size: dots, angle: 45, color: '#ffffff' })]}
      />
    </Layer>
  );
};

const CMD1 = 'kinetograph render';
const CMD2 = 'blur, blends, grain, light';

export const Shot4: React.FC = () => {
  const frame = useCurrentFrame();
  const dots = interpolate(frame, [0, 40], [30, 7], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const barIn = useSpring(6, { damping: 18 });
  const serifIn = ramp(frame, 0, 26);
  const e = ramp(frame, 50, 78, Easing.inOut(Easing.cubic));
  const out = ramp(frame, 140, 150, Easing.in(Easing.quad));

  // What is typed: CMD1 up to frame 48, then it is deleted and CMD2 takes its place.
  const n1 = clamp(Math.floor((frame - 12) * 0.5), 0, CMD1.length);
  const del = clamp(Math.floor((frame - 92) * 1.6), 0, CMD1.length);
  const n2 = clamp(Math.floor((frame - 108) * 0.78), 0, CMD2.length);
  const second = frame >= 104;
  const text = second ? CMD2 : CMD1;
  const shown = second ? n2 : frame >= 92 ? CMD1.length - del : n1;
  const caretTable = second ? CARET_X.looks : CARET_X.render;

  // The bar: 760 x 64 pill at the middle of the cloud, then a 250 px band across the whole frame.
  const barW = interpolate(e, [0, 1], [760, W + 80]);
  const barH = interpolate(e, [0, 1], [64, 250]);
  const cy = interpolate(e, [0, 1], [560, 540]);
  const size = interpolate(e, [0, 1], [22, 112]);
  const left = interpolate(e, [0, 1], [W / 2 - 380 + 34, 150]);
  const lineH = size * 1.2;
  const caretX = left + ((caretTable[shown] ?? 0) * size) / 100 + 4;
  const typing = shown < text.length || (second ? frame < 142 : frame < 56);
  const aberration = second && frame < 146 ? 2.5 + 2 * Math.sin(frame * 0.7) : 0;

  return (
    <Layer id="shot4" opacity={1 - out}>
      <Clouds dots={dots} />
      <Center y={H / 2 - 20} h={500} opacity={serifIn * (1 - e * 0.55)}>
        <Text
          font={SERIF}
          size={410}
          color={linearGradient(['#ffffff', '#e4f7ff'], { angle: 180 })}
          opacity={0.78}
          effects={[dropShadow({ y: 6, blur: 10, color: '#0a6cb033' })]}
          y={(1 - serifIn) * 50}
        >
          Kinetograph
        </Text>
      </Center>
      <Layer id="bar" opacity={barIn} y={(1 - barIn) * 24}>
        <Rect
          id="frost"
          x={W / 2 - barW / 2}
          y={cy - barH / 2}
          width={barW}
          height={barH}
          radius={interpolate(e, [0, 1], [32, 0])}
          fill="#ffffff3d"
          effects={[backdropBlur(interpolate(e, [0, 1], [14, 30])), dropShadow({ y: 10, blur: 16, color: '#0b4a7a22' })]}
        />
        <Rect x={W / 2 - barW / 2} y={cy - barH / 2} width={barW} height={1.5} fill="#ffffff" opacity={0.85 * e} />
        <Rect x={W / 2 - barW / 2} y={cy + barH / 2 - 1.5} width={barW} height={1.5} fill="#ffffff" opacity={0.85 * e} />
        <Layer
          id="typed"
          effects={aberration > 0 ? [chromaticAberration({ amount: aberration })] : []}
        >
          <Text
            x={left}
            y={cy - lineH / 2}
            font={SANS}
            weight={500}
            size={size}
            lineHeight={1.2}
            color={e > 0.5 ? INK : '#0b2a44'}
            chars={(_c, i) => (i < shown ? null : { opacity: 0 })}
          >
            {text}
          </Text>
          <Rect
            id="caret"
            x={caretX}
            y={cy - size * 0.55}
            width={Math.max(2, size * 0.035)}
            height={size * 1.1}
            fill={INK}
            opacity={typing ? 1 : blink(frame, 16)}
          />
        </Layer>
        <Layer id="send" opacity={1 - e}>
          <Ellipse x={W / 2 + 380 - 52} y={cy - 18} width={36} height={36} fill="#ffffffaa" />
          <Path d={`M ${W / 2 + 380 - 34} ${cy + 7} L ${W / 2 + 380 - 34} ${cy - 8} M ${W / 2 + 380 - 40} ${cy - 3} L ${W / 2 + 380 - 34} ${cy - 9} L ${W / 2 + 380 - 28} ${cy - 3}`} stroke={{ color: '#0b2a44', width: 2.5 }} />
        </Layer>
      </Layer>
    </Layer>
  );
};

// ---- shot 5: "Rendering frame", a step list that fills in ----

const BX = 700;
const STEP_Y0 = 430;
const STEP_DY = 112;

const STEPS = [
  { label: 'Layout', sub: 'flexbox and per-glyph text boxes' },
  { label: 'Shaping', sub: 'every glyph placed by the text engine' },
  { label: 'Compositing', sub: 'blur, blends, grain and light on the GPU' },
  { label: 'Encoding', sub: 'H.264, hardware where it can' },
];

const Icon: React.FC<{ kind: number }> = ({ kind }) => {
  if (kind === 0) {
    const g = linearGradient(['#b28dff', '#6f7bff'], { angle: 135 });
    return (
      <>
        <Rect width={26} height={26} radius={6} fill={g} />
        <Rect x={30} width={16} height={16} radius={5} fill={g} opacity={0.75} />
        <Rect x={30} y={20} width={16} height={26} radius={6} fill={g} opacity={0.9} />
        <Rect y={30} width={26} height={16} radius={5} fill={g} opacity={0.6} />
      </>
    );
  }
  if (kind === 1) {
    return (
      <>
        <Path d="M 3 40 C 3 2 43 2 43 40" stroke={{ color: '#3b8cff', width: 3.5 }} />
        <Path d="M 3 40 L 14 14 M 43 40 L 32 14" stroke={{ color: '#9cc4ff', width: 2 }} />
        <Ellipse x={-2} y={35} width={10} height={10} fill="#3b8cff" />
        <Ellipse x={38} y={35} width={10} height={10} fill="#3b8cff" />
        <Ellipse x={9} y={9} width={9} height={9} fill="#ffffff" stroke={{ color: '#3b8cff', width: 2 }} />
        <Ellipse x={28} y={9} width={9} height={9} fill="#ffffff" stroke={{ color: '#3b8cff', width: 2 }} />
      </>
    );
  }
  if (kind === 2) {
    return (
      <>
        <Ellipse x={0} y={0} width={28} height={28} fill="#ff6b8a" opacity={0.85} blendMode="multiply" />
        <Ellipse x={18} y={0} width={28} height={28} fill="#ffd34d" opacity={0.85} blendMode="multiply" />
        <Ellipse x={9} y={16} width={28} height={28} fill="#4cc9f0" opacity={0.85} blendMode="multiply" />
      </>
    );
  }
  return (
    <>
      <Rect y={4} width={46} height={36} radius={9} stroke={{ color: '#ff8a3d', width: 3.5 }} />
      <Path d="M 19 14 L 19 30 L 33 22 Z" fill="#ff8a3d" />
    </>
  );
};

const Step: React.FC<{ i: number; start: number }> = ({ i, start }) => {
  const frame = useCurrentFrame();
  const s = useSpring(start, { damping: 18 });
  const t = ramp(frame, start, start + 14, Easing.out(Easing.cubic));
  const y = STEP_Y0 + i * STEP_DY;
  return (
    <Layer id={`step-${i}`} x={BX} y={y + (1 - s) * 30} opacity={t} effects={t < 1 ? [blur((1 - t) * 10)] : []}>
      <Layer x={0} y={6}>
        <Icon kind={i} />
      </Layer>
      <Text x={86} y={-4} font={SANS} weight={500} size={38} color={INK}>
        {STEPS[i]!.label}
      </Text>
      <Text x={86} y={46} font={SANS} weight={400} size={26} color={GREY}>
        {STEPS[i]!.sub}
      </Text>
    </Layer>
  );
};

export const Shot5: React.FC = () => {
  const frame = useCurrentFrame();
  const title = ramp(frame, 2, 18);
  const wash = ramp(frame, 6, 40, Easing.inOut(Easing.quad));
  const lineH = ramp(frame, 18, 84, Easing.inOut(Easing.cubic)) * (STEP_DY * 3 + 110);
  const done = frame >= 84;
  const starts = [20, 36, 52, 68];
  return (
    <Layer id="shot5">
      <Layer id="title" x={BX} y={250} opacity={title} effects={title < 1 ? [blur((1 - title) * 12)] : []}>
        <Layer layout={{ flexDirection: 'row', gap: 18 }}>
          <Text font={SANS} weight={600} size={64} color={linearGradient(['#9ad8d0', '#a58cff', '#ff8fb8'], { angle: 90 })}>
            Rendering
          </Text>
          <Text font={SANS} weight={600} size={64} color={INK}>
            frame
          </Text>
        </Layer>
      </Layer>
      <Rect x={BX - 36} y={STEP_Y0 + 4} width={2} height={lineH} fill="#c9c9c9" />
      <Ellipse x={BX - 42} y={STEP_Y0 + lineH - 6} width={14} height={14} fill="#a58cff" opacity={wash * (done ? 0 : 1)} effects={[glow({ radius: 8, color: '#a58cff', intensity: 0.8 })]} />
      {starts.map((s, i) => (
        <Step key={i} i={i} start={s} />
      ))}
      <Text x={BX - 36} y={STEP_Y0 + STEP_DY * 3 + 130} font={SANS} weight={500} size={26} color={done ? INK : GREY}>
        {done ? 'Done' : 'Working'}
      </Text>
    </Layer>
  );
};

// ---- shot 6: halftone, dot matrix, and a dithered colour grade ----

const PW = 420;
const PH = Math.round((PW * PORTRAIT_H) / PORTRAIT_W);
const PS = PW / PORTRAIT_W;
const PANELS = [
  { cx: 480, label: 'halftone', palette: 0, start: 4 },
  { cx: 960, label: 'dot matrix', palette: 1, start: 22 },
  { cx: 1440, label: 'dither and lut', palette: 2, start: 42 },
];

const Panel: React.FC<{ index: number }> = ({ index }) => {
  const frame = useCurrentFrame();
  const p = PANELS[index]!;
  const enter = useSpring(p.start, { damping: 18 });
  const local = frame - p.start;
  let effects;
  if (index === 0) {
    const size = interpolate(local, [0, 40], [44, 9], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
    effects = [halftone({ size, angle: 45, color: '#2b1740', invert: true })];
  } else if (index === 1) {
    effects = [
      dotMatrix({
        progress: ramp(local, 4, 40, Easing.inOut(Easing.quad)),
        size: 18,
        seed: 5,
        stagger: 0.45,
      }),
    ];
  } else {
    const amount = ramp(local, 14, 46, Easing.inOut(Easing.quad));
    effects = [
      lut({ src: staticFile('luts/teal-orange.cube'), amount }),
      dither(Math.round(interpolate(local, [0, 46], [2, 14], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })), { size: 2 }),
    ];
  }
  return (
    <Layer id={`panel-${index}`} x={p.cx} y={H / 2 - 20 + (1 - enter) * 50} opacity={clamp(enter * 1.5)} scale={0.94 + 0.06 * enter} origin="center">
      <Layer x={-PW / 2} y={-PH / 2}>
        {index === 0 ? (
          <Rect width={PW} height={PH} radius={22} fill={linearGradient([PORTRAITS[p.palette]!.bg1, PORTRAITS[p.palette]!.bg2], { angle: 160 })} />
        ) : null}
        <Layer id={`panel-art-${index}`} effects={effects} clip={{ kind: 'path', d: roundedPath(PW, PH, 22) }}>
          <Portrait palette={PORTRAITS[p.palette]} scale={PS} />
        </Layer>
      </Layer>
      <Text x={-PW / 2} y={PH / 2 + 34} font={SANS} weight={500} size={28} color={GREY}>
        {p.label}
      </Text>
    </Layer>
  );
};

export const Shot6: React.FC = () => (
  <Layer id="shot6">
    {PANELS.map((_p, i) => (
      <Panel key={i} index={i} />
    ))}
  </Layer>
);
