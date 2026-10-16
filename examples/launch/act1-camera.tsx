// Shot 5: the real camera (Poly Haven "Vintage Video Camera", CC0) in the reel's thermal duotone, turning slowly on black,
// an orbit line drawn round it (back arc behind, front arc in front), the handwritten "FILM" screen-blended over it.

import React from 'react';
import { AbsoluteFill, Easing, Sequence, Video, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Camera3D, DirectionalLight, Model, Rect, Scene3D, glow, gradientMap, grain } from '@kinetograph/core';
import { CLAMP, H, INK, LEN, OUT, PAPER, W } from './common.js';
import { IN, Over, Words } from './act1-kit.js';

/** The thermal duotone of the reference reel: shadows to deep red, mids orange, highlights pale gold. */
const THERMAL = gradientMap({
  stops: [
    { offset: 0, color: '#0d0605' },
    { offset: 0.18, color: '#5a0d08' },
    { offset: 0.42, color: '#d42a14' },
    { offset: 0.68, color: '#f5902a' },
    { offset: 1, color: '#ffe9b8' },
  ],
});

// The orbit: an ellipse round the camera, tilted, in two arcs so the back one passes behind the camera.
const CX = 1150;
const CY = 560;
const RX = 560;
const RY = 150;
const TILT = -14;
const BACK_ARC = `M${CX - RX} ${CY} A${RX} ${RY} 0 0 1 ${CX + RX} ${CY}`;
const FRONT_ARC = `M${CX + RX} ${CY} A${RX} ${RY} 0 0 1 ${CX - RX} ${CY}`;

/** The frame the handwritten FILM starts drawing: its ladder and scribble take 18 frames, then it boils on (we skip the ladder it starts with). */
const FILM_AT = 50;

export const S05: React.FC<{ graded?: boolean }> = ({ graded = true }) => {
  const frame = useCurrentFrame();
  const turn = interpolate(frame, [0, LEN.s05], [-44, -6], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const push = interpolate(frame, [0, LEN.s05], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.quad) });
  // Distance to the camera, as a multiple of the framing vector: a slow push from 1.2 to 1.08.
  const dist = 1.2 - 0.12 * push;
  const arrive = interpolate(frame, [0, 8], [0.3, 1], { ...CLAMP, easing: OUT });
  const backArc = interpolate(frame, [6, 24], [1, 0], { ...CLAMP, easing: OUT });
  const frontArc = interpolate(frame, [22, 42], [1, 0], { ...CLAMP, easing: OUT });
  // A flare at the cut, settling in 8 frames; another gathers over the last 10 frames into the burn.
  const flare = interpolate(frame, [0, 8], [1.6, 0.5], { ...CLAMP, easing: OUT }) + interpolate(frame, [LEN.s05 - 10, LEN.s05], [0, 0.9], { ...CLAMP, easing: IN });
  const rim = (r: number) => (
    <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
      <g transform={`rotate(${TILT} ${CX} ${CY})`}>
        <path d={BACK_ARC} fill="none" stroke={PAPER} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r === 0 ? backArc : 1} opacity={0.55} />
        <path d={FRONT_ARC} fill="none" stroke={PAPER} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r === 0 ? 1 : frontArc} />
      </g>
    </svg>
  );
  return (
    <>
      <Over><Rect width={W} height={H} fill={INK} /></Over>
      {graded && (
        <AbsoluteFill style={{ opacity: arrive }}>
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 42% 58% at 58% 50%, rgba(140,28,12,0.6) 0%, rgba(17,17,17,0) 72%)' }} />
          <div style={{ position: 'absolute', left: 560, top: 930, width: 1000, height: 150, background: 'radial-gradient(ellipse 50% 50% at 50% 50%, rgba(235,80,25,0.35) 0%, rgba(17,17,17,0) 100%)' }} />
          <div style={{ position: 'absolute', left: 700, top: 985, width: 800, height: 70, background: 'radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)' }} />
        </AbsoluteFill>
      )}
      {graded && rim(0)}
      <Over>
      <Scene3D
        id="camera" width={W} height={H} opacity={arrive}
        environment={{ src: staticFile('hdri/studio_small_08_1k.hdr'), intensity: 0.35 }}
        effects={graded ? [THERMAL, glow({ radius: 40, intensity: flare }), grain(0.05, { seed: 3 })] : []}
      >
        <Camera3D fov={24} position={[-0.08 + dist * 0.345, 0.07 + dist * 0.06, dist * 0.36]} target={[-0.065, 0.07, 0.0]} />
        <DirectionalLight direction={[0.55, -0.7, -0.45]} intensity={2.6} />
        <DirectionalLight direction={[-0.55, -0.25, 0.8]} intensity={3.2} />
        <DirectionalLight direction={[0.8, -0.15, 0.5]} intensity={0.5} />
        <Model src={staticFile('models/act1-camera.gltf')} rotation={[0, turn, 0]} />
      </Scene3D>
      </Over>
      {graded && (
        <>
          {rim(1)}
          <Sequence layout="none" from={FILM_AT} durationInFrames={5}>
            <Over blend="screen"><Video muted src={staticFile('fx/hand-film.mp4')} trimBefore={13} trimAfter={18} x={900} y={560} width={1100} height={619} /></Over>
          </Sequence>
          <Sequence layout="none" from={FILM_AT + 5}>
            <Over blend="screen"><Video muted src={staticFile('fx/hand-film.mp4')} trimBefore={18} trimAfter={31} loop x={900} y={560} width={1100} height={619} /></Over>
          </Sequence>
          <AbsoluteFill>
            <Words words={['you', 'just', 'render', 'it.']} at={[6, 11, 16, 22]} color={PAPER} size={64} style={{ position: 'absolute', left: 140, top: 510 }} />
          </AbsoluteFill>
        </>
      )}
    </>
  );
};
