// Clawd in 3D: a showcase of the scene3d layer. Everything is a function of the frame.
//
//   npx kinetograph still examples/showcase-3d/index.tsx 90 -o out/showcase-3d-90.png
//   npx kinetograph render examples/showcase-3d/index.tsx -o out/showcase-3d.mp4
//
// Beats (30 fps, 180 frames): Clawd is already hopping into an ivory studio cove (three-quarter view) and lands; two
// slabs and a sphere drop in beside it and Clawd turns to watch; Clawd hops on top of the stack, turns to the camera
// and strikes a pose as the serif title and tagline rise in; the last second holds. One slow 25 degree camera arc.
// Palette: ivory, terracotta, charcoal, kraft (cloud grey for one slab).

import React from 'react';
import { Composition, Easing, interpolate, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import {
  AmbientLight,
  Camera3D,
  DirectionalLight,
  Group3D,
  Layer,
  Mesh,
  PointLight,
  Rect,
  Scene3D,
  Text,
  grain,
} from '@kinetographdev/core';
import { makeGoogleFont } from '@kinetographdev/core/google-fonts';

const W = 1920;
const H = 1080;
const FPS = 30;
const DURATION = 180;

const SERIF = makeGoogleFont('Instrument Serif').loadFont('normal', { weights: ['400'] }).fontFamily;
const SANS = makeGoogleFont('Inter').loadFont('normal', { weights: ['400'] }).fontFamily;

const IVORY = '#F0EEE6';
const IVORY_DEEP = '#E8E4D9';
const CHARCOAL = '#1F1E1D';
const KRAFT = '#D4A27F';
const CLOUD = '#BFBFBA';
const TERRACOTTA = '#D97757';

const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = Easing.inOut(Easing.cubic);
const easeOut = Easing.out(Easing.cubic);
const prog = (f: number, a: number, b: number, e: (t: number) => number = ease) => e(clamp((f - a) / (b - a)));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- Clawd's choreography ----

const STACK_X = 1.7;
const SLAB1 = { w: 2.5, h: 0.9, d: 1.7 };
const SLAB2 = { w: 2.2, h: 0.8, d: 1.5 };
const STACK_TOP = SLAB1.h + SLAB2.h;
const SPHERE = { x: 4.2, z: -0.7, r: 0.5 };

interface Hop {
  a: number;
  b: number;
  x1: number;
  y1: number;
  peak: number;
}
const START_X = -5.6;
const HOPS: Hop[] = [
  { a: -2, b: 18, x1: -3.6, y1: 0, peak: 1.1 },
  { a: 24, b: 42, x1: -2.2, y1: 0, peak: 0.8 },
  { a: 100, b: 124, x1: STACK_X, y1: STACK_TOP, peak: 1.5 },
];

interface ClawdState {
  x: number;
  y: number;
  sx: number;
  sy: number;
  air: number;
}

function clawdAt(f: number): ClawdState {
  let x = START_X;
  let y = 0;
  let air = 0;
  let sq = 0; // + squashed, - stretched
  for (const h of HOPS) {
    if (f >= h.b) {
      x = h.x1;
      y = h.y1;
      const t = f - h.b;
      sq += 0.26 * Math.exp(-t / 5) * Math.cos(t * 0.85);
    } else if (f >= h.a) {
      const p = (f - h.a) / (h.b - h.a);
      const x0 = x;
      const y0 = y;
      x = lerp(x0, h.x1, Easing.inOut(Easing.sin)(p));
      y = lerp(y0, h.y1, p) + h.peak * 4 * p * (1 - p);
      air = 1;
      sq -= 0.16 * Math.sin(Math.PI * p);
    } else {
      sq += 0.22 * interpolate(f, [h.a - 8, h.a - 2, h.a], [0, 1, 0.3], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      break;
    }
  }
  return { x, y, sx: 1 + sq * 0.5, sy: 1 - sq, air };
}

/** Clawd's heading: along its hops, then toward the stack while the props fall, then round to the camera. */
const yawAt = (f: number) =>
  interpolate(f, [0, 40, 56, 96, 116, 140], [70, 70, 62, 62, 24, 24], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

// ---- the set ----

interface Drop {
  at: number;
  y: number; // resting centre height
  squash: number;
}
const DROPS: Drop[] = [
  { at: 46, y: SLAB1.h / 2, squash: 0.14 },
  { at: 64, y: SLAB1.h + SLAB2.h / 2, squash: 0.12 },
  { at: 80, y: SPHERE.r, squash: 0.2 },
];

/** A dropped prop: falls with an ease-in, lands, squashes and recovers with a damped spring. */
function dropAt(f: number, d: Drop) {
  const fall = 12;
  const t = f - d.at;
  if (t < 0) return { y: 9, sy: 1, sxz: 1, vis: false };
  if (t < fall) {
    const p = t / fall;
    return { y: lerp(d.y + 6, d.y, p * p), sy: 1 + 0.08 * p, sxz: 1 - 0.04 * p, vis: true };
  }
  const k = t - fall;
  const sq = d.squash * Math.exp(-k / 5) * Math.cos(k * 0.9);
  return { y: d.y - sq * 0.3, sy: 1 - sq, sxz: 1 + sq * 0.5, vis: true };
}

const COVE = 4;
const WALL_Z = -7;
const STRIPS = 24;

const Cyclorama: React.FC = () => {
  const mat = { color: IVORY, roughness: 0.92, metallic: 0 };
  const strips: React.ReactNode[] = [];
  const stripLen = (COVE * Math.PI) / 2 / STRIPS;
  for (let i = 0; i < STRIPS; i++) {
    const am = ((i + 0.5) / STRIPS) * 90;
    const cy = COVE - Math.cos(rad(am)) * COVE;
    const cz = WALL_Z + COVE - Math.sin(rad(am)) * COVE;
    strips.push(
      <Mesh key={i} geometry={{ kind: 'plane', width: 400, height: stripLen * 1.02 }} material={mat} position={[0, cy, cz]} rotation={[-90 + am, 0, 0]} />,
    );
  }
  return (
    <>
      <Mesh geometry={{ kind: 'plane', width: 400, height: 200 }} material={mat} position={[0, 0, WALL_Z + COVE + 100]} rotation={[-90, 0, 0]} />
      {strips}
      <Mesh geometry={{ kind: 'plane', width: 400, height: 100 }} material={mat} position={[0, COVE + 20, WALL_Z]} />
    </>
  );
};

/** A soft contact shadow: dark warm grey, thrown away from the key (right and back). */
const Shadow: React.FC<{ x: number; y: number; z: number; rx: number; rz: number; o: number }> = ({ x, y, z, rx, rz, o }) => (
  <Mesh
    geometry={{ kind: 'plane', width: 1, height: 1 }}
    material={{ color: '#2e2018', texture: staticFile('shadow.png'), unlit: true, opacity: clamp(o, 0, 1) }}
    position={[x + rx * 0.2, y, z - rz * 0.12]}
    rotation={[-90, 0, 0]}
    scale={[rx * 2.2, rz * 2.2, 1]}
  />
);

const Clawd: React.FC<{ f: number; look: number; lookY: number }> = ({ f, look, lookY }) => {
  const c = clawdAt(f);
  const LEG_H = 0.45;
  const BODY_H = 1.05;
  const bodyMat = { color: TERRACOTTA, roughness: 0.7, metallic: 0 };
  const legMat = { color: '#C4694A', roughness: 0.75 };
  const eyeMat = { color: CHARCOAL, roughness: 0.4 };

  const pose = interpolate(f, [128, 140], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeOut });
  const wiggle = interpolate(f, [60, 64, 74, 80], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const amp = Math.max(c.air * 0.9, wiggle * 0.5, 0.03);
  const speed = c.air ? 0.55 : 0.75;
  const legX = [-0.8, -0.46, 0.46, 0.8];
  const legRot = (i: number) => Math.sin(f * speed + (i % 2 ? Math.PI : 0) + i * 0.4) * 38 * amp;
  const armRot = (s: number) =>
    (Math.sin(f * speed * 1.1 + (s > 0 ? 0 : Math.PI)) * 30 * Math.max(c.air, wiggle) + (c.air ? -25 : 0)) * (1 - pose) - pose * 62;

  const blink = [30, 90, 150].reduce((m, b) => Math.max(m, clamp(1 - Math.abs(f - b - 1.5) / 2.5)), 0);
  const eyeSy = 1 - 0.9 * clamp(blink * 1.6);

  return (
    <Group3D position={[c.x, c.y, 0]} rotation={[0, yawAt(f), 0]} scale={[c.sx * 1.4, c.sy * 1.4, c.sx * 1.4]}>
      {legX.map((lx, i) => (
        <Group3D key={i} position={[lx, LEG_H, 0.05]} rotation={[legRot(i), 0, 0]}>
          <Mesh geometry={{ kind: 'box', width: 0.24, height: LEG_H, depth: 0.26 }} material={legMat} position={[0, -LEG_H / 2, 0]} />
        </Group3D>
      ))}
      <Group3D position={[0, LEG_H, 0]}>
        <Mesh geometry={{ kind: 'box', width: 2.0, height: BODY_H, depth: 1.0 }} material={bodyMat} position={[0, BODY_H / 2, 0]} />
        {[-1, 1].map((s) => (
          <Group3D key={s} position={[s * 1.12, BODY_H * 0.55, 0]} rotation={[0, 0, armRot(s) * s]}>
            <Mesh geometry={{ kind: 'box', width: 0.28, height: 0.32, depth: 0.3 }} material={bodyMat} position={[s * 0.02, 0, 0]} />
          </Group3D>
        ))}
        {[-1, 1].map((s) => (
          <Mesh
            key={s}
            geometry={{ kind: 'box', width: 0.17, height: 0.34, depth: 0.08 }}
            material={eyeMat}
            position={[s * 0.44 + look * 0.1, BODY_H * 0.58 + lookY * 0.06, 0.52]}
            scale={[1, eyeSy, 1]}
          />
        ))}
      </Group3D>
    </Group3D>
  );
};

const Stage: React.FC = () => {
  const f = useCurrentFrame();
  const c = clawdAt(f);

  // one slow eased three-quarter arc (26 to 51 degrees) with a gentle push-in
  const az = interpolate(f, [0, 150], [26, 51], { easing: ease });
  const radius = interpolate(f, [0, 150], [10.2, 11.6], { easing: ease });
  const camH = interpolate(f, [0, 150], [3.2, 4.0], { easing: ease });
  const tx = interpolate(f, [0, 150], [-0.9, 0.3], { easing: ease });
  const ty = interpolate(f, [0, 150], [1.5, 2.1], { easing: ease });
  const camPos: [number, number, number] = [tx + Math.sin(rad(az)) * radius, camH, Math.cos(rad(az)) * radius];

  // Clawd's eyes follow the falling props, then settle on the camera
  const watching = prog(f, 44, 56) * (1 - prog(f, 112, 124));
  const look = clamp((STACK_X - c.x) / 3, -1, 1) * watching;
  const lookY = clamp(interpolate(f, [46, 58, 64, 76, 80, 92], [1, 0.2, 1, 0.3, 1, 0.2], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })) * watching;

  const shadowH = (h: number) => 1 - clamp(h / 2.6) * 0.75;
  const overStack = prog(c.x, 0.7, 1.4, (t) => t);
  const d0 = dropAt(f, DROPS[0]!);
  const d1 = dropAt(f, DROPS[1]!);
  const d2 = dropAt(f, DROPS[2]!);

  return (
    <Scene3D id="stage" width={W} height={H} motionBlur={{ samples: 4, shutter: 0.2 }}>
      <Camera3D fov={32} position={camPos} target={[tx, ty, 0]} />
      <AmbientLight color="#fff4ea" intensity={0.2} />
      <DirectionalLight direction={[0.75, -0.8, -0.5]} color="#ffe6cc" intensity={1.0} />
      <DirectionalLight direction={[-0.8, -0.3, -0.4]} color="#fff6ec" intensity={0.14} />
      <DirectionalLight direction={[-0.35, -0.15, 1]} color="#ffe3cc" intensity={0.3} />
      {/* the pool of light on the backdrop behind the subject */}
      <PointLight position={[1.2, 3.6, WALL_Z + 3]} color="#ffe2c4" intensity={5} range={11} />

      <Cyclorama />

      {/* shadows: Clawd on the floor and on the stack, the stack and the sphere on the floor */}
      <Shadow x={c.x} y={0.015} z={0.05} rx={2.2 * (1 - clamp(c.y / 3) * 0.25)} rz={1.2} o={0.6 * shadowH(c.y) * (1 - overStack)} />
      <Shadow x={c.x} y={STACK_TOP + 0.02} z={0.05} rx={1.8} rz={1.2} o={0.55 * shadowH(c.y - STACK_TOP) * overStack} />
      {d0.vis && <Shadow x={STACK_X} y={0.015} z={0} rx={2.6} rz={1.7} o={0.62 * (1 - clamp((d0.y - DROPS[0]!.y) / 5))} />}
      {d2.vis && <Shadow x={SPHERE.x} y={0.015} z={SPHERE.z} rx={0.75} rz={0.75} o={0.6 * (1 - clamp((d2.y - SPHERE.r) / 5))} />}

      <Clawd f={f} look={look} lookY={lookY} />

      {d0.vis && (
        <Mesh geometry={{ kind: 'box', width: SLAB1.w, height: SLAB1.h, depth: SLAB1.d }} material={{ color: KRAFT, roughness: 0.8 }} position={[STACK_X, d0.y, 0]} scale={[d0.sxz, d0.sy, d0.sxz]} />
      )}
      {d1.vis && (
        <Mesh geometry={{ kind: 'box', width: SLAB2.w, height: SLAB2.h, depth: SLAB2.d }} material={{ color: CLOUD, roughness: 0.8 }} position={[STACK_X, d1.y, 0]} rotation={[0, -6, 0]} scale={[d1.sxz, d1.sy, d1.sxz]} />
      )}
      {d2.vis && (
        <Mesh geometry={{ kind: 'sphere', radius: SPHERE.r, segments: 48, rings: 24 }} material={{ color: CHARCOAL, metallic: 0, roughness: 0.6 }} position={[SPHERE.x, d2.y, SPHERE.z]} scale={[d2.sxz, d2.sy, d2.sxz]} />
      )}
    </Scene3D>
  );
};

// ---- 2D over the 3D ----

const TITLE = 'Kinetograph';
const TAGLINE = 'THE BROWSERLESS VIDEO ENGINE';
const MARGIN = 160;

const Overlay: React.FC = () => {
  const f = useCurrentFrame();
  const o1 = easeOut(clamp((f - 114) / 26));
  const o2 = easeOut(clamp((f - 128) / 26));
  return (
    <>
      <Rect
        width={W}
        height={H}
        fill={{ type: 'radial', units: 'box', cx: 0.55, cy: 0.5, r: 0.8, stops: [{ offset: 0.55, color: '#3a2a1c00' }, { offset: 1, color: '#3a2a1c30' }] }}
      />
      <Text font={SERIF} size={136} color={CHARCOAL} x={MARGIN} y={92 + (1 - o1) * 24} opacity={o1} chars={(_c, i) => ({ x: i * 1.4 })}>
        {TITLE}
      </Text>
      <Text font={SANS} size={28} color={CHARCOAL} x={MARGIN + 4} y={272 + (1 - o2) * 16} opacity={0.65 * o2} chars={(_c, i) => ({ x: i * 5 })}>
        {TAGLINE}
      </Text>
    </>
  );
};

export const Showcase3D: React.FC = () => (
  <Layer effects={[grain(0.025, { seed: 11, size: 1.2 })]}>
    <Rect
      width={W}
      height={H}
      fill={{ type: 'radial', units: 'box', cx: 0.55, cy: 0.4, r: 0.85, stops: [{ offset: 0, color: IVORY }, { offset: 1, color: IVORY_DEEP }] }}
    />
    <Stage />
    <Overlay />
  </Layer>
);

registerRoot(() => (
  <Composition id="Showcase3D" component={Showcase3D} durationInFrames={DURATION} fps={FPS} width={W} height={H} background="#F0EEE6" />
));
