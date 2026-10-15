// CSS colours (CSS Color 4 as Chrome reads them): named colours, hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `hwb()`,
// `transparent` and `currentcolor`. Channels round to 8 bits, as Chrome stores them.

import { NAMED_COLORS } from './named-colors.js';
import { type Tok, fail, lex } from './tokens.js';
import type { ColorValue, Rgba } from './types.js';
import { angleOf, isAngle } from './values.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const channel = (v: number): number => clamp(Math.round(v), 0, 255);

const NOT_SUPPORTED_COLOR_FUNCTIONS = new Set([
  'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'device-cmyk',
]);

/**
 * A colour token, or `null` when the token is not a colour at all (so a caller can try something else). A token that is
 * clearly meant as a colour but malformed (`#12`, `rgb(1)`) throws.
 */
export function colorOf(t: Tok | undefined): ColorValue | null {
  if (!t) return null;
  if (t.type === 'ident') {
    if (t.name === 'currentcolor') return 'currentcolor';
    if (Object.hasOwn(NAMED_COLORS, t.name)) return unpack(NAMED_COLORS[t.name]!);
    return null;
  }
  if (t.type === 'hash') return hex(t.str, t.text);
  if (t.type === 'function') {
    switch (t.name) {
      case 'rgb':
      case 'rgba': return rgb(t);
      case 'hsl':
      case 'hsla': return hsl(t);
      case 'hwb': return hwb(t);
      default:
        if (NOT_SUPPORTED_COLOR_FUNCTIONS.has(t.name)) return fail(`the colour function ${t.name}() is not supported`);
        return null;
    }
  }
  return null;
}

/** A colour token that must be one. */
export function requireColor(t: Tok | undefined): ColorValue {
  const c = colorOf(t);
  if (c === null) return fail(`expected a colour${t ? `, found \`${t.text}\`` : ''}`);
  return c;
}

function unpack(n: number): Rgba {
  return { r: Math.floor(n / 0x1000000) & 0xff, g: Math.floor(n / 0x10000) & 0xff, b: Math.floor(n / 0x100) & 0xff, a: (n % 0x100) / 255 };
}

function hex(digits: string, text: string): Rgba {
  if (!/^[0-9a-fA-F]+$/.test(digits) || ![3, 4, 6, 8].includes(digits.length)) return fail(`\`${text}\` is not a hex colour`);
  const full = digits.length <= 4 ? [...digits].map((c) => c + c).join('') : digits;
  const byte = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return { r: byte(0), g: byte(1), b: byte(2), a: full.length === 8 ? byte(3) / 255 : 1 };
}

interface Components {
  parts: Tok[];
  alpha: Tok | undefined;
  legacy: boolean;
}

/** Splits a colour function's arguments: `a, b, c[, alpha]` (legacy) or `a b c [/ alpha]` (modern). */
function components(t: Extract<Tok, { type: 'function' }>): Components {
  const name = `${t.name}()`;
  if (t.args.some((a) => a.type === 'comma')) {
    const segs: Tok[][] = [[]];
    for (const a of t.args) {
      if (a.type === 'comma') segs.push([]);
      else segs[segs.length - 1]!.push(a);
    }
    if (segs.some((s) => s.length !== 1) || (segs.length !== 3 && segs.length !== 4)) {
      return fail(`${name} takes 3 or 4 comma-separated values`);
    }
    return { parts: [segs[0]![0]!, segs[1]![0]!, segs[2]![0]!], alpha: segs[3]?.[0], legacy: true };
  }
  const slash = t.args.findIndex((a) => a.type === 'slash');
  const parts = slash < 0 ? t.args : t.args.slice(0, slash);
  const alpha = slash < 0 ? [] : t.args.slice(slash + 1);
  if (parts.length !== 3 || alpha.length > 1 || (slash >= 0 && alpha.length !== 1)) {
    return fail(`${name} takes 3 values and an optional \`/ alpha\``);
  }
  return { parts, alpha: alpha[0], legacy: false };
}

