// Paint helpers (AUTHORING.md §5.2): box-unit gradients with CSS semantics,
// the raw `gradient` escape hatch, and `fontKey`.

import type { ColorString, ConicGradient, Extend, Gradient, LinearGradient, RadialGradient, Stop } from './types.js';
import { compact } from './util.js';

export type GradientColors = (ColorString | [offset: number, color: ColorString])[];

/** Rounds away the float noise of `sin`/`cos` (`sin(π)` is 1.2e-16), so 180° gives exactly `0.5, 0, 0.5, 1`. Applied
 *  to the finished coordinates, not to the sines, so the error does not grow through the products. */
function tidy(value: number): number {
  // `+ 0` turns a negative zero into a plain one.
  return Math.round(value * 1e12) / 1e12 + 0;
}

/**
 * Colour stops as CSS places them: a stop with an offset keeps it, the first and last bare colours default to 0 and 1,
 * and a run of bare colours between two placed stops is spread evenly between them. So `['#f00', '#0f0', '#00f']`
 * lands at 0, 0.5 and 1.
 */
function stopsOf(colors: GradientColors): Stop[] {
  if (colors.length < 2) {
    throw new Error(`a gradient needs at least 2 colours, got ${colors.length}`);
  }
  const offsets: (number | undefined)[] = colors.map((c) => (typeof c === 'string' ? undefined : c[0]));
  if (offsets[0] === undefined) offsets[0] = 0;
  if (offsets[offsets.length - 1] === undefined) offsets[offsets.length - 1] = 1;
  let i = 0;
  while (i < offsets.length) {
    if (offsets[i] !== undefined) {
      i += 1;
      continue;
    }
    // `i` starts a run of unplaced stops; the stop before it and the one after the run are placed.
    let end = i;
    while (offsets[end] === undefined) end += 1;
    const from = offsets[i - 1] as number;
    const to = offsets[end] as number;
    for (let k = i; k < end; k += 1) {
      offsets[k] = tidy(from + ((to - from) * (k - i + 1)) / (end - i + 1));
    }
    i = end;
  }
  return colors.map((c, k) => ({
    offset: offsets[k] as number,
    color: typeof c === 'string' ? c : c[1],
  }));
}

/**
 * A linear gradient in box units (`units: 'box'`: fractions of the painted layer's box). `angle` is in degrees as in
 * CSS: 0 points to the top, 90 to the right, 180 (the default) to the bottom. The gradient line runs through the
 * box's centre and is as long as it takes for the corners to get the first and last colour, which is CSS's rule.
 *
 * Box units stretch with the box, so on a box that is not square the angle is measured in the unit square and then
 * stretched: exact for 0, 90, 180 and 270 and for square boxes, skewed for diagonals on other shapes.
 */
export function linearGradient(
  colors: GradientColors,
  options: { angle?: number; extend?: Extend } = {},
): LinearGradient {
  const theta = ((options.angle ?? 180) * Math.PI) / 180;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  const half = (Math.abs(dx) + Math.abs(dy)) / 2;
  return {
    type: 'linear',
    x0: tidy(0.5 - dx * half),
    y0: tidy(0.5 - dy * half),
    x1: tidy(0.5 + dx * half),
    y1: tidy(0.5 + dy * half),
    stops: stopsOf(colors),
    ...compact({ extend: options.extend }),
    units: 'box',
  };
}

/** A radial gradient in box units: centre `cx, cy` and radius `r` as fractions of the box (default `0.5` each, which
 *  reaches the box's sides; it is an ellipse on a box that is not square). */
export function radialGradient(
  colors: GradientColors,
  options: { cx?: number; cy?: number; r?: number; extend?: Extend } = {},
): RadialGradient {
  return {
    type: 'radial',
    cx: options.cx ?? 0.5,
    cy: options.cy ?? 0.5,
    r: options.r ?? 0.5,
    stops: stopsOf(colors),
    ...compact({ extend: options.extend }),
    units: 'box',
  };
}

/** A conic gradient in box units: centre `cx, cy` (default `0.5`) and `angle` degrees clockwise from 12 o'clock, as
 *  CSS's `conic-gradient(from <angle>)`. */
export function conicGradient(
  colors: GradientColors,
  options: { cx?: number; cy?: number; angle?: number; extend?: Extend } = {},
): ConicGradient {
  return {
    type: 'conic',
    cx: options.cx ?? 0.5,
    cy: options.cy ?? 0.5,
    ...compact({ angle: options.angle }),
    stops: stopsOf(colors),
    ...compact({ extend: options.extend }),
    units: 'box',
  };
}

/** The raw SCENE.md gradient, in user units unless it says `units: 'box'`; returned as given. */
export function gradient(json: Gradient): Gradient {
  return json;
}

const WEIGHT_NAMES: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

function weightOf(weight: number | string): number {
  let value: number | undefined;
  if (typeof weight === 'number') {
    value = weight;
  } else {
    const key = weight.trim().toLowerCase().replace(/[\s_-]/g, '');
    value = WEIGHT_NAMES[key] ?? (/^\d+$/.test(key) ? Number(key) : undefined);
  }
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`font weight must be a whole number from 1 to 1000 or a name like "bold", got ${JSON.stringify(weight)}`);
  }
  return value;
}

/** The key a font is registered and referenced by: `'Inter'` for 400 normal, else `'Inter:700'`, `'Inter:400i'`,
 *  `'Inter:700i'`. */
export function fontKey(family: string, weight: number | string = 400, style: 'normal' | 'italic' = 'normal'): string {
  const w = weightOf(weight);
  if (style !== 'normal' && style !== 'italic') {
    throw new Error(`font style must be "normal" or "italic", got ${JSON.stringify(style)}`);
  }
  if (w === 400 && style === 'normal') return family;
  return `${family}:${w}${style === 'italic' ? 'i' : ''}`;
}
