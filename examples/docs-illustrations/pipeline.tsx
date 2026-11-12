// The pipeline: a project goes through Node, becomes scene JSON, is drawn by the Rust GPU compositor and encoded.
// Two frames are always in flight, 90 frames apart, so the loop is clean: every frame is a function of the
// frame number alone.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Layer, Path, Rect } from '@kinetographdev/core';
import { Arrow, Box, C, DURATION, NoSign, Picture, T, clamp01, smooth } from './kit';

const BOX_W = 164;
const BOX_Y = 290;
const BOX_H = 140;
const X = [60, 264, 468, 672, 876, 1080];
const WIDTHS = [BOX_W, BOX_W, BOX_W, BOX_W, BOX_W, 140];
const CENTRE = X.map((x, i) => x + WIDTHS[i] / 2);
const TRACK_Y = 215;

const STATIONS: { title: string[]; sub: string; mono?: boolean }[] = [
  { title: ['Your', 'project'], sub: 'TSX or HTML' },
  { title: ['Node', 'runs it'], sub: 'every frame' },
  { title: ['Scene', 'JSON'], sub: 'layers, islands' },
  { title: ['Rust GPU', 'compositor'], sub: 'N-API addon' },
  { title: ['FFmpeg', 'encode'], sub: 'H.264' },
  { title: ['Video'], sub: 'Main.mp4', mono: true },
];

const hold = (k: number): [number, number] => [k / 6 + 0.005, k / 6 + 0.095];

/** Where a frame token is, 0..1 along the whole trip: it rests at each station, then glides to the next. */
function tokenX(p: number): number {
  for (let k = 0; k < 6; k++) {
    const [a, b] = hold(k);
    if (p < a) {
      if (k === 0) return CENTRE[0];
      const from = hold(k - 1)[1];
      return CENTRE[k - 1] + (CENTRE[k] - CENTRE[k - 1]) * smooth((p - from) / (a - from));
    }
    if (p <= b) return CENTRE[k];
  }
  return CENTRE[5];
}

/** Which station a token's contents belong to, as a number: 2.4 is 40% of the way from station 2 to 3. */
function stagePos(p: number): number {
  for (let k = 0; k < 6; k++) {
    const [a, b] = hold(k);
    if (p < a) {
      if (k === 0) return 0;
      const from = hold(k - 1)[1];
      return k - 1 + smooth((p - from) / (a - from));
    }
    if (p <= b) return k;
  }
  return 5;
}

/** How much a token is resting at station k. */
function presence(p: number, k: number): number {
  const [a, b] = hold(k);
  return interpolate(p, [a - 0.03, a + 0.01, b - 0.01, b + 0.03], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
}

const Token = ({ p, n }: { p: number; n: number }) => {
  const x = tokenX(p);
  const fade = interpolate(p, [0, 0.02, 0.925, 0.985], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (fade <= 0) return null;
  const pos = stagePos(p);
  const stage = (k: number) => Math.max(0, 1 - Math.abs(pos - k));
  const pic = Math.min(1, stage(3) + stage(4) + stage(5));
  const w = 112;
  const h = 78;
  return (
    <Layer x={x - w / 2} y={TRACK_Y - h / 2} opacity={fade}>
      <Rect width={w} height={h} radius={10} fill={C.card} stroke={{ color: C.ink, width: 2 }} />
      <T x={0} y={26} w={w} align="center" mono size={22} weight={700} opacity={stage(0)}>{'<Title/>'}</T>
      <T x={0} y={24} w={w} align="center" size={24} weight={700} opacity={stage(1)}>{`frame ${n}`}</T>
      <T x={0} y={20} w={w} align="center" mono size={30} weight={700} color={C.cobalt} opacity={stage(2)}>{'{ }'}</T>
      <Layer opacity={pic}>
        <Rect width={w} height={h} radius={10} fill={C.night} />
        <Rect x={14} y={20} width={64} height={14} radius={3} fill="#ffffff" />
        <Rect x={14} y={44} width={44} height={8} radius={3} fill={C.amber} />
      </Layer>
    </Layer>
  );
};

export const Pipeline = () => {
  const frame = useCurrentFrame();
  const tokens = [0, 1].map((i) => ({ p: (((frame - i * 90) / DURATION) % 1 + 1) % 1, n: i + 1 }));
  return (
    <AbsoluteFill style={{ backgroundColor: C.paper }}>
      <Layer>
      {/* the no-browser header */}
      <Rect x={47} y={40} width={34} height={24} radius={4} stroke={{ color: C.mute, width: 2 }} />
      <Path d="M47 47 H81" stroke={{ color: C.mute, width: 2 }} />
      <NoSign x={64} y={52} r={26} />
      <T x={108} y={28} size={40} weight={700}>No browser in the render path</T>

      {/* the outline of the path, with marching dashes */}
      <Rect
        x={30}
        y={110}
        width={1220}
        height={430}
        radius={20}
        stroke={{ color: C.cobalt, width: 2, dashArray: [10, 8], dashOffset: -frame * 0.6 }}
      />

      {/* the track the frames run along */}
      <Path d={`M${CENTRE[0]} ${TRACK_Y + 52} H${CENTRE[5]}`} stroke={{ color: C.line, width: 2, dashArray: [3, 7] }} />

      {STATIONS.map((s, k) => {
        const lit = clamp01(tokens.reduce((sum, t) => sum + presence(t.p, k), 0));
        const x = X[k];
        const w = WIDTHS[k];
        return (
          <Layer key={k}>
            <Box x={x} y={BOX_Y} w={w} h={BOX_H} accent={lit} />
            {s.title.map((line, i) => (
              <T key={i} x={x} y={BOX_Y + (s.title.length === 1 ? 24 : 16) + i * 32} w={w} align="center" size={26} weight={700} color={lit > 0.5 ? C.cobalt : C.ink}>
                {line}
              </T>
            ))}
            <T x={x} y={BOX_Y + 100} w={w} align="center" size={18} color={C.mute} mono={s.mono}>{s.sub}</T>
            {k === 5 ? <Path d={`M${x + 56} ${BOX_Y + 62} l30 17 l-30 17 Z`} fill={lit > 0.5 ? C.cobalt : C.ink} /> : null}
            {k < 5 ? <Arrow x1={x + w + 4} y1={BOX_Y + BOX_H / 2} x2={X[k + 1] - 4} y2={BOX_Y + BOX_H / 2} /> : null}
          </Layer>
        );
      })}

      {tokens.map((t, i) => (
        <Token key={i} p={t.p} n={t.n} />
      ))}

      <T x={0} y={595} w={1280} align="center" size={30} color={C.mute}>Node hands over JSON. The pixels stay in Rust.</T>
      </Layer>
    </AbsoluteFill>
  );
};
