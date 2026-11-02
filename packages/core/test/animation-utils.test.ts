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

// Remotion 4.0.539 reads digits in a function name, so translate3d, scale3d, rotate3d and matrix3d stay whole.
describe('interpolateStyles with 3D transforms (Remotion 4.0.539)', () => {
  const style = (transform: string) => ({ transform });
  const at = (from: string, to: string) => A.interpolateStyles(0.5, [0, 1], [style(from), style(to)]);

  it('keeps the 3D function names intact', () => {
    expect(at('translate3d(0px, 0px, 0px)', 'translate3d(100px, 200px, 300px)')).toEqual(style('translate3d(50px, 100px, 150px)'));
    expect(at('scale3d(1, 1, 1)', 'scale3d(2, 3, 4)')).toEqual(style('scale3d(1.5, 2, 2.5)'));
    expect(at('rotate3d(1, 0, 0, 0deg)', 'rotate3d(1, 0, 0, 90deg)')).toEqual(style('rotate3d(1, 0, 0, 45deg)'));
    expect(at('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)', 'matrix3d(2,0,0,0,0,2,0,0,0,0,2,0,10,20,30,1)')).toEqual(
      style('matrix3d(1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.5, 0, 5, 10, 15, 1)'),
    );
  });

  it('interpolates chains that mix 2D and 3D functions, and the helpers output', () => {
    expect(at('translateX(0px) rotate(0deg) translate3d(0px,0px,0px)', 'translateX(10px) rotate(90deg) translate3d(100px, 200px, 300px)')).toEqual(
      style('translateX(5px) rotate(45deg) translate3d(50px, 100px, 150px)'),
    );
    expect(
      at(A.makeTransform([A.translate3d(0, 0, 0), A.scale3d(1, 1, 1)]), A.makeTransform([A.translate3d(100, 200, 300), A.scale3d(2, 2, 2)])),
    ).toEqual(style('translate3d(50px, 100px, 150px) scale3d(1.5, 1.5, 1.5)'));
  });
});
