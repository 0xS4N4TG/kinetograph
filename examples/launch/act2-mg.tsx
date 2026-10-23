// The motion-graphics run between shots 7 and 8: what the engine draws beyond type, each piece on its own API.
//
//   m1  <Scene3D>: the wordmark as extruded chrome type on a dark stage, a raking key light, the camera dollying back.
//   m2  an orthographic camera: an isometric city of blocks rising in a ripple; the camera dives into the red block.
//   m3  <GlslShader>: a frame of Fred Ott's Sneeze in heat haze, eaten by a wash of ink, its source typing on beside it.
//   m4  <Canvas>: a zoetrope: Muybridge's galloping horse (1878) in pen strokes round a drum that spins up until the
//       horse gallops in its windows, opened with an iris.
//   m5  <GlslShader>: a thick lens sliding over a woodblock print, refracting it with dispersion.
//
// m1 to m2 is a whip pan (both sides motion-blurred), m2 to m3 a dive into a red face, m3 to m4 an iris, m4 to m5 a cut.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import {
  AmbientLight, Camera3D, Canvas, DirectionalLight, GlslShader, Group3D, Layer, Mesh, PointLight, Scene3D, Text3D, glow, gradientMap, grain,
} from '@kinetograph/core';
import { CLAMP, H, INK, LEN, MONO, OUT, PAPER, RED, SANS, W } from './common.js';
import { IO } from './act1-kit.js';
import horse from './public/mg/horse.json';

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

export const M1: React.FC = () => {
  const frame = useCurrentFrame();
  const L = LEN.m1;
  // A dark stage (the floor is unlit black, so only the metal takes the light). The camera starts low on the end of
  // the chrome wordmark and dollies back along it to a three-quarter view of the whole word, while a hard key light
  // rakes across from the left and the studio picture turns, so the reflections slide over the metal.
  const k = interpolate(frame, [0, L - WHIP], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const dist = 6.2 + 4.8 * k;
  const az = rad(30 - 6 * k);
  const el = rad(5 + 8 * k);
  const target: [number, number, number] = [1.8 * (1 - k), 1.35, 0];
  const pos: [number, number, number] = [target[0] + dist * Math.sin(az) * Math.cos(el), target[1] + dist * Math.sin(el), dist * Math.cos(az) * Math.cos(el)];
  const key = rad(interpolate(frame, [0, L], [-10, 40], CLAMP));
  const fade = interpolate(frame, [0, 6], [0, 1], CLAMP);
  // the sweep: a light passing along the front of the letters, left to right, so a sheen runs over the metal
  const sweep = interpolate(frame, [10, L - WHIP], [-9, 9], { ...CLAMP, easing: Easing.inOut(Easing.sin) });

  const whip = interpolate(frame, [L - WHIP, L], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  return (
    <>
    <AbsoluteFill style={{ background: '#000' }} />
    {/* a native layer beside a DOM one goes in an AbsoluteFill, or it lands in the flow */}
    <AbsoluteFill>
    <Layer id="m1" x={-W * 0.6 * whip} opacity={fade} motionBlur={whip > 0 ? { samples: 12, shutter: 0.8 } : undefined}
      effects={[glow({ radius: 34, intensity: 0.5 }), grain(0.09, { seed: 11, animate: true })]}>
      <AbsoluteFill style={{ background: '#000' }} />
      <AbsoluteFill>
        <Scene3D id="m1-3d" width={W} height={H} environment={{ src: HDRI, intensity: 0.45, rotation: 40 + frame * 2.2 }}>
          <Camera3D fov={30} position={pos} target={target} far={600} />
          <AmbientLight intensity={0.02} />
          <DirectionalLight direction={[Math.cos(key), -0.3, Math.sin(key)]} color="#fff1dc" intensity={4.6} castShadow shadow={{ mapSize: 2048, radius: 1.5 }} />
          <DirectionalLight direction={[0.15, -0.35, 1]} color="#ffd2a0" intensity={1.6} />
          <PointLight position={[sweep, 2.2, 2.6]} color="#fff4e4" intensity={40} range={9} />
          <Mesh geometry={{ kind: 'plane', width: 400, height: 400 }} material={{ color: '#040404', unlit: true }} rotation={[-90, 0, 0]} />
          <Text3D font={SANS} weight={700} size={1.55} depth={0.55} position={[0, 0.78, 0]} material={{ color: '#b9ad9c', metallic: 1, roughness: 0.22 }} castShadow receiveShadow>
            kinetograph
          </Text3D>
        </Scene3D>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.85) 100%)' }} />
      <Plate n="01" api="<Scene3D>" what="extruded chrome, PBR, image lighting, shadows" at={40} dark />
    </Layer>
    </AbsoluteFill>
    </>
  );
};

