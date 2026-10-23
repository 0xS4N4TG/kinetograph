// The film's looks, as layer effects: a CRT tube and a VHS tape (WGSL shaders of our own, docs/SCENE.md "shader"), and
// 1-bit, thermal and depth-map grades built from the engine's own effects. Each is a function of the frame and its
// arguments only, so a look is a pure part of the picture like everything else.

import { blur, contrast, dither, gradientMap, grayscale, shader } from '@kinetograph/core';

const HASH = /* wgsl */ `
fn kh(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453); }
`;

/** A colour tube seen face on. The layer's whole picture is bent onto the curved glass, cut to the tube's rounded face
 *  (anywhere on the canvas: outside it the layer is clear, so a bezel can sit behind), drawn in
 *  scanlines through an aperture grille, a little out of convergence, with a breathing exposure, a slow rolling bar,
 *  static and a dark falloff to the corners. Switching off folds the picture into a bright line and then a dot. */
const CRT = /* wgsl */ `${HASH}
const PI: f32 = 3.14159265;
fn effect(px: vec2<f32>) -> vec4<f32> {
  let size = globals.canvas;
  let c = size * 0.5;
  let f = globals.frame;
  // the glass: -1..1 across the tube's face (centred on cx, cy, half-size hw, hh), pushed out toward the corners; the
  // whole layer is the picture on it
  var q = (px - vec2<f32>(u.cx, u.cy)) / vec2<f32>(u.hw, u.hh);
  q = q * (1.0 + u.curve * dot(q, q));
  // the tube's rounded face
  let rr = 0.08;
  let d = length(max(abs(q) - vec2<f32>(1.0 - rr), vec2<f32>(0.0))) - rr;
  let face = 1.0 - smoothstep(-0.006, 0.0, d);
  // switching off: the raster folds to a line (offy) and the line to a dot (offx), and the beam gets brighter as it does
  let fold = vec2<f32>(max(u.offx, 0.0004), max(u.offy, 0.0004));
  let s = q / fold;
  let lit = step(abs(s.x), 1.0) * step(abs(s.y), 1.0);
  let src = c + s * c;
  // convergence: the three guns land a little apart, more toward the edges
  let cv = vec2<f32>(u.conv * (1.0 + 2.0 * abs(q.x)), 0.0);
  var col = vec3<f32>(layer(src + cv).r, layer(src).g, layer(src - cv).b);
  // the glass's softness, a little light bleeding into the next lines
  let soft = (layer(src + vec2<f32>(0.0, 2.5)).rgb + layer(src - vec2<f32>(0.0, 2.5)).rgb) * 0.5;
  col = mix(col, max(col, soft), 0.35);
  // scanlines in the source's lines: dark between beams, brighter beams for brighter picture
  let w = sin(PI * fract(src.y / u.pitch));
  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  let beam = mix(0.15 + 1.7 * w * w, 1.0, clamp(lum * 0.6, 0.0, 0.5));
  col = col * mix(1.0, beam, u.scan);
  // the aperture grille: red, green and blue stripes in the screen's own pixels
  let k = u32(floor(px.x / u.grille)) % 3u;
  var m = vec3<f32>(0.72);
  if (k == 0u) { m.x = 1.45; } else if (k == 1u) { m.y = 1.45; } else { m.z = 1.45; }
  col = col * mix(vec3<f32>(1.0), m, u.mask);
  // the exposure breathes, a bar rolls slowly down, static sits on top
  col = col * (1.0 + 0.03 * sin(f * 2.3) + 0.02 * sin(f * 0.71 + 1.0));
  let bar = smoothstep(0.0, 0.18, fract(src.y / size.y - f * 0.011)) * (1.0 - smoothstep(0.18, 0.3, fract(src.y / size.y - f * 0.011)));
  col = col * (1.0 + 0.07 * bar);
  col = col + vec3<f32>((kh(floor(px / 2.0) + vec2<f32>(f * 7.13, f * 3.71)) - 0.5) * u.noise);
  col = col * (1.0 + (1.0 / fold.y - 1.0) * 0.06 + (1.0 / fold.x - 1.0) * 0.02);
  col = col * lit;
  // dark corners, the dead glass under the face, and a faint reflection on it
  col = col * (1.0 - 0.45 * pow(dot(q, q) * 0.5, 1.6));
  let glass = vec3<f32>(0.004, 0.005, 0.0045) + vec3<f32>(0.012) * smoothstep(0.7, 0.0, length(q - vec2<f32>(-0.55, -0.6)));
  col = (max(col, vec3<f32>(0.0)) + glass * u.glass) * face;
  return vec4<f32>(col, face);
}
`;

