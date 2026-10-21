// interpolate() with tuple, string, boolean and font-weight outputs, `output: 'perceptual-scale'`, `outputType`, step
// and spring easings: every case is recorded from the published package (fixtures/interpolate-values.json), values and
// error messages alike.

import { describe, expect, it } from 'vitest';
import { Easing, interpolate } from '../src/index.js';
import { easingFromSpec, expectClose, fixture } from './helpers.js';

const data = fixture('interpolate-values.json');

// JSON has no NaN or Infinity: they are stored as { number: 'NaN' }.
const revive = (value: any): any =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'number' in value ? Number(value.number) : Array.isArray(value) ? value.map(revive) : value;

function optionsOf(spec: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'easing') options.easing = Array.isArray(value) ? value.map((e) => easingFromSpec(e as string)) : easingFromSpec(value as string);
    else options[key] = value;
  }
  return options;
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (typeof expected === 'number') {
    expectClose(actual as number, expected, 1e-9, label);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), label).toBe(true);
    expect((actual as unknown[]).length, label).toBe(expected.length);
    expected.forEach((value, i) => same((actual as unknown[])[i], value, `${label}[${i}]`));
  } else {
    expect(actual, label).toEqual(expected);
  }
}

describe('interpolate: tuples, strings, booleans, font weights, perceptual-scale', () => {
  it('matches the recorded values and error messages', () => {
    expect(data.cases.length).toBeGreaterThan(1000);
    for (const c of data.cases) {
      const label = JSON.stringify({ ...c, output: undefined });
      const args = [c.input, c.inputRange, revive(c.outputRange), optionsOf(c.options)] as const;
      const expected = revive(c.output);
      if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && 'error' in expected) {
        let thrown: unknown;
        try {
          (interpolate as (...a: unknown[]) => unknown)(...args);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${label} should throw ${expected.error}`).toBeInstanceOf(Error);
        expect((thrown as Error).message, label).toBe(expected.error);
        expect((thrown as Error).constructor.name, label).toBe(expected.type);
      } else {
        same((interpolate as (...a: unknown[]) => unknown)(...args), expected, label);
      }
    }
  });
});

describe('interpolate: documented examples', () => {
  it('scales a perceptual-scale zoom evenly in area', () => {
    // Halfway through 1 -> 4 the area is halfway through 1 -> 16: a scale of sqrt(8.5).
    expect(interpolate(5, [0, 10], [1, 4], { output: 'perceptual-scale' })).toBeCloseTo(Math.sqrt(8.5), 9);
    expect(interpolate(5, [0, 10], [1, 4])).toBe(2.5);
  });

  it('blends the numbers of a CSS value and keeps its units', () => {
    expect(interpolate(5, [0, 10], ['0px 0%', '100px 50%'])).toBe('50px 25%');
    expect(interpolate(5, [0, 10], ['0deg', '90deg'])).toBe('45deg');
    expect(interpolate(5, [0, 10], ['1', '2 3'])).toBe('1.5 2');
    expect(interpolate(5, [0, 10], ['left top', 'right bottom'])).toBe('50% 50%');
  });

  it('interpolates tuples per component', () => {
    expect(interpolate(5, [0, 10], [[0, 10], [100, 20]])).toEqual([50, 15]);
  });

  it('steps through booleans and words with Easing.step1', () => {
    expect(interpolate(4, [0, 5, 10], ['a', 'b', 'c'], { easing: Easing.step1 })).toBe('a');
    expect(interpolate(5, [0, 5, 10], ['a', 'b', 'c'], { easing: Easing.step1 })).toBe('b');
    expect(interpolate(7, [0, 5], [false, true], { easing: Easing.step1 })).toBe(true);
    expect(() => interpolate(1, [0, 5], [false, true])).toThrow('Booleans can only be interpolated using Easing.step1');
  });

  it('maps font weight names', () => {
    expect(interpolate(5, [0, 10], ['normal', 'bold'], { outputType: 'font-weight' })).toBe(550);
  });
});
