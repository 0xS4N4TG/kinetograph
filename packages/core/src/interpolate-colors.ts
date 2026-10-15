// `interpolateColors`: each channel is interpolated on its own, clamped at both
// ends, and written back as `rgba(r, g, b, a)`. Colours keep their alpha as a
// byte, so `rgba(0,0,0,0.5)` reads back as 0.502, as the published package does
// (test/fixtures/interpolate-colors.json).

import { parseColor } from './colors.js';
import { interpolate } from './interpolate.js';

export interface InterpolateColorsOptions {
  /** Accepted for forward compatibility; the interpolation is always in RGB. */
  colorSpace?: 'rgb' | 'oklab';
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
    const parsed = parseColor(color);
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