export interface CrtOptions {
  /** The tube face's centre and half-size on the canvas, px. The default is the whole 1920x1080 frame. */
  cx?: number;
  cy?: number;
  hw?: number;
  hh?: number;
  /** How far the glass bends. 0 is flat. */
  curve?: number;
  /** Source pixels per scanline. */
  pitch?: number;
  /** 0..1: how dark between the lines. */
  scan?: number;
  /** Screen pixels per grille stripe. */
  grille?: number;
  /** 0..1: how strong the grille is. */
  mask?: number;
  /** Pixels the red and blue guns land off green. */
  conv?: number;
  noise?: number;
  glass?: number;
  /** 1 is on. Switching off: `offy` falls to 0 first (a line), then `offx` (a dot). */
  offx?: number;
  offy?: number;
}

export function crt(o: CrtOptions = {}) {
  return shader({
    code: CRT,
    uniforms: {
      cx: o.cx ?? 960, cy: o.cy ?? 540, hw: o.hw ?? 960, hh: o.hh ?? 540,
      curve: o.curve ?? 0.06, pitch: o.pitch ?? 4, scan: o.scan ?? 0.7, grille: o.grille ?? 1, mask: o.mask ?? 0.35,
      conv: o.conv ?? 1.2, noise: o.noise ?? 0.025, glass: o.glass ?? 1, offx: o.offx ?? 1, offy: o.offy ?? 1,
    },
  });
}

/** A worn VHS tape played back: the lines wobble, the colour is smeared wide and lands late beside a softened picture,
 *  the head-switching tear runs along the bottom, a band of tracking noise drifts through, snow and dropouts. */
const VHS = /* wgsl */ `${HASH}
fn effect(px: vec2<f32>) -> vec4<f32> {
  let size = globals.canvas;
  let f = globals.frame;
  let row = floor(px.y / 2.0);
  var dx = (kh(vec2<f32>(row, f)) - 0.5) * u.jitter + sin(px.y * 0.013 + f * 0.6) * u.wobble;
  // tracking: a band where the lines tear sideways
  let band = fract(u.trackAt) * (size.y + 200.0) - 100.0;
  let inband = 1.0 - smoothstep(0.0, u.trackW, abs(px.y - band));
  dx = dx + inband * (kh(vec2<f32>(row * 0.37, floor(f / 2.0))) - 0.25) * 70.0 * u.track;
  // the head switch: the last lines of the frame pulled right
  let hs = smoothstep(size.y - 26.0, size.y - 6.0, px.y);
  dx = dx + hs * (14.0 + 28.0 * kh(vec2<f32>(row, f * 0.5)));
  let p = px + vec2<f32>(dx, 0.0);
  // luma: soft along the line
  let sharp = (layer(p) * 2.0 + layer(p + vec2<f32>(1.6, 0.0)) + layer(p - vec2<f32>(1.6, 0.0))) * 0.25;
  // chroma: much wider, and late
  var ch = vec3<f32>(0.0);
  for (var i = 0; i < 8; i = i + 1) {
    ch = ch + layer(p + vec2<f32>(u.delay + u.bleed * (f32(i) / 7.0 - 0.5), 0.0)).rgb;
  }
  ch = ch / 8.0;
  let y = dot(sharp.rgb, vec3<f32>(0.299, 0.587, 0.114));
  let ci = dot(ch, vec3<f32>(0.596, -0.274, -0.322)) * u.sat;
  let cq = dot(ch, vec3<f32>(0.211, -0.523, 0.312)) * u.sat;
  var col = vec3<f32>(y + 0.956 * ci + 0.621 * cq, y - 0.272 * ci - 0.647 * cq, y - 1.106 * ci + 1.703 * cq);
  // snow, and the odd dropout: a white streak along part of a line
  col = col + vec3<f32>((kh(px + vec2<f32>(f * 3.1, f * 1.7)) - 0.5) * u.snow);
  col = col + vec3<f32>(inband * kh(vec2<f32>(px.x * 0.05, row + f)) * 0.25 * u.track);
  let drop = step(1.0 - u.drops, kh(vec2<f32>(row, floor(f)))) * step(kh(vec2<f32>(row + 1.0, f)) * size.x, px.x) * step(px.x, kh(vec2<f32>(row + 2.0, f)) * size.x + 240.0);
  col = mix(col, vec3<f32>(0.9), drop * 0.8);
  // tape blacks are never black
  col = col * 0.9 + vec3<f32>(0.018, 0.014, 0.022);
  return vec4<f32>(max(col, vec3<f32>(0.0)), 1.0);
}
`;

