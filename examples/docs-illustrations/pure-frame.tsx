// A frame is a pure function of the project and the frame number. The number goes 12, 24, 12: the picture
// changes with it, and when 12 comes back the picture is the one from before. Nothing reads a clock.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Layer, Path } from '@kinetographdev/core';
import { Arrow, Box, C, NoSign, Picture, T, smooth } from './kit';

const barAt = (f: number) => {
  if (f < 60) return 0.4;
  if (f < 120) return 0.4 + 0.4 * smooth((f - 68) / 12);
  return 0.8 - 0.4 * smooth((f - 128) / 12);
};

/** 1 around a change of frame number, 0 elsewhere. */
const pulse = (f: number) =>
  Math.max(
    interpolate(f, [58, 64, 80], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    interpolate(f, [118, 124, 140], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );

export const PureFrame = () => {
  const f = useCurrentFrame();
  const flip = (a: number) => smooth((f - a) / 8);
  // 12 until frame 60, then 24 until 120, then 12 again.
  const show24 = f < 120 ? flip(60) : 1 - flip(120);
  const accent = pulse(f);
  const history = interpolate(f, [30, 42, 164, 176], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const same = interpolate(f, [138, 148, 164, 172], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: C.paper }}>
      <Layer>
        <T x={80} y={28} size={36} weight={700}>Same project, same frame, same picture</T>
        <Box x={80} y={120} w={280} h={110} />
        <T x={80} y={146} w={280} align="center" size={28} weight={700}>Project</T>
        <T x={80} y={186} w={280} align="center" size={20} color={C.mute}>code, props, files</T>

        <Box x={80} y={270} w={280} h={140} />
        <T x={80} y={286} w={280} align="center" size={28} weight={700}>Frame number</T>
        <T x={80} y={332} w={280} align="center" mono size={60} weight={700} color={C.cobalt} opacity={1 - show24}>12</T>
        <T x={80} y={332} w={280} align="center" mono size={60} weight={700} color={C.cobalt} opacity={show24}>24</T>

        <Path d="M364 175 H410 V270" stroke={{ color: C.ink, width: 2.5, cap: 'round', join: 'round' }} />
        <Path d="M364 340 H410 V270" stroke={{ color: C.ink, width: 2.5, cap: 'round', join: 'round' }} />
        <Arrow x1={410} y1={270} x2={466} y2={270} />

        <Box x={470} y={190} w={250} h={160} accent={0.6 + 0.4 * accent} />
        <T x={470} y={238} w={250} align="center" size={36} weight={700} color={C.cobalt}>Render</T>
        <T x={470} y={288} w={250} align="center" size={22} color={C.mute}>pure function</T>

        <Arrow x1={724} y1={270} x2={852} y2={270} />
        <Picture x={860} y={170} bar={barAt(f)} />
        <T x={860} y={380} w={320} align="center" size={22} color={C.mute}>pixels</T>

        <T x={860} y={412} w={320} align="center" size={44} weight={700} color={C.cobalt} opacity={same}>=</T>
        <Layer opacity={history}>
          <Picture x={940} y={470} scale={0.5} bar={0.4} />
          <T x={860} y={576} w={320} align="center" size={20} color={C.mute}>frame 12, earlier</T>
        </Layer>

        <NoSign x={80} y={650} r={20} />
        <T x={116} y={634} size={28} color={C.mute}>No wall clock. The frame number is the only clock.</T>
      </Layer>
    </AbsoluteFill>
  );
};
