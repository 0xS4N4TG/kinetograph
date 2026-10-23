// The motion-graphics run between shots 7 and 8: what the engine draws beyond type, each piece on its own API.
//
//   m1  <Scene3D>: the wordmark as extruded 3D type, a dolly zoom out of a flat front view, props dropping in.
//   m2  an orthographic camera: an isometric city of blocks rising in a ripple; the camera dives into the red block.
//   m3  <GlslShader>: domain-warped marbling seen through a thermal camera's palette, its source typing on beside it.
//   m4  <Canvas>: a flow field of 2,000 strokes and a spirograph, drawn in phosphor on a vector tube (with the beam's
//       afterglow), opened with an iris.
//   m5  <GlslShader>: three glass spheres refracting (with dispersion) a frame of the 1927 parade film, the camera
//       pulling back, graded with shot 7's film.
//
// m1 to m2 is a whip pan (both sides motion-blurred), m2 to m3 a dive into a red face, m3 to m4 an iris, m4 to m5 a cut.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import {
  AmbientLight, Camera3D, Canvas, DirectionalLight, GlslShader, Group3D, Layer, Mesh, Scene3D, Text3D, glow, gradientMap, grain,
} from '@kinetograph/core';
import { crt, thermal } from './looks.js';
import { CLAMP, H, INK, LEN, MONO, MUSTARD, OUT, PAPER, RED, SANS, W } from './common.js';
import { IO } from './act1-kit.js';

const rad = (d: number) => (d * Math.PI) / 180;
const HDRI = staticFile('hdri/studio_small_08_1k.hdr');

/** Frames of the whip pan on each side of the m1 to m2 cut. */
export const WHIP = 7;

/** The API plate in the corner of every shot: a red square, the element, and what it is drawing. */
const Plate: React.FC<{ n: string; api: string; what: string; at?: number; dark?: boolean }> = ({ n, api, what, at = 4, dark }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [at, at + 8], [0, 1], { ...CLAMP, easing: OUT });
  const fg = dark ? PAPER : INK;
  return (
    <div style={{ position: 'absolute', left: 72, bottom: 64, display: 'flex', alignItems: 'center', gap: 16, fontFamily: MONO, fontSize: 24, color: fg, opacity: t, transform: `translateX(${(1 - t) * -24}px)` }}>
      <div style={{ width: 14, height: 14, background: RED }} />
      <span style={{ opacity: 0.55 }}>{n}</span>
      <span style={{ fontWeight: 500 }}>{api}</span>
      <span style={{ opacity: 0.55 }}>{what}</span>
    </div>
  );
};

// ---- m1: real 3D ----

/** A prop that falls onto the floor at `at` and settles with a damped bounce. */
function drop(frame: number, at: number, rest: number): { y: number; sq: number; on: boolean } {
  const t = frame - at;
  if (t < 0) return { y: rest + 8, sq: 0, on: false };
  const fall = 10;
  if (t < fall) return { y: rest + 8 * (1 - (t / fall) ** 2), sq: -0.08, on: true };
  const k = t - fall;
  const sq = 0.22 * Math.exp(-k / 4) * Math.cos(k * 0.9);
  return { y: rest - Math.max(0, sq) * 0.2 + Math.abs(Math.sin(k * 0.45)) * 0.7 * Math.exp(-k / 3.5), sq, on: true };
}

/** Frames the props land in m1 ("real 3D"). */
export const M1_DROPS = [55, 60, 64, 69];

