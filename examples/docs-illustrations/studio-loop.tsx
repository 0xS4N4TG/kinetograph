// Studio's loop: the preview, you mark up a frame, your agent edits the code, the engine redraws.
// Each step is 45 frames. The step that is active lights up, and a dot carries the work to the next one.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Ellipse, Layer, Path, Rect } from '@kinetographdev/core';
import { Arrow, Badge, Box, C, Picture, T, clamp01 } from './kit';

const STEP = 45;
const BOX_W = 480;
const BOX_H = 230;
const POS = [
  [110, 90],
  [690, 90],
  [690, 380],
  [110, 380],
] as const;
const TEXT = [
  ['Preview', 'the engine draws every frame'],
  ['You mark up', 'pin, box, pen or a time range'],
  ['Agent edits code', 'your coding agent edits files'],
  ['Engine redraws', 'the frame is drawn again'],
] as const;
// Arrows between boxes: from, to.
const ARROWS = [
  [594, 205, 686, 205],
  [930, 324, 930, 376],
  [686, 495, 594, 495],
  [350, 376, 350, 324],
] as const;

/** 1 while step s is active, with ramps that overlap its neighbours and wrap round the loop. */
function activity(s: number, f: number): number {
  const a = s * STEP;
  const at = (g: number) => interpolate(g, [a - 8, a + 2, a + STEP - 5, a + STEP + 7], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return Math.max(at(f), at(f + 180), at(f - 180));
}

const SCALE = 0.55;

export const StudioLoop = () => {
  const f = useCurrentFrame();
  const step = Math.floor(f / STEP);
  const t = f % STEP;
  const act = [0, 1, 2, 3].map((s) => activity(s, f));
  // The dot carries the work along the arrow from the active step to the next.
  const dot = clamp01((t - 24) / 17);
  const [dx1, dy1, dx2, dy2] = ARROWS[step];
  const showDot = t >= 24 && t <= 42;

  return (
    <AbsoluteFill style={{ backgroundColor: C.paper }}>
      <Layer>
        <T x={110} y={22} size={36} weight={700}>Studio&apos;s loop</T>

        {POS.map(([x, y], i) => {
          const a = act[i];
          return (
            <Layer key={i}>
              <Box x={x} y={y} w={BOX_W} h={BOX_H} accent={a} />
              <Badge x={x + 44} y={y + 44} n={i + 1} />
              <T x={x + 76} y={y + 24} size={32} weight={700} color={a > 0.5 ? C.cobalt : C.ink}>{TEXT[i][0]}</T>
              <T x={x + 28} y={y + 72} size={22} color={C.mute}>{TEXT[i][1]}</T>
            </Layer>
          );
        })}

        {/* 1: the preview, with a playhead that sweeps while it is active */}
        <Layer>
          <Picture x={POS[0][0] + 152} y={POS[0][1] + 108} scale={SCALE} bar={0.45} />
          <Rect
            x={POS[0][0] + 152 + 176 * clamp01(t / STEP)}
            y={POS[0][1] + 104}
            width={3}
            height={118}
            fill={C.cobalt}
            opacity={act[0]}
          />
        </Layer>

        {/* 2: a box mark and a note on the frame */}
        <Layer>
          <Picture x={POS[1][0] + 28} y={POS[1][1] + 108} scale={SCALE} bar={0.45} />
          <Rect
            x={POS[1][0] + 28 + 20}
            y={POS[1][1] + 108 + 26}
            width={120}
            height={34}
            radius={4}
            stroke={{ color: C.cobalt, width: 3, dashArray: [8, 6], dashOffset: -f * 0.7 }}
            opacity={0.35 + 0.65 * act[1]}
          />
          <Layer opacity={0.35 + 0.65 * act[1]}>
            <Rect x={POS[1][0] + 226} y={POS[1][1] + 118} width={226} height={64} radius={12} fill={C.tint} stroke={{ color: C.cobalt, width: 2 }} />
            <T x={POS[1][0] + 226} y={POS[1][1] + 134} w={226} align="center" size={24} color={C.ink}>make this bigger</T>
          </Layer>
        </Layer>

        {/* 3: the agent changes a line of code */}
        <Layer>
          <Rect x={POS[2][0] + 28} y={POS[2][1] + 112} width={424} height={100} radius={8} fill={C.paper} stroke={{ color: C.line, width: 1.5 }} />
          <Rect x={POS[2][0] + 32} y={POS[2][1] + 140} width={416} height={30} radius={4} fill={C.tint} opacity={act[2]} />
          <T x={POS[2][0] + 44} y={POS[2][1] + 118} mono size={20} color={C.mute}>{'<Text'}</T>
          <T x={POS[2][0] + 44} y={POS[2][1] + 144} mono size={20} weight={700} color={C.cobalt}>{'  size={128}'}</T>
          <T x={POS[2][0] + 44} y={POS[2][1] + 172} mono size={20} color={C.mute}>{'>Hello</Text>'}</T>
          <Rect x={POS[2][0] + 200} y={POS[2][1] + 146} width={3} height={22} fill={C.cobalt} opacity={act[2] * (Math.floor(f / 8) % 2 === 0 ? 1 : 0)} />
        </Layer>

        {/* 4: the engine draws the frame again: a scan line crosses it */}
        <Layer>
          <Picture x={POS[3][0] + 152} y={POS[3][1] + 108} scale={SCALE} bar={0.75} />
          <Rect
            x={POS[3][0] + 152 + 176 * clamp01((t - 4) / 30)}
            y={POS[3][1] + 104}
            width={3}
            height={118}
            fill={C.cobalt}
            opacity={act[3]}
          />
        </Layer>

        {ARROWS.map(([x1, y1, x2, y2], i) => (
          <Arrow key={i} x1={x1} y1={y1} x2={x2} y2={y2} color={i === step && t >= 20 ? C.cobalt : C.ink} />
        ))}
        {showDot ? <Ellipse x={dx1 + (dx2 - dx1) * dot - 8} y={dy1 + (dy2 - dy1) * dot - 8} width={16} height={16} fill={C.cobalt} /> : null}

        <T x={0} y={650} w={1280} align="center" size={26} color={C.mute}>Each mark carries its frame and the layers under it.</T>
      </Layer>
    </AbsoluteFill>
  );
};
