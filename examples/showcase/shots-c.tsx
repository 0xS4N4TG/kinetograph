// Shots 7 to 10: 3D cards and the whip, "No Chrome" over a glow, the speed
// slide, and the outro on a moving mesh gradient.

import React from 'react';
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  Camera,
  Ellipse,
  Layer,
  MeshGradient,
  Rect,
  Text,
  cornerPin,
  dotMatrix,
  dropShadow,
  glow,
  linearGradient,
} from '@kinetograph/core';
import {
  BENCH_LABEL,
  Center,
  CornerDots,
  GREY,
  H,
  INK,
  KINETOGRAPH_SECONDS,
  REMOTION_SECONDS,
  RiseText,
  SANS,
  SPEEDUP,
  T,
  W,
  clamp,
  fr,
  ramp,
  useSpring,
} from './common.js';
import { CARD_H, CARD_W, CardArt, Landscape, roundedPath } from './art.js';
import { WIDTHS as M } from './widths.js';

// ---- shot 7: cards in 3D, angled words, then the whip ----

/** Local frame at which the whip starts, and how long the whole shot lasts. */
export const WHIP_AT = fr(T.whip) - fr(T.s7);
export const S7_LENGTH = fr(T.whip + 0.65) - fr(T.s7);

const Card: React.FC<{ seed: number; id?: string } & Record<string, unknown>> = ({ seed, ...props }) => (
  <Layer {...props}>
    <Layer x={-CARD_W / 2} y={-CARD_H / 2}>
      <Rect
        width={CARD_W}
        height={CARD_H}
        radius={14}
        fill="#f4f4f4"
        effects={[dropShadow({ y: 10, blur: 14, color: '#00000030' })]}
      />
      <Layer clip={{ kind: 'path', d: roundedPath(CARD_W, CARD_H, 14) }}>
        <CardArt seed={seed} />
      </Layer>
    </Layer>
  </Layer>
);

/** A word whose letters rise into place one after another, set at an angle in 3D. */
const AngledWord: React.FC<{ text: string; start: number; size?: number; id?: string } & Record<string, unknown>> = ({
  text,
  start,
  size = 78,
  ...props
}) => <RiseText {...props} text={text} start={start} size={size} weight={600} stagger={1.8} />;

const Cluster: React.FC = () => {
  const frame = useCurrentFrame();
  const s = (i: number) => useSpring(i * 4, { damping: 14 });
  const spin = interpolate(frame, [0, 45], [-38, -12], { easing: Easing.out(Easing.cubic) });
  return (
    <Layer id="cluster" x={W / 2} y={H / 2} rotateY={spin} preserve3d>
      {[0, 1, 2, 3, 4].map((i) => {
        const t = s(i);
        return (
          <Card
            key={i}
            id={`cluster-${i}`}
            seed={i + 3}
            x={(i - 2) * 76 + (1 - t) * 220}
            y={(i % 2 === 0 ? -1 : 1) * 30}
            z={-i * 90}
            rotateY={(i - 2) * 6}
            scale={0.8 + 0.2 * t}
            opacity={t}
          />
        );
      })}
    </Layer>
  );
};

const Arc: React.FC = () => {
  const frame = useCurrentFrame();
  const radius = 1100;
  const turn = interpolate(frame, [0, 40], [24, 4], { easing: Easing.out(Easing.quad) });
  return (
    <Layer id="arc" x={W / 2 - 120} y={H / 2} rotateY={turn} preserve3d>
      {Array.from({ length: 9 }, (_, i) => {
        const angle = (i - 6.5) * 11;
        const rad = (angle * Math.PI) / 180;
        return (
          <Card
            key={i}
            id={`arc-${i}`}
            seed={20 + i}
            x={radius * Math.sin(rad)}
            z={radius * Math.cos(rad) - radius}
            y={(i % 3) * 18 - 18}
            rotateY={angle}
          />
        );
      })}
      <AngledWord id="faster" text="faster" start={4} x={-40} y={-CARD_H / 2 - 100} rotateY={-14} />
      <AngledWord id="sharper" text="sharper" start={10} x={-40} y={CARD_H / 2 + 10} rotateY={-14} rotateX={10} />
    </Layer>
  );
};

