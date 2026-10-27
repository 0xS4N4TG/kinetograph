// The CSS `filter` strings a Canvas 2D context takes (`ctx.filter`): `none`, or a list of `blur()`, `brightness()`,
// `contrast()`, `drop-shadow()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`, `saturate()` and `sepia()`.
// They become the functions the renderer runs (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"), which are the passes of the scene's effects
// of the same names. A `url()` reference names an SVG `<filter>` of the page the canvas is in, which the page's painter
// finds (crates/dom); where there is no page, it is reported and drawn without.

import { parseCssColor, toSceneColor } from './canvas-color.js';
import type { CanvasFilterFn } from './types.js';

export interface ParsedFilter {
  /** What is drawn, in order. A function that changes nothing is left out. */
  fns: CanvasFilterFn[];
  /** The product of the `opacity()` functions, which the context multiplies into `globalAlpha`. */
  opacity: number;
}

export const NO_FILTER: ParsedFilter = { fns: [], opacity: 1 };

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const LENGTH = new RegExp(`^(${NUMBER})(px|pt|pc|in|cm|mm|q|em|rem)?$`, 'i');
const ANGLE = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)?$`, 'i');
const AMOUNT = new RegExp(`^(${NUMBER})(%?)$`, 'i');

/** Pixels in one of each unit; a canvas's font is 16 pixels unless its element says otherwise. */
const PIXELS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16 };

/** A length in pixels; a bare number is only a length when it is 0. */
function length(text: string): number | null {
  const match = LENGTH.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (match[2] === undefined) return value === 0 ? 0 : null;
  return value * PIXELS[match[2].toLowerCase()]!;
}

/** Degrees; a bare number is only an angle when it is 0. */
function angle(text: string): number | null {
  const match = ANGLE.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === undefined) return value === 0 ? 0 : null;
  return unit === 'rad' ? (value * 180) / Math.PI : unit === 'grad' ? value * 0.9 : unit === 'turn' ? value * 360 : value;
}

/** A number or a percentage, as the number it stands for. */
function amount(text: string): number | null {
  const match = AMOUNT.exec(text);
  if (!match) return null;
  return match[2] === '%' ? Number(match[1]) / 100 : Number(match[1]);
}

/** The words of `text` outside parentheses and quotes, or null when they do not close. */
function words(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== '') {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (depth < 0) return null;
    if (/\s/.test(c) && depth === 0) {
      if (start >= 0) out.push(text.slice(start, i));
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) out.push(text.slice(start));
  return depth === 0 && quote === '' ? out : null;
}

/**
 * `drop-shadow(<color>? <length> <length> <length>?  <color>?)`; the blur length is the standard deviation, as `blur()`'s
 * is (Chrome draws `drop-shadow(0 0 10px)` as `blur(10px)`, and as `shadowBlur = 20`).
 */
function dropShadow(body: string): CanvasFilterFn | null {
  const parts = words(body);
  if (parts === null) return null;
  const lengths: number[] = [];
  let color: string | null = null;
  for (const part of parts) {
    const value = length(part);
    if (value !== null) {
      lengths.push(value);
      continue;
    }
    const parsed = parseCssColor(part);
    if (parsed === null || color !== null) return null;
    color = toSceneColor(parsed);
  }
  if (lengths.length < 2 || lengths.length > 3) return null;
  const [x, y, blur = 0] = lengths as [number, number, number?];
  if (blur < 0) return null;
  return { type: 'dropShadow', x, y, blur, color: color ?? '#000000' };
}

const AMOUNTS = ['brightness', 'contrast', 'grayscale', 'invert', 'saturate', 'sepia'] as const;
/** The functions whose amount is held to 1. */
const CAPPED = new Set<string>(['grayscale', 'invert', 'sepia', 'opacity']);
/** What each leaves unchanged. */
const NEUTRAL: Record<string, number> = { brightness: 1, contrast: 1, saturate: 1, grayscale: 0, invert: 0, sepia: 0 };

/**
 * The functions of a `filter` value, or null when the value is not a filter (a context ignores the assignment). A
 * function that is not in the list above, a negative amount or a length with no unit is not one.
 */
export function parseFilter(value: string): ParsedFilter | null {
  const text = value.trim();
  if (text.toLowerCase() === 'none') return NO_FILTER;
  const list = words(text);
  if (list === null || list.length === 0) return null;
  const out: ParsedFilter = { fns: [], opacity: 1 };
  for (const word of list) {
    const call = /^([a-z-]+)\((.*)\)$/is.exec(word);
    if (!call) return null;
    const name = call[1]!.toLowerCase();
    const body = call[2]!.trim();
    if (name === 'url') {
      out.fns.push({ type: 'url', url: word });
    } else if (name === 'blur') {
      const radius = body === '' ? 0 : length(body);
      if (radius === null || radius < 0) return null;
      if (radius > 0) out.fns.push({ type: 'blur', radius });
    } else if (name === 'hue-rotate') {
      const degrees = body === '' ? 0 : angle(body);
      if (degrees === null) return null;
      if (degrees !== 0) out.fns.push({ type: 'hueRotate', angle: degrees });
    } else if (name === 'drop-shadow') {
      const shadow = dropShadow(body);
      if (shadow === null) return null;
      out.fns.push(shadow);
    } else if (name === 'opacity' || (AMOUNTS as readonly string[]).includes(name)) {
      const raw = body === '' ? 1 : amount(body);
      if (raw === null || raw < 0) return null;
      const size = CAPPED.has(name) ? Math.min(raw, 1) : raw;
      if (name === 'opacity') out.opacity *= size;
      else if (size !== NEUTRAL[name]) out.fns.push({ type: name as (typeof AMOUNTS)[number], amount: size });
    } else {
      return null;
    }
  }
  return out;
}
