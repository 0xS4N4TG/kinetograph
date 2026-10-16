// Clawd in 3D: a showcase of the scene3d layer. Everything is a function of the frame.
//
//   npx kinetograph still examples/showcase-3d/index.tsx 90 -o out/showcase-3d-90.png
//   npx kinetograph render examples/showcase-3d/index.tsx -o out/showcase-3d.mp4
//
// Beats (30 fps, 180 frames): 0-1 s Clawd idles, blinks and hops toward a plinth while six primitives pop in and
// orbit; 1.3-2 s the hop onto the plinth, the camera pushes in; 2-3.3 s Clawd follows the chrome sphere with its
// eyes and wiggles; 3.3-4.3 s the extruded title flies in from the camera, Clawd spins for joy; 4.5-6 s the tagline
// (2D, composited with glow and grain) and a slow orbit.

import React from 'react';
import { Composition, Easing, interpolate, registerRoot, spring, staticFile, useCurrentFrame } from 'remotion';
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
  Text3D,
  glow,
  grain,
  motionBlur,
} from '@kinetograph/core';
import { loadFont } from '@kinetograph/core/fonts';

const W = 1920;
const H = 1080;
const FPS = 30;
const DURATION = 180;

const FONT = 'DM Sans';
loadFont({ family: FONT, url: staticFile('DMSans-Medium.ttf'), weight: '500' });