export interface VhsOptions {
  jitter?: number;
  wobble?: number;
  /** 0..1: where the tracking band is, top to bottom. */
  trackAt?: number;
  /** Half-height of the band, px. */
  trackW?: number;
  /** 0..1: how bad the tracking is. */
  track?: number;
  /** How wide the colour smears, px, and how late it lands. */
  bleed?: number;
  delay?: number;
  sat?: number;
  snow?: number;
  /** 0..1: chance per line per frame of a dropout. */
  drops?: number;
}

export function vhs(o: VhsOptions = {}) {
  return shader({
    code: VHS,
    padding: 0,
    uniforms: {
      jitter: o.jitter ?? 1.2, wobble: o.wobble ?? 1.5, trackAt: o.trackAt ?? 0.8, trackW: o.trackW ?? 30, track: o.track ?? 0.3,
      bleed: o.bleed ?? 14, delay: o.delay ?? 4, sat: o.sat ?? 0.85, snow: o.snow ?? 0.06, drops: o.drops ?? 0.004,
    },
  });
}

/** One bit a pixel: grey, hard contrast, an ordered dither in cells of `size` px, printed in `ink` on `paper`. */
export function oneBit({ size = 3, punch = 1.6, ink = '#050605', paper = '#d9ecd9' }: { size?: number; punch?: number; ink?: string; paper?: string } = {}) {
  return [
    grayscale(1),
    contrast(punch),
    dither(2, { mode: 'ordered', size }),
    gradientMap({ stops: [{ offset: 0, color: ink }, { offset: 1, color: paper }] }),
  ];
}

/** A thermal camera's palette (iron: cold violet through red to white-hot), a little soft as such sensors are. */
export const IRON = ['#04000f', '#2a0a6e', '#8a1197', '#d8333e', '#f77f1f', '#fcd44a', '#fffbe0'];
/** The other common one: cold blue through green to hot red and white. */
export const RAINBOW = ['#050a40', '#1336c8', '#14c6e0', '#3ee05a', '#f4e83a', '#f0461e', '#fff4f0'];

export function thermal({ palette = IRON, soft = 3 }: { palette?: string[]; soft?: number } = {}) {
  return [
    grayscale(1),
    blur(soft),
    gradientMap({ stops: palette.map((color, i) => ({ offset: i / (palette.length - 1), color })) }),
  ];
}

/** A depth map's look: near is white, far is black, smooth, no texture. Brightness stands in for nearness. */
export function depthLook({ soft = 9, punch = 1.5 }: { soft?: number; punch?: number } = {}) {
  return [
    grayscale(1),
    blur(soft),
    contrast(punch),
    gradientMap({ stops: [{ offset: 0, color: '#000000' }, { offset: 0.55, color: '#5c5c5c' }, { offset: 1, color: '#f2f2f2' }] }),
  ];
}