const YouRender: React.FC = () => {
  const big = useSpring(0, { damping: 18, mass: 0.8 });
  return (
    <Layer id="you-render">
      <AngledWord id="you" text="you" start={0} x={470} y={H / 2 - 50} />
      <Layer id="row" x={800} y={H / 2} preserve3d>
        {Array.from({ length: 8 }, (_, i) => {
          const s = useSpring(3 + i * 2, { damping: 15 });
          return (
            <Card
              key={i}
              id={`row-${i}`}
              seed={40 + i}
              x={-150 + i * 55}
              y={(i % 2) * 40 - 20}
              z={-500 + i * 30 - (1 - s) * 600}
              rotateY={-18}
              opacity={s}
            />
          );
        })}
      </Layer>
      <Card
        id="hero"
        seed={57}
        x={1170}
        y={H / 2}
        scale={0.4 + 0.6 * big}
        rotateY={(1 - big) * -30}
        opacity={Math.min(1, big * 2)}
      />
      <AngledWord id="render" text="render" start={6} x={1330} y={H / 2 - 50} />
    </Layer>
  );
};

export const Shot7: React.FC = () => {
  const frame = useCurrentFrame();
  const whip = interpolate(frame, [WHIP_AT, WHIP_AT + 16], [0, -2700], {
    easing: Easing.in(Easing.poly(4)),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <Layer id="shot7">
      <Camera perspective={1400} />
      <Layer id="whip" x={whip} motionBlur={frame >= WHIP_AT - 1 ? { samples: 12, shutter: 1 } : undefined}>
        <Layer id="stage-a" opacity={1 - ramp(frame, 34, 42, Easing.in(Easing.quad))}>{frame < 43 ? <Cluster /> : null}</Layer>
        <Layer id="stage-b" opacity={1 - ramp(frame, 60, 68, Easing.in(Easing.quad))}>{frame >= 33 && frame < 69 ? <Arc /> : null}</Layer>
        <Layer id="stage-c">{frame >= 62 ? <YouRender /> : null}</Layer>
      </Layer>
    </Layer>
  );
};

// ---- shot 8: the glow rises under the whip; "No Chrome. No screenshots. Just pixels." ----

/** The glow mesh is 2040 x 800 and sits at (-60, 340): its edge points are fixed, the inner ones drift. */
const glowPoints = (frame: number): [number, number][] => {
  const pts: [number, number][] = [];
  const ys = [0, 380, 800];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const edge = c === 0 || c === 3;
      const x = (c / 3) * (W + 120);
      pts.push([
        x + (edge ? 0 : 80 * Math.sin(frame * 0.045 + c * 1.7 + r)),
        ys[r]! + (r === 2 ? 40 : r === 1 && !edge ? 60 * Math.cos(frame * 0.05 + c * 1.3) : 0),
      ]);
    }
  }
  return pts;
};

export const Shot8: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = ramp(frame, 0, 34, Easing.out(Easing.cubic));
  const a = ramp(frame, 38, 46, Easing.in(Easing.quad)) ; // "No Chrome." leaves
  const b = ramp(frame, 63, 71, Easing.in(Easing.quad)); // "No screenshots." leaves
  return (
    <Layer id="shot8">
      <MeshGradient
        id="glow-mesh"
        x={-60}
        y={340 + (1 - rise) * 420}
        width={W + 120}
        height={800}
        columns={4}
        rows={3}
        points={glowPoints(frame)}
        colors={[
          '#ff9a3c00', '#ff4d8d00', '#c25bff00', '#ff7a5c00',
          '#ffa24ac8', '#ff5a8ac8', '#d46bffc8', '#ff8a50c8',
          '#ff8a2e', '#ff3d6e', '#e25bd8', '#ff6a3a',
        ]}
        opacity={rise}
      />
      <Center y={450} h={260}>
        {frame < 46 ? (
          <RiseText id="no-chrome" text="No Chrome." start={14} size={184} weight={600} out={a} />
        ) : null}
        {frame >= 40 && frame < 74 ? (
          <RiseText id="no-shots" text="No screenshots." start={41} size={184} weight={600} out={b} />
        ) : null}
      </Center>
      {frame >= 66 ? (
        <Center y={450} h={260}>
          <Layer
            id="just-pixels"
            layout={{}}
            effects={[dotMatrix({ progress: ramp(frame, 68, 92, Easing.inOut(Easing.quad)), size: 8, seed: 2, stagger: 0.5 })]}
          >
            <Text font={SANS} weight={600} size={184} color={INK}>
              Just pixels.
            </Text>
          </Layer>
        </Center>
      ) : null}
    </Layer>
  );
};

