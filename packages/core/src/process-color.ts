// The colour strings `@remotion/zod-types`' `zColor` accepts, which are the ones Remotion's own colour parser takes
// (checked against the published package, test/fixtures/zod-types.json). That is wider than `colors.ts` in one way
// (`lab()`, `lch()`, `oklab()`, `oklch()`, `hwb()` with an angle unit or an alpha) and narrower in others: the string is
// taken as it is, so surrounding spaces and upper-case names or functions are errors, `rgb()` and `hsl()` take commas
// only, and an `rgb()` channel is cut to a whole number rather than rounded.

import { parseColor as parseNamedColor } from './colors.js';

const NUMBER = '[-+]?\\d*\\.?\\d+';
const PERCENT = `${NUMBER}%`;
const MODERN = `(?:none|${NUMBER}(?:%|deg|rad|grad|turn)?)`;

const legacy = (name: string, ...args: string[]) => new RegExp(`^${name}\\(\\s*(${args.join(')\\s*,\\s*(')})\\s*\\)$`);
const modern = (name: string) =>
  new RegExp(`^${name}\\(\\s*(${MODERN})\\s+(${MODERN})\\s+(${MODERN})(?:\\s*/\\s*(${MODERN}))?\\s*\\)$`);

const RGB = legacy('rgb', NUMBER, NUMBER, NUMBER);
const RGBA = legacy('rgba', NUMBER, NUMBER, NUMBER, NUMBER);
const HSL = legacy('hsl', NUMBER, PERCENT, PERCENT);
const HSLA = legacy('hsla', NUMBER, PERCENT, PERCENT, NUMBER);
const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A colour with each channel 0..1. */
type Unit = [r: number, g: number, b: number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 0xAARRGGBB from channels 0..1, each rounded. */
const pack = ([r, g, b]: Unit, alpha: number) =>
  ((Math.round(clamp01(alpha) * 255) << 24) |
    (Math.round(clamp01(r) * 255) << 16) |
    (Math.round(clamp01(g) * 255) << 8) |
    Math.round(clamp01(b) * 255)) >>>
  0;
/** 0xAARRGGBB from whole channels and an alpha byte. */
const packBytes = (r: number, g: number, b: number, a: number) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

/** `rgb()` channels: the integer part, 0..255. */
const channel = (text: string) => Math.max(0, Math.min(255, Number.parseInt(text, 10)));
/** `rgba()` and `hsla()` alpha: 0..1 as a byte; above 1 is opaque. */
const alphaByte = (text: string) => {
  const alpha = Number.parseFloat(text);
  return alpha < 0 ? 0 : alpha > 1 ? 255 : Math.round(alpha * 255);
};

function hueToChannel(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

/** Hue in degrees to a fraction of the circle. */
const turns = (degrees: number) => (((degrees % 360) + 360) % 360) / 360;
/** An `hsl()` percentage as 0..1 (it is clamped). */
const fraction = (text: string) => Math.max(0, Math.min(1, Number.parseFloat(text) / 100));

function hsl(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToChannel(p, q, h + 1 / 3), hueToChannel(p, q, h), hueToChannel(p, q, h - 1 / 3)];
}

// ---- the CSS Color 4 functions: space-separated, an angle unit on the hue, `none`, a `/ alpha` ----

/** A component: `none` is 0, a percentage is that share of `full`. */
function component(text: string, full: number): number {
  if (text === 'none') return 0;
  return text.endsWith('%') ? (Number.parseFloat(text) / 100) * full : Number.parseFloat(text);
}

/** A hue in degrees; `deg`, `rad`, `grad`, `turn` or a bare number. */
function angle(text: string): number {
  if (text === 'none') return 0;
  const value = Number.parseFloat(text);
  if (text.endsWith('rad')) return (value * 180) / Math.PI;
  if (text.endsWith('grad')) return value * 0.9;
  if (text.endsWith('turn')) return value * 360;
  return value;
}

function alphaOf(text: string | undefined): number {
  if (text === undefined || text === 'none') return 1;
  const value = Number.parseFloat(text);
  return clamp01(text.endsWith('%') ? value / 100 : value);
}

const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function fromOklab(L: number, a: number, b: number): Unit {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** CIE Lab against the D65 white point. */
function fromLab(L: number, a: number, b: number): Unit {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = (fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa) * 0.95047;
  const y = L > kappa * epsilon ? fy ** 3 : L / kappa;
  const z = (fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa) * 1.08883;
  return [
    gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

function fromHwb(h: number, w: number, black: number): Unit {
  if (w + black >= 1) return [w / (w + black), w / (w + black), w / (w + black)];
  const [r, g, b] = hsl(h, 1, 0.5);
  const scale = 1 - w - black;
  return [r * scale + w, g * scale + w, b * scale + w];
}

const OKLCH = modern('oklch');
const OKLAB = modern('oklab');
const LAB = modern('lab');
const LCH = modern('lch');
const HWB = modern('hwb');

/**
 * The colour as 0xAARRGGBB (an unsigned 32-bit number), as Remotion's `processColor` gives it. Throws
 * `invalid color string <color> provided` for anything else.
 */
export function processColor(color: string): number {
  let m: RegExpExecArray | null;
  if (typeof color === 'string') {
    if ((m = HEX.exec(color))) {
      const digits = m[1]!.length <= 4 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
      const rgba = Number.parseInt(digits.length === 6 ? `${digits}ff` : digits, 16);
      return ((rgba << 24) | (rgba >>> 8)) >>> 0;
    }
    // Only a bare lower-case word is a name (`colors.ts` lower-cases and trims, which this must not).
    if (/^[a-z]+$/.test(color)) {
      const named = color === 'burntsienna' ? { r: 0xea, g: 0x7e, b: 0x5d, a: 255 } : parseNamedColor(color);
      if (named) return packBytes(named.r, named.g, named.b, named.a);
    }
    if ((m = RGB.exec(color))) return packBytes(channel(m[1]!), channel(m[2]!), channel(m[3]!), 255);
    if ((m = RGBA.exec(color))) return packBytes(channel(m[1]!), channel(m[2]!), channel(m[3]!), alphaByte(m[4]!));
    if ((m = HSL.exec(color))) return pack(hsl(turns(Number.parseFloat(m[1]!)), fraction(m[2]!), fraction(m[3]!)), 1);
    if ((m = HSLA.exec(color))) {
      return pack(hsl(turns(Number.parseFloat(m[1]!)), fraction(m[2]!), fraction(m[3]!)), alphaByte(m[4]!) / 255);
    }
    if ((m = OKLCH.exec(color))) {
      const hue = (angle(m[3]!) * Math.PI) / 180;
      const chroma = component(m[2]!, 0.4);
      return pack(fromOklab(component(m[1]!, 1), chroma * Math.cos(hue), chroma * Math.sin(hue)), alphaOf(m[4]));
    }
    if ((m = OKLAB.exec(color))) {
      return pack(fromOklab(component(m[1]!, 1), component(m[2]!, 0.4), component(m[3]!, 0.4)), alphaOf(m[4]));
    }
    if ((m = LAB.exec(color))) {
      return pack(fromLab(component(m[1]!, 100), component(m[2]!, 125), component(m[3]!, 125)), alphaOf(m[4]));
    }
    if ((m = LCH.exec(color))) {
      const hue = (angle(m[3]!) * Math.PI) / 180;
      const chroma = component(m[2]!, 150);
      return pack(fromLab(component(m[1]!, 100), chroma * Math.cos(hue), chroma * Math.sin(hue)), alphaOf(m[4]));
    }
    if ((m = HWB.exec(color))) {
      return pack(fromHwb(angle(m[1]!) / 360, component(m[2]!, 1), component(m[3]!, 1)), alphaOf(m[4]));
    }
  }
  throw new Error(`invalid color string ${String(color)} provided`);
}
