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

// Remotion 4.0.539: `wrap` repeats the whole keyframe range, not just the first or last segment. Expected values are what the
// published 4.0.539 gives.
describe('interpolate wrap over more than two keyframes (Remotion 4.0.539)', () => {
  const both = { extrapolateLeft: 'wrap', extrapolateRight: 'wrap' } as const;

  it('repeats every segment, numbers first', () => {
    expect(interpolate(35, [0, 10, 30], [0, 100, 200], { extrapolateRight: 'wrap' })).toBe(50);
    expect(interpolate(5, [0, 10, 30], [0, 100, 200], { extrapolateRight: 'wrap' })).toBe(50);
    const cases: [number, number][] = [[-5, 175], [35, 50], [-25, 50], [65, 50], [30, 200], [31, 10], [-30, 0], [10, 100]];
    for (const [input, expected] of cases) expectClose(interpolate(input, [0, 10, 30], [0, 100, 200], both), expected, 1e-9, `${input}`);
  });

  it('wraps only on the sides that ask for it', () => {
    expect(interpolate(-5, [0, 10, 30], [0, 100, 200], { extrapolateRight: 'wrap' })).toBe(-50);
    expect(interpolate(-5, [0, 10, 30], [0, 100, 200], { extrapolateLeft: 'wrap' })).toBe(175);
    expect(interpolate(35, [0, 10, 30], [0, 100, 200], { extrapolateLeft: 'wrap' })).toBe(225);
  });

  it('chooses easing, posterize, strings, tuples and tails from the wrapped input', () => {
    const easing = [Easing.ease, Easing.linear];
    expectClose(interpolate(35, [0, 10, 30], [0, 100, 200], { ...both, easing }), 31.535681257253934, 1e-9);
    expectClose(interpolate(35, [0, 10, 30], [0, 100, 200], { ...both, easing }), interpolate(5, [0, 10, 30], [0, 100, 200], { easing }), 1e-9);
    expect(interpolate(37, [0, 10, 30], [0, 100, 200], { ...both, posterize: 5 })).toBe(50); // held at 35, which wraps to 5
    expect(interpolate(35, [0, 10, 30], ['0px', '100px', '200px'], both)).toBe('50px');
    expect(interpolate(35, [0, 10, 30], ['0deg', '100deg', '200deg'], { ...both, outputType: 'rotate' })).toBe('50deg');
    expect(interpolate(35, [0, 10, 30], [1, 2, 3], { ...both, outputType: 'scale' })).toBe(1.5);
    expect(interpolate(35, [0, 10, 30], [[0, 0], [100, 10], [200, 30]], both)).toEqual([50, 5]);
    expect(interpolate(35, [0, 10, 30], ['normal', 'bold', 900], { ...both, outputType: 'font-weight' })).toBe(550);
    expect(interpolate(35, [0, 10, 30], ['a', 'b', 'c'], { ...both, easing: Easing.step1 })).toBe('a');
    expectClose(
      interpolate(35, [0, 10, 30], [100, 200, 400], { ...both, easing: Easing.spring({ allowTail: true }) }),
      210.414049529181,
      1e-9,
    );
  });
});