// ---- m2: isometric ----

const GRID = 9;
/** The lit floor's colour as it renders, for the ground behind the whip-in. */
const FLOOR = '#2a2622';
const CELL = 1.1;
/** Frame the camera starts its dive into the red block that ends m2. */
export const M2_DIVE = LEN.m2 - Math.min(16, Math.round(LEN.m2 * 0.4));

const blockColor = (i: number, j: number): string => {
  if (i === 4 && j === 4) return RED;
  const r = random(`iso-${i}-${j}`);
  return r < 0.3 ? '#1c1a18' : r < 0.36 ? RED : '#e9e1d2';
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
      const rise = interpolate(frame, [d * 1.4, 8 + d * 1.4], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(1.8)) });
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
    <Layer id="m2" x={W * 0.6 * enter} motionBlur={enter > 0 ? { samples: 12, shutter: 0.8 } : undefined} effects={[glow({ radius: 30, intensity: 0.2 }), grain(0.07, { seed: 13, animate: true })]}>
      <AbsoluteFill style={{ background: FLOOR }} />
      <AbsoluteFill>
        <Scene3D id="m2-3d" width={W} height={H}>
          <Camera3D type="orthographic" height={10.5 * (1 - dive) + 0.25 * dive} position={[look[0] + dir[0]! * 30, look[1] + dir[1]! * 30, look[2] + dir[2]! * 30]} target={look} far={200} />
          <AmbientLight color="#8a9bb8" intensity={0.16} />
          <DirectionalLight direction={[-0.9, -0.3, -0.35]} color="#ffc48a" intensity={1.5} castShadow shadow={{ mapSize: 2048, radius: 1.5 }} />
          <DirectionalLight direction={[0.7, -0.5, 0.4]} color="#6f86b0" intensity={0.22} />
          <Mesh geometry={{ kind: 'plane', width: 60, height: 60 }} material={{ color: '#4a4440', roughness: 1 }} rotation={[-90, 0, 0]} receiveShadow />
          <Group3D>{blocks}</Group3D>
        </Scene3D>
      </AbsoluteFill>
      <div style={{ opacity: 1 - dive }}><Plate n="02" api='<Camera3D type="orthographic">' what="81 blocks, one ripple" at={10} dark /></div>
    </Layer>
    </AbsoluteFill>
    </>
  );
};

// ---- m3: a WebGL shader ----

const INKWASH = `precision highp float;
uniform vec2 u_res;
uniform float u_t;
uniform float u_red;
uniform sampler2D u_film;
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
/** Shot 7's film grade: luma to black, warm grey, cream. */
vec3 tone(float l) {
  vec3 a = vec3(0.024, 0.027, 0.031), b = vec3(0.49, 0.463, 0.42), c = vec3(1.0, 0.949, 0.863);
  return l < 0.5 ? mix(a, b, l * 2.0) : mix(b, c, l * 2.0 - 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * 3.0;
  float t = u_t;
  // heat haze: the air rising off the film, stronger as the shot goes on
  vec2 w = vec2(fbm(p * 2.2 + vec2(0.0, -t * 1.8)), fbm(p * 2.2 + vec2(4.1, -t * 1.8))) - 0.5;
  float haze = 0.008 + 0.03 * smoothstep(0.0, 1.6, t);
  vec2 st = (uv - 0.5) / (1.0 + 0.06 * t) + 0.5;
  float l = dot(texture2D(u_film, vec2(st.x, 1.0 - st.y) + w * haze).rgb, vec3(0.299, 0.587, 0.114));
  vec3 col = tone(l);
  // the ink: a wash that blooms in from the edges along the warped noise and eats the picture
  float f = fbm(p * 1.4 + 3.0 * w + vec2(0.0, t * 0.3));
  float edge = length((uv - 0.5) * vec2(1.3, 1.0));
  float front = f * 0.9 + edge * 0.8;
  float th = 1.45 - 1.25 * smoothstep(0.45, 2.15, t);
  float ink = smoothstep(th - 0.015, th + 0.015, front);
  float rim = smoothstep(0.05, 0.0, abs(front - th)) * (1.0 - ink * 0.6);
  col = mix(col, vec3(0.035, 0.03, 0.028), ink);
  col += rim * vec3(0.878, 0.149, 0.106) * 1.4;
  col *= 1.0 - 0.45 * dot(uv - 0.5, uv - 0.5) * 2.0;
  gl_FragColor = vec4(mix(col, vec3(0.878, 0.149, 0.106), u_red), 1.0);
}`;

