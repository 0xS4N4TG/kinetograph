// Clawd in 3D: a showcase of the scene3d layer. Everything is a function of the frame.
//
//   npx kinetograph still examples/showcase-3d/index.tsx 90 -o out/showcase-3d-90.png
//   npx kinetograph render examples/showcase-3d/index.tsx -o out/showcase-3d.mp4
//
// Beats (30 fps, 180 frames): Clawd hops into an ivory studio cove and lands; three blocks drop in to build a stack
// while Clawd watches; Clawd hops for joy and the serif title (extruded, matte) and a tagline settle in; the last
// second holds. One slow camera arc. Palette: ivory, terracotta, charcoal, kraft (cloud grey for one block).

import React from 'react';
import { Composition, Easing, interpolate, registerRoot, spring, staticFile, useCurrentFrame } from 'remotion';
import {
  AmbientLight,
  Camera3D,
  DirectionalLight,
  Group3D,
  Layer,
  Mesh,
  Rect,
  Scene3D,
  Text,
  Text3D,
  grain,
} from '@kinetograph/core';
import { makeGoogleFont } from '@kinetograph/core/google-fonts';

const W = 1920;
const H = 1080;
const FPS = 30;
const DURATION = 180;

const SERIF = makeGoogleFont('Instrument Serif').loadFont('normal', { weights: ['400'] }).fontFamily;
const SANS = makeGoogleFont('Inter').loadFont('normal', { weights: ['400'] }).fontFamily;

const TERRACOTTA = '#D97757';
const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = Easing.inOut(Easing.cubic);
const easeOut = Easing.out(Easing.cubic);
const prog = (f: number, a: number, b: number, e: (t: number) => number = ease) => e(clamp((f - a) / (b - a)));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- Clawd's choreography ----

interface Hop {
  a: number;
  b: number;
  x1: number;
  y1: number;
  peak: number;
  spin?: number;
}
const START_X = -6;
const HOPS: Hop[] = [
  { a: 8, b: 30, x1: -3.6, y1: 0, peak: 1.1 },
  { a: 38, b: 58, x1: -1.7, y1: 0, peak: 0.8 },
  { a: 108, b: 124, x1: -1.7, y1: 0, peak: 0.7 },
  { a: 130, b: 142, x1: -1.7, y1: 0, peak: 0.35 },
];

interface ClawdState {
  x: number;
  y: number;
  ground: number;
  sx: number;
  sy: number;
  yaw: number;
  air: number;
}