// ---- shot 9: two bars racing ----

/** The measured times keep their own precision: 9.2 has one decimal, 2.86 two. */
const fmtR = (n: number): string => n.toFixed(1);
const fmtK = (n: number): string => n.toFixed(2);

const BAR_X = 620;
const BAR_W = 920;
const BAR_H = 60;
/** Video seconds the slower bar takes to fill: the race runs at a fixed speed up from the measured times. */
const RACE_SECONDS = 1.9;

export const Shot9: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, 14);
  const t = Math.max(0, (frame - 16) / fps);
  const pr = clamp(t / RACE_SECONDS);
  const pk = clamp(t / (RACE_SECONDS * (KINETOGRAPH_SECONDS / REMOTION_SECONDS)));
  const finish = (16 / fps) + RACE_SECONDS * (KINETOGRAPH_SECONDS / REMOTION_SECONDS);
  const pop = useSpring(Math.round(finish * fps), { damping: 13, stiffness: 140 });
  const count = 1 + (SPEEDUP - 1) * ramp(frame, Math.round(finish * fps), Math.round(finish * fps) + 14, Easing.out(Easing.cubic));
  const row = (y: number) => y + (1 - enter) * 24;
  return (
    <Layer id="shot9" opacity={enter}>
      <Text x={BAR_X} y={row(170)} font={SANS} weight={500} size={30} color={GREY}>
        The same scene, rendered twice
      </Text>

      <Layer id="remotion-row" y={row(0)}>
        <Text x={BAR_X - 320} y={296} font={SANS} weight={500} size={42} color="#6d6d6d">
          Remotion
        </Text>
        <Rect x={BAR_X} y={300} width={BAR_W} height={BAR_H} radius={BAR_H / 2} fill="#d9d9d9" />
        <Rect x={BAR_X} y={300} width={Math.max(0.01, BAR_W * pr)} height={BAR_H} radius={BAR_H / 2} fill="#a7a7a7" />
        <Text x={BAR_X + BAR_W + 36} y={304} font={SANS} weight={500} size={44} color="#6d6d6d">
          {`${fmtR(pr * REMOTION_SECONDS)} s`}
        </Text>
      </Layer>
      <Layer id="kinetograph-row" y={row(0)}>
        <Text x={BAR_X - 320} y={436} font={SANS} weight={600} size={42} color={INK}>
          Kinetograph
        </Text>
        <Rect x={BAR_X} y={440} width={BAR_W} height={BAR_H} radius={BAR_H / 2} fill="#d9d9d9" />
        <Rect
          x={BAR_X}
          y={440}
          width={Math.max(0.01, BAR_W * pk)}
          height={BAR_H}
          radius={BAR_H / 2}
          fill={linearGradient(['#ffb184', '#ff5fa2', '#9d5cff'], { angle: 90 })}
          effects={[glow({ radius: 14, color: '#ff5fa2', intensity: 0.5 })]}
        />
        <Text x={BAR_X + BAR_W + 36} y={444} font={SANS} weight={600} size={44} color={INK}>
          {`${fmtK(pk * KINETOGRAPH_SECONDS)} s`}
        </Text>
      </Layer>

      <Center y={700} h={260} id="speedup" opacity={clamp(pop * 2)}>
        <Layer layout={{}} scale={0.86 + 0.14 * pop} origin="center">
          <Text font={SANS} weight={600} size={250} color={linearGradient(['#ffb184', '#ff5fa2', '#9d5cff'], { angle: 90 })}>
            {`${count.toFixed(1)}×`}
          </Text>
        </Layer>
      </Center>
      <Center y={970} h={40} opacity={clamp(pop * 2)}>
        <Text font={SANS} weight={400} size={26} color={GREY}>
          {BENCH_LABEL}
        </Text>
      </Center>
    </Layer>
  );
};

