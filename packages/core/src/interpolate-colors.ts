// `interpolateColors`: each channel is interpolated on its own, clamped at both
// ends, and written back as `rgba(r, g, b, a)`. Colours keep their alpha as a
// byte, so `rgba(0,0,0,0.5)` reads back as 0.502, as the published package does
// (test/fixtures/interpolate-colors.json).

import { parseColor, type Rgba } from './colors.js';
import { processColor } from './process-color.js';
import { interpolate } from './interpolate.js';

export interface InterpolateColorsOptions {
  /** Accepted for forward compatibility; the interpolation is always in RGB. */
  colorSpace?: 'rgb' | 'oklab';
}

/** The CSS Color 4 functions (`oklch()`, `lch()`, `lab()`, `oklab()`, `hwb()` with an angle unit or alpha), which `colors.ts` does not read. */
function modernColor(color: string): Rgba | null {
  try {
    const argb = processColor(color);
    return { r: (argb >>> 16) & 255, g: (argb >>> 8) & 255, b: argb & 255, a: argb >>> 24 };
  } catch {
    return null;
  }
}

export function interpolateColors(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly string[],
  _options?: InterpolateColorsOptions,
): string {
  if (typeof input === 'undefined') throw new TypeError('input can not be undefined');
  if (typeof inputRange === 'undefined') throw new TypeError('inputRange can not be undefined');
  if (typeof outputRange === 'undefined') throw new TypeError('outputRange can not be undefined');
  if (inputRange.length !== outputRange.length) {
    throw new TypeError(
      `inputRange (${inputRange.length} values provided) and outputRange (${outputRange.length} values provided) must have the same length`,
    );
  }
  const colors = outputRange.map((color) => {
    const parsed = parseColor(color) ?? modernColor(color);
    if (parsed === null) throw new TypeError(`invalid color string ${color} provided`);
    return parsed;
  });
  const channel = (pick: (c: (typeof colors)[number]) => number) =>
    interpolate(input, inputRange, colors.map(pick), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const r = Math.round(channel((c) => c.r));
  const g = Math.round(channel((c) => c.g));
  const b = Math.round(channel((c) => c.b));
  const a = Math.round((channel((c) => c.a) / 255) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