function alphaOf(t: Tok | undefined): number {
  if (!t) return 1;
  if (t.type === 'number') return clamp(t.value, 0, 1);
  if (t.type === 'percent') return clamp(t.value / 100, 0, 1);
  if (t.type === 'ident' && t.name === 'none') return 0;
  return fail(`the alpha \`${t.text}\` is not a number or percentage`);
}

const isNone = (t: Tok): boolean => t.type === 'ident' && t.name === 'none';

function rgb(t: Extract<Tok, { type: 'function' }>): Rgba {
  const { parts, alpha, legacy } = components(t);
  if (legacy) {
    const allPercent = parts.every((p) => p.type === 'percent');
    const allNumber = parts.every((p) => p.type === 'number');
    if (!allPercent && !allNumber) return fail('rgb() with commas takes three numbers or three percentages');
  }
  const [r, g, b] = parts.map((p): number => {
    if (p.type === 'number') return channel(p.value);
    if (p.type === 'percent') return channel((p.value / 100) * 255);
    if (!legacy && isNone(p)) return 0;
    return fail(`the channel \`${p.text}\` is not a number or percentage`);
  }) as [number, number, number];
  return { r, g, b, a: alphaOf(alpha) };
}

/** hsl to rgb (CSS Color 4 §7.1), `h` in degrees, `s` and `l` in 0..1. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function hueOf(t: Tok): number {
  if (t.type === 'number') return t.value;
  if (isNone(t)) return 0;
  if (t.type === 'dimension' && isAngle(t)) return angleOf(t);
  return fail(`the hue \`${t.text}\` is not a number or angle`);
}

/** A saturation, lightness, whiteness or blackness: a percentage (a bare number is accepted without commas). */
function percentOf(t: Tok, legacy: boolean): number {
  if (t.type === 'percent') return clamp(t.value, 0, 100) / 100;
  if (!legacy && t.type === 'number') return clamp(t.value, 0, 100) / 100;
  if (!legacy && isNone(t)) return 0;
  return fail(`\`${t.text}\` is not a percentage`);
}

function hsl(t: Extract<Tok, { type: 'function' }>): Rgba {
  const { parts, alpha, legacy } = components(t);
  const [h, s, l] = parts as [Tok, Tok, Tok];
  const [r, g, b] = hslToRgb(hueOf(h), percentOf(s, legacy), percentOf(l, legacy));
  return { r: channel(r), g: channel(g), b: channel(b), a: alphaOf(alpha) };
}

function hwb(t: Extract<Tok, { type: 'function' }>): Rgba {
  const { parts, alpha, legacy } = components(t);
  if (legacy) return fail('hwb() does not take commas');
  const [h, wTok, bTok] = parts as [Tok, Tok, Tok];
  let w = percentOf(wTok, false);
  let k = percentOf(bTok, false);
  if (w + k >= 1) {
    const gray = channel((w / (w + k)) * 255);
    return { r: gray, g: gray, b: gray, a: alphaOf(alpha) };
  }
  const [r, g, b] = hslToRgb(hueOf(h), 1, 0.5);
  w *= 255;
  k *= 255;
  const mix = (c: number): number => channel((c / 255) * (255 - w - k) + w);
  return { r: mix(r), g: mix(g), b: mix(b), a: alphaOf(alpha) };
}

/** A colour string as a `ColorValue` (`'currentcolor'` for `currentcolor`), or `null` when it is not one. */
export function parseColor(value: string): ColorValue | null {
  try {
    const toks = lex(value);
    if (toks.length !== 1) return null;
    return colorOf(toks[0]);
  } catch {
    return null;
  }
}

/** Like `parseColor`, but `null` for `currentcolor`, for callers that need a concrete `Rgba`. */
export function parseRgba(value: string): Rgba | null {
  const c = parseColor(value);
  return c === 'currentcolor' ? null : c;
}