export const M1: React.FC = () => {
  const frame = useCurrentFrame();
  const L = LEN.m1;
  // The dolly zoom: from far away with a long lens (the type looks flat, as the 2D line before it) to close with a
  // wide one, keeping the wordmark the same width, while the camera swings round 38 degrees and lifts.
  // The reveal starts flat on "way past text" and turns all the way through "real 3D" (07c-past at 2, m1-3d at 46).
  const k = interpolate(frame, [6, 64], [0, 1], { ...CLAMP, easing: IO });
  const drift = interpolate(frame, [64, L], [0, 1], CLAMP);
  const fov = 7 + 29 * k;
  const dist = 3.4 / Math.tan(rad(fov / 2)) - drift * 0.7; // distance x tan(fov / 2) held, so the type keeps its width
  const az = rad(-2 + 28 * k + 6 * drift);
  const el = rad(8 + 15 * k + 2 * drift); // above the horizon from the first frame
  const target: [number, number, number] = [0, 0.75, 0];
  const pos: [number, number, number] = [dist * Math.sin(az) * Math.cos(el), target[1] + dist * Math.sin(el), dist * Math.cos(az) * Math.cos(el)];

  const whip = interpolate(frame, [L - WHIP, L], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const props = [
    { geometry: { kind: 'sphere' as const, radius: 0.55, segments: 64, rings: 32 }, material: { color: '#d8d8d8', metallic: 1, roughness: 0.08 }, x: -3.4, z: 1.6, rest: 0.55 },
    { geometry: { kind: 'torus' as const, radius: 0.48, tube: 0.18, ringSegments: 64 }, material: { color: MUSTARD, roughness: 0.35 }, x: 3.1, z: 1.9, rest: 0.66 },
    { geometry: { kind: 'cylinder' as const, radiusTop: 0, radiusBottom: 0.45, height: 1.1, segments: 48 }, material: { color: INK, roughness: 0.4 }, x: 4.4, z: 0.2, rest: 0.55 },
    { geometry: { kind: 'box' as const, width: 0.8, height: 0.8, depth: 0.8 }, material: { color: PAPER, roughness: 0.6 }, x: -4.6, z: 0.1, rest: 0.4 },
  ];
  return (
    <>
    <AbsoluteFill style={{ background: PAPER }} />
    {/* a native layer beside a DOM one goes in an AbsoluteFill, or it lands in the flow */}
    <AbsoluteFill>
    <Layer id="m1" x={-W * 0.6 * whip} motionBlur={whip > 0 ? { samples: 12, shutter: 0.8 } : undefined}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 80% 80% at 50% 40%, #F6F5F2 0%, ${PAPER} 50%, #CFCCC7 100%)` }} />
      <AbsoluteFill>
        <Scene3D id="m1-3d" width={W} height={H} environment={{ src: HDRI, intensity: 0.55 }}>
          <Camera3D fov={fov} position={pos} target={target} far={6000} />
          <AmbientLight intensity={0.25} />
          <DirectionalLight direction={[0.5, -0.9, -0.55]} intensity={1.5} castShadow shadow={{ mapSize: 2048, radius: 2.5 }} />
          <DirectionalLight direction={[-0.7, -0.3, -0.6]} intensity={0.5} />
          <Mesh geometry={{ kind: 'plane', width: 4000, height: 4000 }} material={{ color: '#bcb8b1', roughness: 0.95 }} rotation={[-90, 0, 0]} receiveShadow />
          <Text3D font={SANS} weight={700} size={1.55} depth={0.55} position={[0, 0.78, 0]} material={{ color: RED, roughness: 0.32 }} castShadow receiveShadow>
            kinetograph
          </Text3D>
          {props.map((p, i) => {
            const d = drop(frame, M1_DROPS[i]!, p.rest);
            const spin = i === 1 ? frame * 4 : i === 2 ? 0 : (frame - M1_DROPS[i]!) * 1.5;
            return (
              <Mesh
                key={i} geometry={p.geometry} material={p.material} visible={d.on} castShadow receiveShadow
                position={[p.x, d.y, p.z]} rotation={i === 1 ? [70, spin, 0] : [0, spin, 0]} scale={[1 + d.sq * 0.5, 1 - d.sq, 1 + d.sq * 0.5]}
              />
            );
          })}
        </Scene3D>
      </AbsoluteFill>
      <Plate n="01" api="<Scene3D>" what="extruded type, PBR, image lighting, shadows" at={52} />
    </Layer>
    </AbsoluteFill>
    </>
  );
};

// ---- m2: isometric ----

const GRID = 9;
/** The lit floor's colour as it renders, for the ground behind the whip-in. */
const FLOOR = '#E1AF33';
const CELL = 1.1;
/** Frame the camera starts its dive into the red block that ends m2. */
export const M2_DIVE = LEN.m2 - 16;

const blockColor = (i: number, j: number): string => {
  if (i === 4 && j === 4) return RED;
  const r = random(`iso-${i}-${j}`);
  return r < 0.12 ? INK : r < 0.24 ? MUSTARD : r < 0.3 ? RED : PAPER;
};

export const M2: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, WHIP], [1, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const yaw = 45 + interpolate(frame, [0, LEN.m2], [-18, 22], { ...CLAMP, easing: Easing.inOut(Easing.sin) });
  const dive = interpolate(frame, [M2_DIVE, LEN.m2], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const centreH = 1.2 + 2.6 * interpolate(frame, [M2_DIVE - 20, M2_DIVE], [0, 1], { ...CLAMP, easing: IO });
  const look: [number, number, number] = [0, dive * centreH, 0];
  const dir = [Math.sin(rad(yaw)), Math.tan(rad(35.264)), Math.cos(rad(yaw))];
  const blocks: React.ReactNode[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const di = i - 4;
      const dj = j - 4;
      const d = Math.hypot(di, dj);
      const rise = interpolate(frame, [2 + d * 3, 14 + d * 3], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.8)) });
      const wave = 0.5 + 0.5 * Math.sin(frame * 0.16 - d * 0.9);
      const base = 0.35 + random(`isoh-${i}-${j}`) * 1.3;
      let h = Math.max(0.02, rise * (base + wave * 0.9));
      if (di === 0 && dj === 0) h = Math.max(0.02, rise * centreH);
      blocks.push(
        <Mesh
          key={`${i}-${j}`} geometry={{ kind: 'box', width: CELL * 0.86, height: 1, depth: CELL * 0.86 }}
          material={{ color: blockColor(i, j), roughness: 0.7 }} castShadow receiveShadow
          position={[di * CELL, h / 2, dj * CELL]} scale={[1, h, 1]}
        />,
      );
    }
  }
  return (
    <>
    <AbsoluteFill style={{ background: FLOOR }} />
    {/* a native layer beside a DOM one goes in an AbsoluteFill, or it lands in the flow */}
    <AbsoluteFill>
    <Layer id="m2" x={W * 0.6 * enter} motionBlur={enter > 0 ? { samples: 12, shutter: 0.8 } : undefined}>
      <AbsoluteFill style={{ background: FLOOR }} />
      <AbsoluteFill>
        <Scene3D id="m2-3d" width={W} height={H}>
          <Camera3D type="orthographic" height={10.5 * (1 - dive) + 0.25 * dive} position={[look[0] + dir[0]! * 30, look[1] + dir[1]! * 30, look[2] + dir[2]! * 30]} target={look} far={200} />
          <AmbientLight intensity={0.3} />
          <DirectionalLight direction={[-0.35, -1, -0.6]} intensity={1.05} castShadow shadow={{ mapSize: 2048, radius: 1.5 }} />
          <DirectionalLight direction={[0.8, -0.4, 0.3]} intensity={0.35} />
          <Mesh geometry={{ kind: 'plane', width: 60, height: 60 }} material={{ color: '#c99a1e', roughness: 1 }} rotation={[-90, 0, 0]} receiveShadow />
          <Group3D>{blocks}</Group3D>
        </Scene3D>
      </AbsoluteFill>
      <div style={{ opacity: 1 - dive }}><Plate n="02" api='<Camera3D type="orthographic">' what="81 blocks, one ripple" at={10} /></div>
    </Layer>
    </AbsoluteFill>
    </>
  );
};