/** The lines of INKWASH shown typing on beside it, and the frame typing starts. */
const CODE = [
  'vec2 w = vec2(fbm(p*2.2 - t), fbm(p*2.2 + o - t));',
  'float l = luma(texture2D(film, uv + w*haze));',
  'vec3 col = tone(l);',
  'float front = fbm(p*1.4 + 3.0*w) + edge;',
  'col = mix(col, ink, step(th, front));',
];
export const M3_TYPE = 2;
const M3_CPS = 14; // characters per frame

export const M3: React.FC = () => {
  const frame = useCurrentFrame();
  const red = interpolate(frame, [0, 4], [1, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
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
        <GlslShader id="m3-gl" width={W} height={H} fragment={INKWASH} uniforms={{ u_res: [W, H], u_t: (frame / LEN.m3) * 2.2, u_red: red }}
          textures={{ u_film: { src: staticFile('mg/fred.png'), filter: 'linear', wrap: 'mirror' } }}
          effects={[glow({ radius: 36, intensity: 0.35 }), grain(0.09, { seed: 9, animate: true })]} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 72, top: 96, padding: '28px 34px', textShadow: '0 0 10px #000, 0 0 22px #000', fontFamily: MONO, fontSize: 27, lineHeight: 1.6, color: PAPER, opacity: panel, transform: `translateY(${(1 - panel) * 16}px)`, whiteSpace: 'pre', minWidth: 720 }}>
        {shown.map((l, i) => (
          <div key={i} style={{ minHeight: 43 }}>
            {l.startsWith('col = mix') ? <span style={{ color: RED }}>{l}</span> : l}
          </div>
        ))}
      </div>
      <Plate n="03" api="<GlslShader>" what="GLSL ES on the GPU, no browser" at={10} dark />
    </AbsoluteFill>
  );
};

// ---- m4: Canvas 2D ----

/** The zoetrope's paper strip, its ink, and the drum. */
const STRIP = '#e6d7b8';
const PEN = '#1d1712';
const DRUM = '#16120f';
const RIM = '#8a7458';

/** The frames of the gallop around the drum (public/mg/horse.json, traced from Muybridge's card by tools/zoetrope). */
const NF = horse.frames.length;
const STEP = (Math.PI * 2) / NF;
/** Frames over which the drum spins up; from the end of it, it turns one frame's width per film frame. */
export const M4_SPIN = [0, Math.min(20, Math.round(LEN.m4 * 0.45))] as const;

/** How far the drum has turned at m4 frame `f`: speeding up to one STEP a frame, then holding that speed. It lands on
 *  a whole number of steps as the spin-up ends, so from there every window shows a frame square on (the strobe). */
function turned(f: number): number {
  const ramp = (g: number) => { let a = 0; for (let k = 0; k < g; k++) a += STEP * Easing.inOut(Easing.quad)(Math.min(1, k / M4_SPIN[1])); return a; };
  const end = ramp(M4_SPIN[1]);
  const whole = Math.round(end / STEP) * STEP;
  return f <= M4_SPIN[1] ? ramp(f) * (whole / end) : whole + (f - M4_SPIN[1]) * STEP;
}