// ---- shot 10: outro ----

const meshPoints = (frame: number): [number, number][] => {
  const pts: [number, number][] = [];
  const ys = [-20, 560, 1100];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const x = (c / 3) * (W + 80) - 40;
      pts.push([
        x + (c > 0 && c < 3 ? 90 * Math.sin(frame * 0.035 + c * 1.9 + r * 0.7) : 0),
        ys[r]! + (r === 1 ? 120 * Math.cos(frame * 0.03 + c * 1.4) : r === 2 ? -60 * Math.sin(frame * 0.04 + c) : 0),
      ]);
    }
  }
  return pts;
};

export const Shot10: React.FC = () => {
  const frame = useCurrentFrame();
  const dots = useSpring(8, { damping: 16 });
  const subtitle = ramp(frame, 26, 46);
  const cardT = useSpring(52, { damping: 16, stiffness: 90 });
  const flat = 1 - cardT;
  // The card's four corners, in its own 768 x 432 box: a mild perspective, as a flat screen seen at an angle.
  const pin = {
    topLeft: [34 * cardT, 16 * cardT] as [number, number],
    topRight: [768, 0] as [number, number],
    bottomRight: [768 - 22 * cardT, 432 - 14 * cardT] as [number, number],
    bottomLeft: [0, 432 - 30 * cardT] as [number, number],
  };
  const cardX = W / 2 - 384;
  const cardY = 560 + flat * 520;
  const dotPoints = [pin.topLeft, pin.topRight, pin.bottomRight, pin.bottomLeft];
  return (
    <Layer id="shot10">
      <MeshGradient
        id="outro-mesh"
        width={W}
        height={H}
        columns={4}
        rows={3}
        points={meshPoints(frame)}
        colors={[
          '#e8e8e8', '#ebe9f2', '#eee8f1', '#e8e8e8',
          '#ffe2cf', '#ffbdd0', '#ecb4f4', '#ffd0b4',
          '#ff9a3c', '#ff3d6e', '#d65cf0', '#ff6a3a',
        ]}
      />
      <CornerDots cx={W / 2} cy={250} w={M.title + 150} h={250} t={dots} />
      <Center y={250} h={220}>
        <RiseText id="outro-title" text="Kinetograph" start={4} size={168} weight={600} stagger={1.4} />
      </Center>
      <Center y={400} h={70} opacity={subtitle}>
        <Text font={SANS} weight={400} size={46} color="#222222" y={(1 - subtitle) * 14}>
          Motion graphics at the speed of your GPU
        </Text>
      </Center>
      {cardT > 0.001 ? (
        <>
          <Layer
            id="pinned-card"
            x={cardX}
            y={cardY}
            opacity={clamp(cardT * 1.6)}
            layout={{ width: 768, height: 432 }}
            effects={[cornerPin(pin), dropShadow({ y: 24, blur: 28, color: '#3a0a2a40' })]}
          >
            <Layer scale={0.4}>
              <Landscape />
            </Layer>
          </Layer>
          {dotPoints.map(([px, py], i) => (
            <Ellipse key={i} x={cardX + px - 6} y={cardY + py - 6} width={12} height={12} fill={INK} opacity={clamp(cardT * 1.6)} />
          ))}
        </>
      ) : null}
    </Layer>
  );
};
