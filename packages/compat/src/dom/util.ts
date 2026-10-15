// Small helpers the DOM mapping shares: numbers, colours, lengths.

import type { Length, Rgba } from '../css/types.js';

/** Geometry is written to the scene rounded to 1/1000 px: layout's f32 noise (`33.333332061767578`) stays out of it. */
export function r3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  // `+ 0` turns -0 into 0.
  return rounded + 0;
}

/** The widest box a text can wrap in without the float noise of `width - padding` re-wrapping it: up to the 1/64 px
 *  grid Chrome lays out on. */
export function snapUp(value: number): number {
  return Math.ceil(value * 64 - 1e-4) / 64;
}

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` below full alpha. */
export function hex(color: Rgba, alphaScale = 1): string {
  const a = Math.max(0, Math.min(1, color.a * alphaScale));
  const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return Math.round(a * 255) === 255 ? base : `${base}${hex2(a * 255)}`;
}

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** What a length is resolved against. */
export interface LengthEnv {
  /** The element's own font size, px (`em`). */
  fontSize: number;
  viewport: { width: number; height: number };
}

export const ROOT_FONT_SIZE = 16;

/** A length in px; a percentage is of `percentOf`. */
export function px(length: Length, env: LengthEnv, percentOf = 0): number {
  switch (length.unit) {
    case 'px':
      return length.value;
    case '%':
      return (length.value / 100) * percentOf;
    case 'em':
      return length.value * env.fontSize;
    case 'rem':
      return length.value * ROOT_FONT_SIZE;
    case 'vw':
      return (length.value / 100) * env.viewport.width;
    case 'vh':
      return (length.value / 100) * env.viewport.height;
  }
}

export const ZERO: Length = { unit: 'px', value: 0 };

/** Adds `by` to a number or to every keyframe of an animated one. Constants are all this module emits, but a
 *  native layer's own `x` can be animated. */
export function plus(value: unknown, by: number): number | { frame: number; value: number }[] {
  if (value === undefined) return by;
  if (typeof value === 'number') return value + by;
  if (Array.isArray(value)) return value.map((key) => ({ ...key, value: key.value + by }));
  return by;
}

/** The constant a `Num` holds, or null when it is animated. */
export function constant(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? value : null;
}