function clawdAt(f: number): ClawdState {
  let x = START_X;
  let y = 0;
  let yaw = 0;
  let air = 0;
  let sq = 0; // + squashed, - stretched
  for (const h of HOPS) {
    if (f >= h.b) {
      x = h.x1;
      y = h.y1;
      yaw = 0;
      const t = f - h.b;
      sq += 0.26 * Math.exp(-t / 5) * Math.cos(t * 0.85);
    } else if (f >= h.a) {
      const p = (f - h.a) / (h.b - h.a);
      const x0 = x;
      const y0 = y;
      x = lerp(x0, h.x1, Easing.inOut(Easing.sin)(p));
      y = lerp(y0, h.y1, p) + h.peak * 4 * p * (1 - p);
      yaw = (h.spin ?? 0) * Easing.inOut(Easing.cubic)(p);
      air = 1;
      sq -= 0.16 * Math.sin(Math.PI * p);
    } else {
      // anticipation: crouch for 7 frames before takeoff
      sq += 0.22 * interpolate(f, [h.a - 8, h.a - 2, h.a], [0, 1, 0.3], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      break;
    }
  }
  return { x, y, ground: y, sx: 1 + sq * 0.5, sy: 1 - sq, yaw, air };
}

// ---- the set ----

const IVORY = '#F0EEE6';
const IVORY_DEEP = '#E8E4D9';
const CHARCOAL = '#1F1E1D';
const KRAFT = '#D4A27F';
const CLOUD = '#BFBFBA';

const STACK_X = 2.1;
const BLOCK = 1.1;
interface Drop {
  at: number;
  y: number; // resting centre height
  x: number;
}
const DROPS: Drop[] = [
  { at: 58, y: BLOCK / 2, x: STACK_X },
  { at: 78, y: BLOCK * 1.5, x: STACK_X },
  { at: 98, y: BLOCK * 2 + 0.4, x: STACK_X },
];

/** A dropped block: falls with an ease-in, lands, and squashes and recovers with a damped spring. */
function dropAt(f: number, d: Drop) {
  const fall = 12;
  const t = f - d.at;
  if (t < 0) return { y: 9, sy: 1, sxz: 1, vis: false };
  if (t < fall) {
    const p = t / fall;
    return { y: lerp(7, d.y, p * p), sy: 1 + 0.1 * p, sxz: 1 - 0.05 * p, vis: true };
  }
  const k = t - fall;
  const sq = 0.2 * Math.exp(-k / 5) * Math.cos(k * 0.9);
  return { y: d.y - sq * (d.y > BLOCK ? 0.25 : 0.4) * 0.5, sy: 1 - sq, sxz: 1 + sq * 0.5, vis: true };
}

const COVE = 3.2;
const WALL_Z = -6.5;
const STRIPS = 18;

const Cyclorama: React.FC = () => {
  const mat = { color: IVORY, roughness: 0.92, metallic: 0 };
  const strips: React.ReactNode[] = [];
  const stripLen = (COVE * Math.PI) / 2 / STRIPS;
  for (let i = 0; i < STRIPS; i++) {
    const a0 = (i / STRIPS) * 90;
    const am = ((i + 0.5) / STRIPS) * 90;
    // centre of the arc is (y = COVE, z = WALL_Z + COVE); the floor leaves it at angle 0 straight down
    const cy = COVE - Math.cos(rad(am)) * COVE;
    const cz = WALL_Z + COVE - Math.sin(rad(am)) * COVE;
    void a0;
    strips.push(
      <Mesh
        key={i}
        geometry={{ kind: 'plane', width: 80, height: stripLen * 1.02 }}
        material={mat}
        position={[0, cy, cz]}
        rotation={[-90 + am, 0, 0]}
      />,
    );
  }
  return (
    <>
      <Mesh geometry={{ kind: 'plane', width: 80, height: 60 }} material={mat} position={[0, 0, WALL_Z + COVE + 30]} rotation={[-90, 0, 0]} />
      {strips}
      <Mesh geometry={{ kind: 'plane', width: 80, height: 40 }} material={mat} position={[0, COVE + 20, WALL_Z]} />
    </>
  );
};

/** A soft contact shadow: warm grey, low opacity, thrown away from the key (to the right and back). */
const Shadow: React.FC<{ x: number; y: number; z: number; r: number; o: number }> = ({ x, y, z, r, o }) => (
  <Mesh
    geometry={{ kind: 'plane', width: 1, height: 1 }}
    material={{ color: '#4a3b30', texture: staticFile('shadow.png'), unlit: true, opacity: clamp(o, 0, 1) }}
    position={[x + r * 0.22, y, z - r * 0.12]}
    rotation={[-90, 0, 0]}
    scale={[r * 2.2, r * 1.7, 1]}
  />
);

const Clawd: React.FC<{ f: number; look: number; lookY: number }> = ({ f, look, lookY }) => {
  const c = clawdAt(f);
  const LEG_H = 0.45;
  const BODY_H = 1.05;
  const bodyMat = { color: TERRACOTTA, roughness: 0.7, metallic: 0 };
  const legMat = { color: '#C4694A', roughness: 0.75 };
  const eyeMat = { color: CHARCOAL, roughness: 0.4 };

  const wiggle = interpolate(f, [104, 108, 120, 126], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const amp = Math.max(c.air * 0.9, wiggle * 0.5, 0.03);
  const speed = c.air ? 0.55 : 0.75;
  const legX = [-0.8, -0.46, 0.46, 0.8];
  const legRot = (i: number) => Math.sin(f * speed + (i % 2 ? Math.PI : 0) + i * 0.4) * 38 * amp;
  const armRot = (s: number) => (Math.sin(f * speed * 1.1 + (s > 0 ? 0 : Math.PI)) * 30 * Math.max(c.air, wiggle) + (c.air ? -25 : 0));

  const blink = [24, 84, 140].reduce((m, b) => Math.max(m, clamp(1 - Math.abs(f - b - 1.5) / 2.5)), 0);
  const eyeSy = 1 - 0.9 * clamp(blink * 1.6);
  const bodyYaw = c.yaw + look * 22;

  return (
    <Group3D position={[c.x, c.y, 0]} rotation={[0, bodyYaw, 0]} scale={[c.sx * 1.2, c.sy * 1.2, c.sx * 1.2]}>
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

  // one slow eased arc and push-in
  const az = interpolate(f, [0, 150], [-16, 8], { easing: Easing.inOut(Easing.quad) });
  const radius = interpolate(f, [0, 150], [13.5, 11.2], { easing: Easing.inOut(Easing.quad) });
  const tx = interpolate(f, [0, 150], [-0.8, 0.3], { easing: ease });
  const camPos: [number, number, number] = [tx + Math.sin(rad(az)) * radius, 2.6, Math.cos(rad(az)) * radius];

  // Clawd watches the newest block as it falls, then the stack
  const watching = prog(f, 50, 62);
  const look = clamp((STACK_X - c.x) / 4, -1, 1) * watching;
  const lookY = clamp(interpolate(f, [58, 70, 98, 110], [1, 0.2, 0.9, 1]), -1, 1) * watching;

  const shadowH = (y: number) => 1 - clamp(y / 2.4) * 0.75;

  const titleIn = spring({ frame: f - 112, fps: FPS, config: { damping: 22, mass: 1, stiffness: 60 } });

  return (
    <Scene3D id="stage" width={W} height={H} motionBlur={{ samples: 4, shutter: 0.2 }}>
      <Camera3D fov={30} position={camPos} target={[tx, 1.5, 0]} />
      <AmbientLight color="#fff4ea" intensity={0.44} />
      <DirectionalLight direction={[0.7, -0.85, -0.55]} color="#ffe9d2" intensity={0.85} />
      <DirectionalLight direction={[-0.6, -0.35, -0.7]} color="#fff6ec" intensity={0.2} />
      <DirectionalLight direction={[-0.35, -0.15, 1]} color="#ffe3cc" intensity={0.28} />

      <Cyclorama />

      <Shadow x={c.x} y={0.015} z={0.05} r={1.7 * (1 - clamp(c.y / 3) * 0.3)} o={0.34 * shadowH(c.y)} />
      {DROPS.map((d, i) => {
        const s = dropAt(f, d);
        const h = Math.max(0, s.y - d.y);
        return s.vis ? (
          <Shadow key={i} x={d.x} y={0.015} z={0} r={0.95 - clamp(h / 8) * 0.3} o={(i === 0 ? 0.36 : 0.18) * (1 - clamp(h / 6)) * (1 - 0.1 * i)} />
        ) : null;
      })}

      <Clawd f={f} look={look} lookY={lookY} />

      {(() => {
        const a = dropAt(f, DROPS[0]!);
        const b = dropAt(f, DROPS[1]!);
        const s = dropAt(f, DROPS[2]!);
        return (
          <>
            {a.vis && <Mesh geometry={{ kind: 'box', width: BLOCK, height: BLOCK, depth: BLOCK }} material={{ color: KRAFT, roughness: 0.78 }} position={[STACK_X, a.y, 0]} rotation={[0, 8, 0]} scale={[a.sxz, a.sy, a.sxz]} />}
            {b.vis && <Mesh geometry={{ kind: 'box', width: BLOCK, height: BLOCK, depth: BLOCK }} material={{ color: CLOUD, roughness: 0.8 }} position={[STACK_X, b.y, 0]} rotation={[0, -10, 0]} scale={[b.sxz, b.sy, b.sxz]} />}
            {s.vis && <Mesh geometry={{ kind: 'sphere', radius: 0.4, segments: 48, rings: 24 }} material={{ color: CHARCOAL, metallic: 0.55, roughness: 0.35 }} position={[STACK_X, s.y, 0]} scale={[s.sxz, s.sy, s.sxz]} />}
          </>
        );
      })()}

      <Text3D
        font={SERIF}
        size={1.15}
        depth={0.12}
        align="left"
        position={[-3.5 + (1 - titleIn) * -0.5, 4.1, -3.2]}
        scale={clamp(titleIn, 0, 1) < 0.01 ? 0.001 : 1}
        material={{ color: CHARCOAL, roughness: 0.85, metallic: 0 }}
      >
        Kinetograph
      </Text3D>
    </Scene3D>
  );
};

// ---- 2D over the 3D ----

const TAGLINE = 'THE BROWSERLESS VIDEO ENGINE';

const Overlay: React.FC = () => {
  const f = useCurrentFrame();
  const o = easeOut(clamp((f - 126) / 20));
  const veil = interpolate(f, [0, 14], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  return (
    <>
      <Rect
        width={W}
        height={H}
        fill={{ type: 'radial', units: 'box', cx: 0.5, cy: 0.5, r: 0.8, stops: [{ offset: 0.6, color: '#3a2a1c00' }, { offset: 1, color: '#3a2a1c22' }] }}
      />
      <Text
        font={SANS}
        size={26}
        color={CHARCOAL}
        x={192}
        y={268 + (1 - o) * 10}
        opacity={0.62 * o}
        chars={(_c, i) => ({ x: i * 4 })}
      >
        {TAGLINE}
      </Text>
      <Rect width={W} height={H} fill={IVORY} opacity={veil} />
    </>
  );
};

export const Showcase3D: React.FC = () => (
  <Layer effects={[grain(0.025, { seed: 11, size: 1.2 })]}>
    <Rect
      width={W}
      height={H}
      fill={{ type: 'radial', units: 'box', cx: 0.4, cy: 0.35, r: 0.85, stops: [{ offset: 0, color: IVORY }, { offset: 1, color: IVORY_DEEP }] }}
    />
    <Stage />
    <Overlay />
  </Layer>
);

registerRoot(() => (
  <Composition id="Showcase3D" component={Showcase3D} durationInFrames={DURATION} fps={FPS} width={W} height={H} background="#F0EEE6" />
));