// ---- m3: a WebGL shader ----

const MARBLE = `precision highp float;
uniform vec2 u_res;
uniform float u_t;
uniform float u_red;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
float field(vec2 p, out vec2 q, out vec2 r) {
  q = vec2(fbm(p + vec2(0.0, 0.0) + 0.12 * u_t), fbm(p + vec2(5.2, 1.3) - 0.1 * u_t));
  r = vec2(fbm(p + 3.6 * q + vec2(1.7, 9.2) + 0.3 * u_t), fbm(p + 3.6 * q + vec2(8.3, 2.8) - 0.24 * u_t));
  return fbm(p + 3.6 * r);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float zoom = 2.2 - 0.5 * smoothstep(0.0, 3.0, u_t);
  p = p * zoom + vec2(0.3 * u_t, 0.1 * u_t);
  vec2 q, r;
  float f = field(p, q, r);
  vec2 q2, r2;
  float fx = field(p + vec2(0.004, 0.0), q2, r2);
  float fy = field(p + vec2(0.0, 0.004), q2, r2);
  vec3 n = normalize(vec3((f - fx) * 90.0, (f - fy) * 90.0, 1.0));
  vec3 ink = vec3(0.067), red = vec3(0.878, 0.149, 0.106), mus = vec3(0.851, 0.651, 0.129), pap = vec3(0.925, 0.918, 0.902);
  vec3 col = mix(ink, red, smoothstep(0.25, 0.62, f));
  col = mix(col, mus, smoothstep(0.55, 0.95, length(q) * f * 1.4));
  col = mix(col, pap, smoothstep(0.62, 0.9, r.x * f * 1.5));
  col = mix(col, ink, smoothstep(0.5, 0.9, 1.0 - r.y) * 0.55);
  vec3 l = normalize(vec3(-0.5, 0.6, 0.8));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0);
  col = col * (0.75 + 0.35 * max(dot(n, l), 0.0)) + spec * 0.45;
  col *= 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 2.0;
  gl_FragColor = vec4(mix(col, red, u_red), 1.0);
}`;