export const M4: React.FC = () => {
  const frame = useCurrentFrame();
  const iris = interpolate(frame, [0, Math.min(10, LEN.m4 / 3)], [60, 1200], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const push = interpolate(frame, [Math.max(0, M4_SPIN[1] - 4), LEN.m4], [1, 2.3], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const th = turned(frame);
  const draw = (ctx: any) => {
    const cx = W / 2, cy = H / 2 + 230;
    const R = 560, ry = R * 0.3, wall = 230;
    const fw = (2 * Math.PI * R) / NF * 0.86, fh = fw * horse.aspect;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    // the push in on the far window
    const fx = cx, fy = cy - ry - wall / 2;
    ctx.translate(fx, fy);
    ctx.scale(push, push);
    ctx.translate(-fx, -fy);
    // the inside of the drum: its floor (at cy), its far wall up to the rim (at cy - wall), then the strip on that wall
    ctx.fillStyle = DRUM;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d0a08';
    ctx.beginPath();
    ctx.ellipse(cx, cy - wall, R, ry, 0, Math.PI, 0);
    ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI, true);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < NF; i++) {
      const a = -th + i * STEP;
      const s = Math.sin(a), c = Math.cos(a);
      if (s > -0.08) continue; // the near half is hidden by the near wall
      const sq = -s; // the far wall is seen square on at the back, edge on at the sides
      ctx.save();
      ctx.translate(cx + R * c, cy + ry * s - wall / 2);
      ctx.scale(sq, 1);
      ctx.fillStyle = STRIP;
      ctx.globalAlpha = Math.min(1, sq * 1.6);
      ctx.fillRect(-fw / 2 - 6, -wall / 2 + 8, fw + 12, wall - 16);
      ctx.translate(-fw / 2, -fh / 2);
      const f = horse.frames[i]!;
      ctx.strokeStyle = PEN;
      ctx.lineWidth = 1.3 / sq;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of f.hatch) { ctx.moveTo(x1 * fw, y1 * fw); ctx.lineTo(x2 * fw, y2 * fw); }
      ctx.stroke();
      ctx.lineWidth = 2.2 / sq;
      ctx.beginPath();
      for (const line of f.outline) {
        for (let k = 0; k < line.length; k += 2) (k ? ctx.lineTo : ctx.moveTo).call(ctx, line[k]! * fw, line[k + 1]! * fw);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // the shade inside the drum, darker at the sides where the wall turns away
    const shade = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0.85)');
    shade.addColorStop(0.3, 'rgba(0,0,0,0)');
    shade.addColorStop(0.7, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, cy - ry - wall, 2 * R, wall + 2 * ry);
    // the near wall, from the rim down to the floor, with its slots turning past; then the rim
    const wallFill = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
    wallFill.addColorStop(0, '#050403');
    wallFill.addColorStop(0.45, '#2a221b');
    wallFill.addColorStop(1, '#050403');
    ctx.fillStyle = wallFill;
    ctx.beginPath();
    ctx.ellipse(cx, cy - wall, R, ry, 0, 0, Math.PI);
    ctx.ellipse(cx, cy, R, ry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    for (let i = 0; i < NF; i++) {
      const a = -th + (i + 0.5) * STEP;
      const s = Math.sin(a), c = Math.cos(a);
      if (s < 0.05) continue;
      ctx.globalAlpha = Math.min(1, s * 1.5);
      ctx.fillRect(cx + R * c - 7 * s, cy + ry * s - wall + 14, 14 * s, wall * 0.42);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = RIM;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(cx, cy - wall, R, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  };
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <AbsoluteFill style={{ clipPath: `circle(${iris}px at 50% 50%)` }}>
        <Layer id="m4-zoetrope" effects={[gradientMap({ stops: [{ offset: 0, color: '#0b0806' }, { offset: 0.55, color: '#8a7458' }, { offset: 1, color: '#fff0d6' }] }), glow({ radius: 30, intensity: 0.35 }), grain(0.1, { seed: 17, animate: true })]}>
          <Canvas id="m4-canvas" width={W} height={H} draw={draw} />
        </Layer>
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 45%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.8) 100%)' }} />
        <Plate n="04" api="<Canvas>" what="Muybridge's horse, 1878, redrawn in pen strokes every frame" at={10} dark />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---- m5: glass ----

/** The print the lens looks at (public/mg/print.jpg, a public-domain woodblock print; see public/CREDITS.md), and its
 *  width over its height. */
const PRINT = staticFile('mg/print.jpg');
export const PRINT_ASPECT = 2031 / 1326;

const GLASS = `precision highp float;
uniform vec2 u_res;
uniform vec4 u_lens;
uniform float u_k;
uniform float u_ia;
uniform float u_pan;
uniform float u_zoom;
uniform sampler2D u_plate;
const vec3 L = vec3(-0.42, 0.62, 0.66);
float aspect;

/** The print, filling the frame (cover), panned up or down its height by u_pan (0 top, 1 bottom). */
vec3 plate(vec2 xy) {
  vec2 uv = vec2(xy.x / aspect, xy.y) * 0.5 / u_zoom + 0.5;
  float fill = u_ia / aspect; // below 1, the share of the print's height the frame shows when its width fills it
  if (fill < 1.0) { uv.y = (1.0 - uv.y) * fill + u_pan * (1.0 - fill); return texture2D(u_plate, uv).rgb; }
  uv.x = uv.x / fill + 0.5 * (1.0 - 1.0 / fill);
  return texture2D(u_plate, vec2(uv.x, 1.0 - uv.y)).rgb;
}
/** The lens: an ellipsoid, round in x and y and squashed by u_k in z. Its surface's normal at p. */
vec3 lensN(vec3 p) { vec3 d = p - u_lens.xyz; return normalize(vec3(d.xy, d.z / (u_k * u_k))); }
/** Where a ray meets the lens: t of the near (sgn -1) or far (sgn 1) hit, or -1. */
float hitLens(vec3 ro, vec3 rd, float sgn) {
  vec3 s = vec3(1.0, 1.0, 1.0 / u_k);
  vec3 o = (ro - u_lens.xyz) * s, d = rd * s;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - u_lens.w * u_lens.w;
  float h = b * b - a * c;
  if (h < 0.0) return -1.0;
  return (-b + sgn * sqrt(h)) / a;
}
vec3 env(vec3 d) {
  float sky = smoothstep(-0.2, 0.9, d.y);
  vec3 c = mix(vec3(0.05), vec3(0.5, 0.45, 0.38), sky);
  float box = smoothstep(0.12, 0.0, abs(d.x + 0.35) - 0.25) * smoothstep(0.1, 0.0, abs(d.y - 0.55) - 0.18);
  return c + box * 1.1;
}
/** The print at a point, with the lens's shadow and the light it gathers. */
vec3 ground(vec2 xy) {
  vec3 c = plate(xy);
  vec2 pr = u_lens.xy - L.xy * (u_lens.z / L.z);
  float d = length(xy - pr);
  float sh = 1.0 - 0.35 * smoothstep(u_lens.w * 1.25, u_lens.w * 0.6, d);
  float caustic = smoothstep(u_lens.w * 0.38, 0.0, d) * 0.22;
  return c * sh + caustic * vec3(1.0, 0.9, 0.7);
}
float channel(vec3 hit, vec3 rd, float ior, int k) {
  vec3 r1 = refract(rd, lensN(hit), 1.0 / ior);
  float t = hitLens(hit + r1 * 0.001, r1, 1.0);
  vec3 ex = hit + r1 * max(t, 0.0);
  vec3 r2 = refract(r1, -lensN(ex), ior);
  if (dot(r2, r2) < 0.001) r2 = reflect(r1, -lensN(ex));
  if (r2.z > -0.02) return env(r2)[k];
  return ground(ex.xy + r2.xy * (ex.z / -r2.z))[k];
}
vec3 shade(vec2 frag) {
  vec2 p = (frag / u_res * 2.0 - 1.0) * vec2(aspect, 1.0);
  vec3 ro = vec3(0.0, 0.0, 4.0);
  vec3 rd = normalize(vec3(p, -4.0));
  float t = hitLens(ro, rd, -1.0);
  if (t < 0.0) return ground(ro.xy + rd.xy * (ro.z / -rd.z));
  vec3 hit = ro + rd * t;
  vec3 n = lensN(hit);
  float fr = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  vec3 refr = vec3(channel(hit, rd, 1.495, 0), channel(hit, rd, 1.51, 1), channel(hit, rd, 1.53, 2));
  vec3 refl = env(reflect(rd, n));
  float spec = pow(max(dot(reflect(rd, n), normalize(L)), 0.0), 400.0) * 2.0;
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
  // A thick lens slides across the print, left to right, lifting a little, while the view drifts down the print.
  const slide = interpolate(frame, [0, LEN.m5], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.sin) });
  const lens = [-1.45 + 2.9 * slide, -0.12 + 0.14 * Math.sin(slide * Math.PI), 0.3 + 0.08 * Math.sin(slide * Math.PI), 0.62];
  const fade = interpolate(frame, [0, 6], [0, 1], CLAMP);
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <AbsoluteFill style={{ opacity: fade }}>
        <GlslShader
          id="m5-gl" width={W} height={H} fragment={GLASS}
          uniforms={{ u_res: [W, H], u_lens: lens, u_k: 0.26, u_ia: PRINT_ASPECT, u_pan: 0.25 + 0.3 * slide, u_zoom: 1.04 - 0.04 * slide }}
          textures={{ u_plate: { src: PRINT, filter: 'linear', wrap: 'mirror' } }}
          effects={[glow({ radius: 40, intensity: 0.3 }), grain(0.07, { seed: 5, animate: true })]}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.55) 100%)' }} />
      <Plate n="05" api="<GlslShader>" what="a lens, ray-traced per pixel, with dispersion" at={16} dark />
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
