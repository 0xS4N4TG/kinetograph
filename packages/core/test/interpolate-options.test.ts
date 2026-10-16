// interpolate()'s per-segment easing and posterize, and the two validators Remotion exports for them; the cases are
// recorded from the published package (fixtures/interpolate-options.json).

import { describe, expect, it } from 'vitest';
import {
  assertValidInterpolateEasingOption,
  assertValidInterpolatePosterizeOption,
  Easing,
  interpolate,
} from '../src/index.js';
import { easingFromSpec, expectClose, fixture } from './helpers.js';

const data = fixture('interpolate-options.json');
const revive = (value: unknown) => (value === 'NaN' ? NaN : value === 'Infinity' ? Infinity : value);

describe('interpolate with an easing per segment and posterize', () => {
  it('matches the recorded values and error messages', () => {
    expect(data.cases.length).toBeGreaterThan(100);
    for (const c of data.cases) {
      const options: Record<string, unknown> = {};
      if (c.easing) options.easing = Array.isArray(c.easing) ? c.easing.map(easingFromSpec) : easingFromSpec(c.easing);
      if (c.posterize !== undefined) options.posterize = revive(c.posterize);
      if (c.extrapolateLeft) options.extrapolateLeft = c.extrapolateLeft;
      if (c.extrapolateRight) options.extrapolateRight = c.extrapolateRight;
      const label = JSON.stringify(c);
      if (c.output !== null && typeof c.output === 'object') {
        expect(() => interpolate(c.input, c.inputRange, c.outputRange, options), label).toThrow(c.output.error);
      } else {
        expectClose(interpolate(c.input, c.inputRange, c.outputRange, options), c.output, 1e-9, label);
      }
    }
  });
});

describe('assertValidInterpolateEasingOption', () => {
  it('lets through a left-out easing, a function, and one function per segment', () => {
    expect(() => assertValidInterpolateEasingOption(undefined, 4)).not.toThrow();
    expect(() => assertValidInterpolateEasingOption(Easing.ease, 4)).not.toThrow();
    expect(() => assertValidInterpolateEasingOption([Easing.ease, Easing.linear, Easing.quad], 4)).not.toThrow();
    expect(() => assertValidInterpolateEasingOption([], 1)).not.toThrow();
  });

  it('refuses an array of the wrong length, or with something that is not a function', () => {
    expect(() => assertValidInterpolateEasingOption([Easing.ease], 4)).toThrow('(length inputRange.length - 1 = 3), but got length 1');
    expect(() => assertValidInterpolateEasingOption([Easing.ease, 5 as never], 3)).toThrow('easing[1] must be a function');
  });
});

describe('assertValidInterpolatePosterizeOption', () => {
  it('lets through a left-out or positive finite value', () => {
    expect(() => assertValidInterpolatePosterizeOption(undefined)).not.toThrow();
    expect(() => assertValidInterpolatePosterizeOption(0.5)).not.toThrow();
  });

  it('refuses zero, negatives, NaN, Infinity and non-numbers', () => {
    for (const bad of [0, -2, NaN, Infinity, '2' as never]) {
      expect(() => assertValidInterpolatePosterizeOption(bad)).toThrow(/posterize must be a positive finite number/);
    }
  });
});
