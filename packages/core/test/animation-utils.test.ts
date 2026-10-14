import { describe, expect, it } from 'vitest';
import * as A from '../src/animation-utils.js';
import { Easing } from '../src/easing.js';
import { expectClose, fixture } from './helpers.js';

const data = fixture('animation-utils.json');

/** Numbers inside a string compared to 1e-9, the text around them exactly. */
function expectSame(actual: unknown, expected: unknown, label: string) {
  if (typeof expected === 'number') return expectClose(actual as number, expected, 1e-9, label);
  if (typeof expected === 'string') {
    const split = (s: string) => s.split(/(-?\d*\.?\d+(?:e[+-]?\d+)?)/i);
    const a = split(String(actual));
    const e = split(expected);
    expect(a.length, `${label}: ${actual} vs ${expected}`).toBe(e.length);
    a.forEach((part, i) => {
      if (i % 2 === 0) expect(part, label).toBe(e[i]);
      else expect(Math.abs(Number(part) - Number(e[i])), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-9);
    });
    return;
  }
  expect(actual, label).toEqual(expected);
}

describe('transform helpers', () => {
  it('write the same CSS as the published package', () => {
    for (const c of data.functions) {
      const fn = (A as any)[c.name];
      // makeTransform's argument is a list of strings the other helpers wrote; the recorded one is that list.
      expect(fn(...c.args), `${c.name}(${JSON.stringify(c.args)})`).toBe(c.result.value);
    }
  });
});

describe('interpolateStyles', () => {
  const easings: Record<string, (t: number) => number> = { quad: (t) => t * t, out: Easing.out(Easing.cubic) };

  it('matches the recorded blends and errors', () => {
    for (const c of data.interpolateStyles) {
      const options: Record<string, unknown> = { ...c.extra };
      if (c.easing) options.easing = easings[c.easing];
      const label = `${c.label} @${c.input}`;
      const run = () => A.interpolateStyles(c.input, c.inputRange, c.outputRange, Object.keys(options).length ? options : undefined);
      if (c.result.error) expect(run, label).toThrow(c.result.error);
      else {
        const got = run();
        expect(Object.keys(got), label).toEqual(Object.keys(c.result.value));
        for (const key of Object.keys(c.result.value)) expectSame(got[key], c.result.value[key], `${label}.${key}`);
      }
    }
  });
});
