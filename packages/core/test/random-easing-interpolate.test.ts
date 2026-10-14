import { describe, expect, it } from 'vitest';
import { Easing } from '../src/easing.js';
import { interpolate } from '../src/interpolate.js';
import { random } from '../src/random.js';
import { easingFromSpec, expectClose, fixture } from './helpers.js';

describe('random', () => {
  const data = fixture('random.json');

  it('is bit-exact with the recorded values', () => {
    expect(data.cases.length).toBeGreaterThan(1200);
    for (const { seed, value } of data.cases) {
      expect(random(seed), `random(${JSON.stringify(seed)})`).toBe(value);
    }
  });

  it('covers seeds 0..1000, fractions, negatives and strings', () => {
    const seeds = new Set(data.cases.map((c: any) => JSON.stringify(c.seed)));
    for (const s of [0, 1000, 0.5, -1, '"grain"', '"x"', '""', '"card-3"']) {
      expect(seeds.has(typeof s === 'string' ? s : JSON.stringify(s))).toBe(true);
    }
  });

  it('follows the recorded edge cases', () => {
    for (const edge of data.edge) {
      const input: Record<string, unknown> = {
        undefined: undefined,
        NaN: NaN,
        Infinity: Infinity,
        '-Infinity': -Infinity,
        object: {},
        boolean: true,
      };
      if ('error' in edge) {
        expect(() => random(input[edge.label] as never)).toThrow(edge.error);
      } else {
        expect(random(input[edge.label] as never)).toBe(edge.value);
      }
    }
  });

  it('is the same on every call and unseeded on null', () => {
    expect(random('a')).toBe(random('a'));
    const draws = new Set([random(null), random(null), random(null)]);
    expect(draws.size).toBeGreaterThan(1);
  });
});

describe('Easing', () => {
  it('matches the recorded samples', () => {
    const data = fixture('easing.json');
    for (const { spec, samples } of data.cases) {
      const fn = easingFromSpec(spec);
      for (const [t, expected] of samples) {
        expectClose(fn(t), expected, 1e-9, `${spec}(${t})`);
      }
    }
  });

  it('rejects a bezier with x outside 0..1', () => {
    expect(() => Easing.bezier(2, 0, 0.5, 1)).toThrow();
  });
});

describe('interpolate', () => {
  const data = fixture('interpolate.json');

  it('matches the recorded values for every extrapolation mode and easing', () => {
    expect(data.cases.length).toBeGreaterThan(1000);
    for (const c of data.cases) {
      const options: Record<string, unknown> = {};
      if (c.extrapolateLeft) options.extrapolateLeft = c.extrapolateLeft;
      if (c.extrapolateRight) options.extrapolateRight = c.extrapolateRight;
      if (c.easing) options.easing = easingFromSpec(c.easing);
      const label = JSON.stringify(c);
      if (c.output !== null && typeof c.output === 'object') {
        expect(() => interpolate(c.input, c.inputRange, c.outputRange, options), label).toThrow(c.output.error);
      } else {
        expectClose(interpolate(c.input, c.inputRange, c.outputRange, options), c.output, 1e-9, label);
      }
    }
  });

  it('reproduces the recorded error messages', () => {
    const run = (label: string, args: unknown[]) => (interpolate as any)(...args);
    for (const e of data.edge) {
      const args = e.args.map((a: unknown) => a);
      // JSON turns NaN and Infinity into null; the generator labels say which.
      if (e.label === 'NaN input') args[0] = NaN;
      if (e.label === 'Infinity input') args[0] = Infinity;
      if (e.label === 'NaN in range') args[1] = [0, NaN];
      if (e.label === 'Infinity in range') args[1] = [0, Infinity];
      if (e.error) {
        expect(() => run(e.label, args), e.label).toThrow(e.error);
      } else {
        const out = run(e.label, args);
        if (e.output === null) expect(Number.isFinite(out), e.label).toBe(false);
        else expect(out, e.label).toBeCloseTo(e.output, 9);
      }
    }
  });
});
