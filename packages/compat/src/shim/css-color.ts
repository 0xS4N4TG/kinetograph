// CSS colours for animation (CSS Color 4): parsed to floating-point sRGB with their alpha, and mixed the way a
// browser interpolates them. Two colours written in the legacy syntaxes (hex, names, `rgb()`, `hsl()`, `hwb()`) mix in
// sRGB with premultiplied alpha and come out as `rgb()`/`rgba()`; any other pair (`oklch()`, `lab()`, `color()`) mixes
// in Oklab, the default interpolation space, and comes out as `oklab()`.

import { parseCssColor } from '@kinetographdev/scene';

export interface Color {
  /** Gamma-encoded sRGB, 0 to 1 (out of range for a colour outside sRGB). */
  rgb: [number, number, number];
  alpha: number;
  /** Written in a legacy syntax. */
  legacy: boolean;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

/** A number, a percentage of `percent`, or `none` (0). */
function value(text: string, percent: number): number | null {
  if (text === 'none') return 0;
  const m = NUMBER.exec(text);
  if (!m || (m[0].length !== text.length && text.slice(m[0].length) !== '%')) return null;
  const n = Number(m[0]);
  return text.endsWith('%') ? (n / 100) * percent : n;
}

function hue(text: string): number | null {
  if (text === 'none') return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  return unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : unit === 'turn' ? n * 360 : n;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hwbToRgb(h: number, w: number, b: number): [number, number, number] {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  return hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w) as [number, number, number];
}

const toLinear = (c: number) => {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => {
  const a = Math.abs(c);
  return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055);
};

type Vec3 = [number, number, number];
const mul = (m: number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];

// The matrices of CSS Color 4's sample code.
const XYZ_TO_LMS = [0.819022437996703, 0.3619062600528904, -0.1288737815209879, 0.0329836539323885, 0.9292868615863434, 0.0361446663506424, 0.0481771893596242, 0.2642395317527308, 0.6335478284694309];
const LMS_TO_XYZ = [1.2268798758459243, -0.5578149944602171, 0.2813910456659647, -0.0405757452148008, 1.112286803280317, -0.0717110580655164, -0.0763729366746601, -0.4214933324022432, 1.5869240198367816];
const OKLAB_TO_LMS = [1.0, 0.3963377773761749, 0.2158037573099136, 1.0, -0.1055613458156586, -0.0638541728258133, 1.0, -0.0894841775298119, -1.2914855480194092];
const LMS_TO_OKLAB = [0.210454268309314, 0.7936177747023054, -0.0040720430116193, 1.9779985324311684, -2.4285922420485799, 0.450593709617411, 0.0259040424655478, 0.7827717124575296, -0.8086757549230774];
const LIN_SRGB_TO_XYZ = [0.41239079926595934, 0.357584339383878, 0.1804807884018343, 0.21263900587151027, 0.715168678767756, 0.07219231536073371, 0.01933081871559182, 0.11919477979462598, 0.9505321522496607];
const XYZ_TO_LIN_SRGB = [3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796, 1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652, 1.0569715142428786];
const D50_TO_D65 = [0.955473421488075, -0.02309845494876471, 0.06325924320057072, -0.0283697093338637, 1.0099953980813041, 0.021041441191917323, 0.012314014864481998, -0.020507649298898964, 1.330365926242124];
const P3_TO_XYZ = [0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0.0, 0.04511338185890264, 1.043944368900976];

function oklabToRgb(L: number, a: number, b: number): Vec3 {
  const lms = mul(OKLAB_TO_LMS, [L, a, b]).map((c) => c ** 3) as Vec3;
  return mul(XYZ_TO_LIN_SRGB, mul(LMS_TO_XYZ, lms)).map(fromLinear) as Vec3;
}

function rgbToOklab(rgb: Vec3): Vec3 {
  const lms = mul(XYZ_TO_LMS, mul(LIN_SRGB_TO_XYZ, rgb.map(toLinear) as Vec3)).map(Math.cbrt) as Vec3;
  return mul(LMS_TO_OKLAB, lms);
}

function labToRgb(L: number, a: number, b: number): Vec3 {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const xyz: Vec3 = [
    (f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k) * 0.3457 / 0.3585,
    L > k * e ? ((L + 16) / 116) ** 3 : L / k,
    (f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k) * (1 - 0.3457 - 0.3585) / 0.3585,
  ];
  return mul(XYZ_TO_LIN_SRGB, mul(D50_TO_D65, xyz)).map(fromLinear) as Vec3;
}

const polar = (c: number, h: number): [number, number] => [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];

/** The channels and alpha of a colour function's arguments (commas, spaces, `/`). */
function args(body: string): { channels: string[]; alpha: string | undefined } | null {
  const [main, alpha, ...rest] = body.split('/');
  if (rest.length > 0 || main === undefined) return null;
  const channels = main.trim().split(/\s*,\s*|\s+/).filter(Boolean);
  if (alpha === undefined && channels.length === 4 && main.includes(',')) return { channels: channels.slice(0, 3), alpha: channels[3] };
  return { channels, alpha: alpha?.trim() };
}

/** A CSS colour, or null when the text is not one this reads (`currentcolor` and system colours are not). */
export function parseColor(input: string): Color | null {
  const text = input.trim().toLowerCase();
  if (text === 'transparent') return { rgb: [0, 0, 0], alpha: 0, legacy: true };
  if (/^#[0-9a-f]+$/.test(text) || /^[a-z]+$/.test(text)) {
    if (text === 'currentcolor') return null;
    const c = parseCssColor(text);
    return c === null ? null : { rgb: [c.r / 255, c.g / 255, c.b / 255], alpha: c.a, legacy: true };
  }
  const call = /^([a-z]+)\((.*)\)$/s.exec(text);
  if (!call) return null;
  const name = call[1]!;
  const parsed = args(call[2]!);
  if (parsed === null) return null;
  const alphaValue = parsed.alpha === undefined ? 1 : value(parsed.alpha, 1);
  if (alphaValue === null) return null;
  const alpha = clamp(alphaValue, 0, 1);
  const c = parsed.channels;
  if (name === 'color') {
    const space = c[0];
    const v = c.slice(1).map((t) => value(t, 1));
    if (v.length !== 3 || v.some((x) => x === null)) return null;
    const [r, g, b] = v as number[];
    if (space === 'srgb') return { rgb: [r!, g!, b!], alpha, legacy: false };
    if (space === 'srgb-linear') return { rgb: [r!, g!, b!].map(fromLinear) as Vec3, alpha, legacy: false };
    if (space === 'display-p3') {
      const lin = mul(XYZ_TO_LIN_SRGB, mul(P3_TO_XYZ, [r!, g!, b!].map(toLinear) as Vec3));
      return { rgb: lin.map(fromLinear) as Vec3, alpha, legacy: false };
    }
    return null;
  }
  if (c.length !== 3) return null;
  const legacy = name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla' || name === 'hwb';
  if (name === 'rgb' || name === 'rgba') {
    const v = c.map((t) => value(t, 255));
    if (v.some((x) => x === null)) return null;
    return { rgb: v.map((x) => clamp(x!, 0, 255) / 255) as Vec3, alpha, legacy };
  }
  if (name === 'hsl' || name === 'hsla' || name === 'hwb') {
    const h = hue(c[0]!);
    const s = value(c[1]!, 100);
    const l = value(c[2]!, 100);
    if (h === null || s === null || l === null) return null;
    const rgb = name === 'hwb' ? hwbToRgb(h, clamp(s / 100, 0, 1), clamp(l / 100, 0, 1)) : hslToRgb(h, clamp(s / 100, 0, 1), clamp(l / 100, 0, 1));
    return { rgb, alpha, legacy };
  }
  if (name === 'lab' || name === 'lch') {
    const L = value(c[0]!, 100);
    if (L === null) return null;
    let a: number | null;
    let b: number | null;
    if (name === 'lab') {
      a = value(c[1]!, 125);
      b = value(c[2]!, 125);
    } else {
      const chroma = value(c[1]!, 150);
      const h = hue(c[2]!);
      if (chroma === null || h === null) return null;
      [a, b] = polar(chroma, h);
    }
    if (a === null || b === null) return null;
    return { rgb: labToRgb(L, a, b), alpha, legacy: false };
  }
  if (name === 'oklab' || name === 'oklch') {
    const L = value(c[0]!, 1);
    if (L === null) return null;
    let a: number | null;
    let b: number | null;
    if (name === 'oklab') {
      a = value(c[1]!, 0.4);
      b = value(c[2]!, 0.4);
    } else {
      const chroma = value(c[1]!, 0.4);
      const h = hue(c[2]!);
      if (chroma === null || h === null) return null;
      [a, b] = polar(chroma, h);
    }
    if (a === null || b === null) return null;
    return { rgb: oklabToRgb(L, a, b), alpha, legacy: false };
  }
  return null;
}

const round = (v: number, places: number) => {
  const r = Number(v.toFixed(places));
  return Object.is(r, -0) ? 0 : r;
};

/** A colour as CSS text: `rgb()`/`rgba()` for the legacy syntaxes, `oklab()` for the rest. */
export function formatColor(c: Color): string {
  if (c.legacy) {
    const [r, g, b] = c.rgb.map((v) => round(clamp(v, 0, 1) * 255, 4));
    return c.alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(c.alpha, 6)})`;
  }
  const [L, a, b] = rgbToOklab(c.rgb);
  return `oklab(${round(L!, 6)} ${round(a!, 6)} ${round(b!, 6)}${c.alpha < 1 ? ` / ${round(c.alpha, 6)}` : ''})`;
}

/** The colour `p` of the way from `a` to `b` (premultiplied; in sRGB for two legacy colours, else in Oklab). */
export function mixColors(a: Color, b: Color, p: number): Color {
  const alpha = a.alpha + (b.alpha - a.alpha) * p;
  const legacy = a.legacy && b.legacy;
  const ca = legacy ? a.rgb : rgbToOklab(a.rgb);
  const cb = legacy ? b.rgb : rgbToOklab(b.rgb);
  const mixed = [0, 1, 2].map((i) => {
    const v = ca[i]! * a.alpha + (cb[i]! * b.alpha - ca[i]! * a.alpha) * p;
    return alpha === 0 ? 0 : v / alpha;
  }) as Vec3;
  const out = clamp(alpha, 0, 1);
  return { rgb: legacy ? mixed : oklabToRgb(mixed[0], mixed[1], mixed[2]), alpha: out, legacy };
}

/** `a` and `b` added, as `composite: 'add'` adds colours: each premultiplied channel summed. */
export function addColors(a: Color, b: Color): Color {
  const alpha = clamp(a.alpha + b.alpha, 0, 1);
  const rgb = [0, 1, 2].map((i) => (alpha === 0 ? 0 : clamp(a.rgb[i]! * a.alpha + b.rgb[i]! * b.alpha, 0, 1) / alpha)) as Vec3;
  return { rgb, alpha, legacy: a.legacy && b.legacy };
}