/** The lines of MARBLE shown typing on beside it, and the frame typing starts. */
const CODE = [
  'float field(vec2 p) {',
  '  q = vec2(fbm(p + 0.12*t), fbm(p + o - 0.1*t));',
  '  r = vec2(fbm(p + 3.6*q + a), fbm(p + 3.6*q + b));',
  '  return fbm(p + 3.6*r);',
  '}',
  'col = mix(ink, red, smoothstep(.25, .62, f));',
];
export const M3_TYPE = 8;
const M3_CPS = 2.4; // characters per frame

export const M3: React.FC = () => {
  const frame = useCurrentFrame();
  const red = interpolate(frame, [0, 7], [1, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  let budget = Math.max(0, (frame - M3_TYPE) * M3_CPS);
  const shown = CODE.map((l) => {
    const s = l.slice(0, Math.max(0, Math.min(l.length, Math.floor(budget))));
    budget -= l.length;
    return s;
  });
  const panel = interpolate(frame, [4, 12], [0, 1], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill style={{ background: INK }}>
      <AbsoluteFill>
        <GlslShader id="m3-gl" width={W} height={H} fragment={MARBLE} uniforms={{ u_res: [W, H], u_t: frame / 30, u_red: red }} effects={thermal({ soft: 2 })} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 72, top: 96, padding: '28px 34px', background: 'rgba(10,10,10,0.72)', borderRadius: 14, fontFamily: MONO, fontSize: 27, lineHeight: 1.6, color: PAPER, opacity: panel, transform: `translateY(${(1 - panel) * 16}px)`, whiteSpace: 'pre', minWidth: 720 }}>
        {shown.map((l, i) => (
          <div key={i} style={{ minHeight: 43 }}>
            {l.startsWith('col') ? <span style={{ color: MUSTARD }}>{l}</span> : l}
          </div>
        ))}
      </div>
      <Plate n="03" api="<GlslShader>" what="GLSL ES on the GPU, no browser" at={10} dark />
    </AbsoluteFill>
  );
};