const ORANGE = '#D97757';
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
const START_X = -4.6;
const PLINTH_TOP = 0.5;
const HOPS: Hop[] = [
  { a: 14, b: 32, x1: -2.9, y1: 0, peak: 0.9 },
  { a: 42, b: 64, x1: 0, y1: PLINTH_TOP, peak: 1.5 },
  { a: 120, b: 142, x1: 0, y1: PLINTH_TOP, peak: 1.3, spin: 360 },
  { a: 156, b: 168, x1: 0, y1: PLINTH_TOP, peak: 0.45 },
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

// ---- orbiting primitives ----

interface Orbiter {
  geometry: React.ComponentProps<typeof Mesh>['geometry'];
  material: React.ComponentProps<typeof Mesh>['material'];
  phase: number;
  size: number;
  rot: [number, number, number];
}
const ORBITERS: Orbiter[] = [
  { geometry: { kind: 'sphere', radius: 0.5, segments: 48, rings: 24 }, material: { color: '#d8dff0', metallic: 1, roughness: 0.12 }, phase: 0, size: 0.8, rot: [0, 0, 0] },
  { geometry: { kind: 'torus', radius: 0.45, tube: 0.16, tubeSegments: 24, ringSegments: 56 }, material: { color: '#2fd4ff', metallic: 0.2, roughness: 0.25, emissive: '#1aa6d0', emissiveIntensity: 0.6 }, phase: 60, size: 1, rot: [70, 0, 0] },
  { geometry: { kind: 'cylinder', radiusTop: 0.3, radiusBottom: 0.3, height: 0.75, segments: 40 }, material: { color: '#f3c969', metallic: 0.9, roughness: 0.3 }, phase: 120, size: 1, rot: [20, 0, 25] },
  { geometry: { kind: 'sphere', radius: 0.5, segments: 40, rings: 20 }, material: { color: '#ff4fa8', metallic: 0, roughness: 0.2, emissive: '#ff2c8f', emissiveIntensity: 1.1 }, phase: 180, size: 0.55, rot: [0, 0, 0] },
  { geometry: { kind: 'cylinder', radiusTop: 0, radiusBottom: 0.45, height: 0.9, segments: 40 }, material: { color: '#a78bfa', metallic: 0.3, roughness: 0.35 }, phase: 240, size: 0.9, rot: [0, 0, 15] },
  { geometry: { kind: 'box', width: 0.6, height: 0.6, depth: 0.6 }, material: { color: '#f4efe9', metallic: 0.1, roughness: 0.4 }, phase: 300, size: 0.8, rot: [30, 0, 30] },
];

function orbiterPos(f: number, o: Orbiter, i: number): [number, number, number] {
  const th = rad(o.phase + f * 2.6);
  const bounce = Math.abs(Math.sin(f * 0.16 + i * 1.3)) * 1.1;
  return [Math.cos(th) * 5.8 , 0.55 * o.size + 0.2 + bounce, Math.sin(th) * 4.4 - 1.6];
}

// ---- the 3D scene ----

const Shadow: React.FC<{ x: number; y: number; z: number; r: number; o: number }> = ({ x, y, z, r, o }) => (
  <Mesh
    geometry={{ kind: 'plane', width: 1, height: 1 }}
    material={{ color: '#000000', texture: staticFile('shadow.png'), unlit: true, opacity: clamp(o, 0, 1) }}
    position={[x, y, z]}
    rotation={[-90, 0, 0]}
    scale={[r * 2, r * 2, 1]}
  />
);

const Clawd: React.FC<{ f: number; look: number; lookY: number }> = ({ f, look, lookY }) => {
  const c = clawdAt(f);
  const LEG_H = 0.45;
  const BODY_H = 1.05;
  const bodyMat = { color: ORANGE, roughness: 0.9, metallic: 0 };
  const legMat = { color: '#c4623f', roughness: 0.75 };
  const eyeMat = { color: '#1b1411', roughness: 0.25 };

  // legs swing while airborne and in a happy wiggle after landing
  const wiggle = interpolate(f, [68, 72, 90, 96], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const amp = Math.max(c.air * 0.9, wiggle * 0.6, 0.04);
  const speed = c.air ? 0.55 : 0.75;
  const legX = [-0.8, -0.46, 0.46, 0.8];
  const legRot = (i: number) => Math.sin(f * speed + (i % 2 ? Math.PI : 0) + i * 0.4) * 38 * amp;
  const armRot = (s: number) => Math.sin(f * speed * 1.1 + (s > 0 ? 0 : Math.PI)) * 30 * Math.max(c.air, wiggle) + (c.air ? -25 : 0);

  const blink = [26, 76, 146].reduce((m, b) => Math.max(m, 1 - Math.abs(f - b - 1.5) / 2.5 > 0 ? 1 - Math.abs(f - b - 1.5) / 2.5 : 0), 0);
  const eyeSy = 1 - 0.9 * clamp(blink * 1.6);
  const bodyYaw = c.yaw + look * 24;

  return (
    <Group3D position={[c.x, c.y, 0]} rotation={[0, bodyYaw, 0]} scale={[c.sx * 1.2, c.sy * 1.2, c.sx * 1.2]}>
      {legX.map((lx, i) => (
        <Group3D key={i} position={[lx, LEG_H, i < 2 ? 0.05 : 0.05]} rotation={[legRot(i), 0, 0]}>
          <Mesh geometry={{ kind: 'box', width: 0.24, height: LEG_H, depth: 0.26 }} material={legMat} position={[0, -LEG_H / 2, 0]} />
        </Group3D>
      ))}
      <Group3D position={[0, LEG_H, 0]}>
        <Mesh geometry={{ kind: 'box', width: 2.0, height: BODY_H, depth: 1.0 }} material={bodyMat} position={[0, BODY_H / 2, 0]} />
        {/* arm nubs */}
        {[-1, 1].map((s) => (
          <Group3D key={s} position={[s * 1.12, BODY_H * 0.55, 0]} rotation={[0, 0, armRot(s) * s]}>
            <Mesh geometry={{ kind: 'box', width: 0.28, height: 0.32, depth: 0.3 }} material={bodyMat} position={[s * 0.02, 0, 0]} />
          </Group3D>
        ))}
        {/* eyes */}
        {[-1, 1].map((s) => (
          <Mesh
            key={s}
            geometry={{ kind: 'box', width: 0.17, height: 0.34, depth: 0.08 }}
            material={eyeMat}
            position={[s * 0.44 + look * 0.1, BODY_H * 0.58 + lookY * 0.05, 0.52]}
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

  // camera: an orbit around a moving target, pushed in on the reveal, drifting after
  const az = interpolate(f, [0, 80, 180], [-26, 5, -9], { easing: ease });
  const radius = interpolate(f, [0, 80, 130, 180], [16, 11, 12, 10.8], { easing: ease });
  const camH = interpolate(f, [0, 80, 180], [2.4, 4.2, 3.8], { easing: ease });
  const tx = interpolate(f, [0, 70, 180], [-1.6, 0, 0], { easing: ease });
  const ty = interpolate(f, [0, 90, 180], [1.0, 1.7, 2.0], { easing: ease });
  const camPos: [number, number, number] = [tx + Math.sin(rad(az)) * radius, camH, Math.cos(rad(az)) * radius];

  // lights
  const la = rad(f * 2.2);
  const pulse = 0.75 + 0.25 * Math.sin(f * 0.18);

  // which orbiter Clawd watches: the chrome sphere
  const sphere = orbiterPos(f, ORBITERS[0]!, 0);
  const watching = prog(f, 66, 80);
  const look = clamp((sphere[0] - c.x) / 5.2, -1, 1) * watching;
  const lookY = clamp(sphere[1] - 1.6, -1, 1) * watching;

  // title
  const tIn = spring({ frame: f - 98, fps: FPS, config: { damping: 15, mass: 1.1, stiffness: 70 } });
  const tf = clamp(tIn, -1, 1.2);
  const titleZ = lerp(14, -2.2, tf);
  const titleY = lerp(2.2, 3.9, tf) + Math.sin(f * 0.07) * 0.06 * prog(f, 120, 135);
  const titleYaw = lerp(-200, 0, tf) + Math.sin(f * 0.05) * 3 * prog(f, 125, 140);
  const titleVisible = f >= 98;

  const shadowH = (y: number, g: number) => 1 - clamp((y - g) / 2.2) * 0.8;
  const onPlinth = 1 - prog(c.x, 1.2, 2.2, (t) => t);

  return (
    <Scene3D id="stage" width={W} height={H} effects={[glow({ radius: 34, intensity: 0.55 })]} motionBlur={{ samples: 5, shutter: 0.4 }}>
      <Camera3D fov={30} position={camPos} target={[tx, ty, 0]} />
      <AmbientLight color="#8a7bb0" intensity={0.22} />
      <DirectionalLight direction={[-0.55, -0.8, -0.65]} color="#ffb98a" intensity={1.6} />
      <DirectionalLight direction={[0.5, -0.25, 1]} color="#6fa8ff" intensity={0.55} />
      <PointLight position={[Math.cos(la) * 6, 2.6, Math.sin(la) * 4]} color="#ff4fa8" intensity={7} range={8} />
      <PointLight position={[Math.cos(-la * 1.3 + 2) * 6, 2.0, Math.sin(-la * 1.3 + 2) * 4 - 1]} color="#2fd4ff" intensity={6} range={8} />
      <PointLight position={[0, 0.9, 0]} color="#ff8a4a" intensity={9 * pulse} range={6} />

      {/* floor and plinth */}
      <Mesh geometry={{ kind: 'plane', width: 90, height: 90 }} material={{ color: '#120d0b', metallic: 0, roughness: 0.6 }} position={[0, 0, 0]} rotation={[-90, 0, 0]} />
      <Mesh geometry={{ kind: 'cylinder', radiusTop: 1.75, radiusBottom: 1.85, height: PLINTH_TOP, segments: 64 }} material={{ color: '#4a4650', metallic: 0.5, roughness: 0.35 }} position={[0, PLINTH_TOP / 2, 0]} />
      <Mesh geometry={{ kind: 'torus', radius: 1.78, tube: 0.045, tubeSegments: 12, ringSegments: 96 }} material={{ color: '#ff9a62', emissive: '#ff7a3d', emissiveIntensity: 2.6 * pulse, unlit: true }} position={[0, PLINTH_TOP, 0]} rotation={[90, 0, 0]} />
      <Mesh geometry={{ kind: 'torus', radius: 3.0, tube: 0.02, tubeSegments: 8, ringSegments: 128 }} material={{ color: '#ff9a62', emissive: '#ff7a3d', emissiveIntensity: 0.9, unlit: true, opacity: 0.55 }} position={[0, 0.02, 0]} rotation={[90, 0, 0]} />

      {/* contact shadows */}
      <Shadow x={c.x} y={0.02} z={0.05} r={1.5} o={0.75 * shadowH(c.y, 0)} />
      <Shadow x={c.x} y={PLINTH_TOP + 0.015} z={0.05} r={1.5} o={0.75 * shadowH(c.y, PLINTH_TOP) * onPlinth} />
      {ORBITERS.map((o, i) => {
        const p = orbiterPos(f, o, i);
        const s = spring({ frame: f - 3 - i * 4, fps: FPS, config: { damping: 11, stiffness: 120 } });
        return <Shadow key={i} x={p[0]} y={0.025} z={p[2]} r={0.6 * o.size * (1 - clamp((p[1] - 0.6) / 3) * 0.5)} o={0.55 * s * (1 - clamp((p[1] - 0.6) / 2.5) * 0.7)} />;
      })}

      <Clawd f={f} look={look} lookY={lookY} />

      {ORBITERS.map((o, i) => {
        const p = orbiterPos(f, o, i);
        const s = spring({ frame: f - 3 - i * 4, fps: FPS, config: { damping: 11, stiffness: 120 } });
        const squash = 1 - 0.12 * Math.max(0, 1 - p[1] / 0.9);
        return (
          <Mesh
            key={i}
            geometry={o.geometry}
            material={o.material}
            position={p}
            rotation={[o.rot[0] + f * 1.5, f * 2 + i * 40, o.rot[2]]}
            scale={[o.size * s, o.size * s * squash, o.size * s]}
          />
        );
      })}

      {titleVisible ? (
        <Text3D
          weight={500}
          font={FONT}
          size={1.15}
          depth={0.45}
          position={[0, titleY, titleZ]}
          rotation={[0, titleYaw, 0]}
          material={{ color: '#fff3e8', metallic: 0.25, roughness: 0.3, emissive: '#ffa36b', emissiveIntensity: 0.3 }}
        >
          KINETOGRAPH
        </Text3D>
      ) : null}
    </Scene3D>
  );
};

// ---- 2D over the 3D ----

const Overlay: React.FC = () => {
  const f = useCurrentFrame();
  const o = easeOut(clamp((f - 140) / 18));
  const rule = easeOut(clamp((f - 136) / 22));
  const dim = interpolate(f, [0, 8, 168, 180], [1, 0, 0, 0.9], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <>
      <Rect
        width={W}
        height={H}
        fill={{
          type: 'radial', units: 'box', cx: 0.5, cy: 0.5, r: 0.78,
          stops: [
            { offset: 0.55, color: '#00000000' },
            { offset: 1, color: '#000000d0' },
          ],
        }}
      />
      <Rect y={H - 300} width={W} height={300} fill={{ type: "linear", units: "box", x0: 0, y0: 0, x1: 0, y1: 1, stops: [{ offset: 0, color: "#00000000" }, { offset: 1, color: "#000000b0" }] }} opacity={rule} />
      <Rect x={W / 2 - 120 * rule} y={922} width={240 * rule} height={2} fill="#D97757" opacity={rule} effects={[glow({ radius: 10, intensity: 1 })]} />
      <Text font={FONT} weight={500} size={56} color="#f4e9df" align="center" x={0} y={945 + (1 - o) * 14} maxWidth={W} opacity={o} effects={[glow({ radius: 16, intensity: 0.5 })]}>
        Real 3D. No browser.
      </Text>
      <Rect width={W} height={H} fill="#000000" opacity={dim} />
    </>
  );
};

export const Showcase3D: React.FC = () => (
  <Layer effects={[grain(0.07, { seed: 11, size: 1.2 })]}>
    <Rect
      width={W}
      height={H}
      fill={{
        type: 'radial', units: 'box', cx: 0.5, cy: 0.42, r: 0.75,
        stops: [
          { offset: 0, color: '#3a2118' },
          { offset: 0.6, color: '#150e0c' },
          { offset: 1, color: '#080605' },
        ],
      }}
    />
    <Stage />
    <Overlay />
  </Layer>
);

registerRoot(() => (
  <Composition id="Showcase3D" component={Showcase3D} durationInFrames={DURATION} fps={FPS} width={W} height={H} background="#080605" />
));