// ---- m4: Canvas 2D ----

/** The vector tube's dark glass, its green phosphor and the amber of the hot strokes. */
const TUBE = '#020604';
const PHOSPHOR = '#8dffbf';
const AMBER = '#ffb54a';

/** The flow field's angle at a point: three slow waves, turning over time. */
const flow = (x: number, y: number, t: number) =>
  Math.sin(x * 0.0042 + t * 0.9) * 1.7 + Math.cos(y * 0.0051 - t * 0.6) * 1.7 + Math.sin((x + y) * 0.0021 + t * 0.4);

/** Frames the spirograph draws over, inside m4. */
export const M4_SPIRO = [8, 44] as const;

export const M4: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const iris = interpolate(frame, [0, 10], [60, 1200], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const spiro = interpolate(frame, [...M4_SPIRO], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.quad) });
  const disc = interpolate(frame, [4, 14], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.5)) });
  const draw = (ctx: any) => {
    ctx.fillStyle = TUBE;
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round';
    const STEP = 30;
    // the field now and, fainter, a frame and two frames ago: the phosphor's afterglow behind the beam
    for (const [lag, alpha] of [[2, 0.12], [1, 0.32], [0, 1]] as const) {
      const tt = t - lag / 30;
      ctx.globalAlpha = alpha;
      for (const colour of [PHOSPHOR, AMBER]) {
        ctx.beginPath();
        for (let gx = STEP / 2; gx < W; gx += STEP) {
          for (let gy = STEP / 2; gy < H; gy += STEP) {
            const hot = random(`ff-${gx}-${gy}`) < 0.05;
            if ((colour === AMBER) !== hot) continue;
            const a = flow(gx, gy, tt);
            const grow = interpolate(Math.hypot(gx - W / 2, gy - H / 2), [0, 1100], [0, 1]) < (frame - lag) / 14 ? 1 : 0;
            const len = grow * (12 + 18 * (0.5 + 0.5 * Math.sin(gx * 0.013 + gy * 0.011 + tt * 2)));
            ctx.moveTo(gx - (Math.cos(a) * len) / 2, gy - (Math.sin(a) * len) / 2);
            ctx.lineTo(gx + (Math.cos(a) * len) / 2, gy + (Math.sin(a) * len) / 2);
          }
        }
        ctx.strokeStyle = colour;
        ctx.lineWidth = colour === AMBER ? 3.2 : 2.2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // the disc and the spirograph on it (a hypotrochoid, R 8, r 5, d 5: eight lobes, closes after five turns)
    const cx = W / 2 + 230;
    const cy = H / 2;
    ctx.fillStyle = TUBE;
    ctx.beginPath();
    ctx.arc(cx, cy, 330 * disc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PHOSPHOR;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const N = 1500;
    const upto = Math.floor(N * spiro);
    if (upto > 1) {
      ctx.beginPath();
      for (let k = 0; k <= upto; k++) {
        const th = (k / N) * Math.PI * 10;
        const x = 3 * Math.cos(th) + 5 * Math.cos((3 / 5) * th);
        const y = 3 * Math.sin(th) - 5 * Math.sin((3 / 5) * th);
        const px = cx + x * 36 * Math.cos(t * 0.6) - y * 36 * Math.sin(t * 0.6);
        const py = cy + x * 36 * Math.sin(t * 0.6) + y * 36 * Math.cos(t * 0.6);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };
  return (
    <AbsoluteFill style={{ background: INK }}>
      <AbsoluteFill style={{ clipPath: `circle(${iris}px at 50% 50%)` }}>
        <Layer id="m4-tube" effects={[glow({ radius: 16, intensity: 0.9, color: PHOSPHOR }), crt({ curve: 0.05, pitch: 3, scan: 0.5, mask: 0.22, conv: 0.8, glass: 0 })]}>
          <Canvas id="m4-canvas" width={W} height={H} draw={draw} />
        </Layer>
        <Plate n="04" api="<Canvas>" what="2,000 strokes and a spirograph, drawn every frame" at={10} dark />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---- m5: glass ----

/** Shot 7's film grade (act2-s07.tsx), so the glass looks at the same 1927 film. */
const FILM_TONE = [{ offset: 0, color: '#060708' }, { offset: 0.5, color: '#7d766b' }, { offset: 1, color: '#fff2dc' }];

const GLASS = `precision highp float;
uniform vec2 u_res;
uniform float u_cz;
uniform vec4 u_s0;
uniform vec4 u_s1;
uniform vec4 u_s2;
uniform sampler2D u_plate;
const vec3 L = vec3(-0.42, 0.62, 0.66);
float aspect;

vec3 plate(vec2 xy) {
  vec2 uv = vec2(xy.x / aspect, xy.y) * 0.5 + 0.5;
  return texture2D(u_plate, vec2(uv.x, 1.0 - uv.y)).rgb;
}
float hitSphere(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  return -b - sqrt(h);
}
vec3 env(vec3 d) {
  float sky = smoothstep(-0.2, 0.9, d.y);
  vec3 c = mix(vec3(0.55, 0.53, 0.5), vec3(1.0), sky);
  float box = smoothstep(0.12, 0.0, abs(d.x + 0.35) - 0.25) * smoothstep(0.1, 0.0, abs(d.y - 0.55) - 0.18);
  return c + box * 2.5;
}
/** What the plate shows at a point, with the spheres' shadows and the light they focus. */
vec3 ground(vec2 xy) {
  vec3 c = plate(xy);
  float sh = 1.0;
  float caustic = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 s = i == 0 ? u_s0 : i == 1 ? u_s1 : u_s2;
    vec2 pr = s.xy - L.xy * (s.z / L.z);
    float d = length(xy - pr);
    sh *= 1.0 - 0.32 * smoothstep(s.w * 1.35, s.w * 0.5, d);
    caustic += smoothstep(s.w * 0.42, 0.0, d) * 0.55;
  }
  return c * sh + caustic * vec3(1.0, 0.92, 0.75);
}
float channel(vec3 hit, vec3 rd, vec4 s, float ior, int k) {
  vec3 n = normalize(hit - s.xyz);
  vec3 r1 = refract(rd, n, 1.0 / ior);
  vec3 oc = hit - s.xyz;
  vec3 ex = hit + r1 * (-2.0 * dot(oc, r1));
  vec3 n2 = normalize(ex - s.xyz);
  vec3 r2 = refract(r1, -n2, ior);
  if (dot(r2, r2) < 0.001) r2 = reflect(r1, -n2);
  if (r2.z > -0.02) return env(r2)[k];
  vec2 xy = ex.xy + r2.xy * (ex.z / -r2.z);
  return ground(xy)[k];
}
vec3 shade(vec2 frag) {
  vec2 p = (frag / u_res * 2.0 - 1.0) * vec2(aspect, 1.0);
  vec3 ro = vec3(0.0, 0.0, u_cz);
  vec3 rd = normalize(vec3(p, -4.0));
  float best = 1e9;
  vec4 hs = vec4(0.0);
  for (int i = 0; i < 3; i++) {
    vec4 s = i == 0 ? u_s0 : i == 1 ? u_s1 : u_s2;
    float t = hitSphere(ro, rd, s);
    if (t > 0.0 && t < best) { best = t; hs = s; }
  }
  if (best > 1e8) return ground(ro.xy + rd.xy * (ro.z / -rd.z));
  vec3 hit = ro + rd * best;
  vec3 n = normalize(hit - hs.xyz);
  float fr = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  vec3 refr = vec3(channel(hit, rd, hs, 1.46, 0), channel(hit, rd, hs, 1.5, 1), channel(hit, rd, hs, 1.55, 2));
  refr *= vec3(0.97, 0.985, 1.0);
  vec3 refl = env(reflect(rd, n));
  float spec = pow(max(dot(reflect(rd, n), normalize(L)), 0.0), 220.0) * 3.0;
  return mix(refr, refl, fr) + spec;
}
void main() {
  aspect = u_res.x / u_res.y;
  vec3 c = vec3(0.0);
  c += shade(gl_FragCoord.xy + vec2(-0.25, -0.25));
  c += shade(gl_FragCoord.xy + vec2(0.25, -0.25));
  c += shade(gl_FragCoord.xy + vec2(-0.25, 0.25));
  c += shade(gl_FragCoord.xy + vec2(0.25, 0.25));
  gl_FragColor = vec4(clamp(c * 0.25, 0.0, 1.0), 1.0);
}`;

export const M5: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  // The camera starts pressed up against the big sphere and pulls back to the plate's full frame.
  const back = interpolate(frame, [0, 34], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const cz = 1.75 + 2.25 * back;
  const roll = interpolate(frame, [0, LEN.m5], [0.55, -0.45], { ...CLAMP, easing: Easing.inOut(Easing.sin) });
  const s0 = [roll, -0.05 + 0.03 * Math.sin(t * 2.1), 0.62, 0.52];
  const s1 = [roll + 0.95 * Math.cos(t * 1.6 + 0.6), 0.32 * Math.sin(t * 1.6 + 0.6) + 0.28, 0.75, 0.2];
  const s2 = [-1.15 + 0.12 * Math.sin(t * 1.3), -0.45 + 0.1 * Math.cos(t * 1.7), 0.5, 0.3];
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <AbsoluteFill>
        <GlslShader
          id="m5-gl" width={W} height={H} fragment={GLASS}
          uniforms={{ u_res: [W, H], u_cz: cz, u_s0: s0, u_s1: s1, u_s2: s2 }}
          textures={{ u_plate: { src: staticFile('receipts/crowd.png'), filter: 'linear', wrap: 'mirror' } }}
          effects={[gradientMap({ stops: FILM_TONE }), glow({ radius: 40, intensity: 0.3 }), grain(0.08, { seed: 5, animate: true })]}
        />
      </AbsoluteFill>
      <Plate n="05" api="<GlslShader>" what="refraction with dispersion, ray-traced per pixel" at={16} dark />
    </AbsoluteFill>
  );
};

// ---- the plate the glass looks at (rendered once to public/mg/glass-plate.png from plates.tsx) ----

export const GlassPlate: React.FC = () => (
  <AbsoluteFill style={{ background: PAPER }}>
    {Array.from({ length: 27 }, (_, i) => (
      <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: 20 + i * 40, height: 2, background: 'rgba(17,17,17,0.13)' }} />
    ))}
    <div style={{ position: 'absolute', left: 0, right: 0, top: 360, textAlign: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 300, lineHeight: 1, color: INK }}>
      kinetograph<span style={{ color: RED }}>.</span>
    </div>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 720, textAlign: 'center', fontFamily: MONO, fontSize: 34, color: INK, letterSpacing: '0.3em' }}>
      WRITE REMOTION · RENDER NATIVE
    </div>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 860, height: 90, background: `repeating-linear-gradient(90deg, ${RED} 0 46px, ${PAPER} 46px 92px)` }} />
    <div style={{ position: 'absolute', left: 0, right: 0, top: 130, height: 90, background: `repeating-linear-gradient(90deg, ${INK} 0 46px, ${PAPER} 46px 92px)` }} />
  </AbsoluteFill>
);
