import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/colors.js';
import { interpolateColors } from '../src/interpolate-colors.js';
import { fixture } from './helpers.js';

describe('interpolateColors', () => {
  const data = fixture('interpolate-colors.json');

  it('matches the recorded outputs', () => {
    expect(data.cases.length).toBeGreaterThan(300);
    for (const c of data.cases) {
      const run = () => interpolateColors(c.input, c.inputRange, c.outputRange);
      if (typeof c.output === 'object') expect(run, JSON.stringify(c)).toThrow(c.output.error);
      else expect(run(), JSON.stringify(c)).toBe(c.output);
    }
  });

  it('follows the recorded edge cases, including which syntaxes are rejected', () => {
    for (const e of data.edge) {
      const run = () => (interpolateColors as any)(...e.args);
      if (e.error) expect(run, e.label).toThrow(e.error);
      else expect(run(), e.label).toBe(e.output);
    }
  });

  it('parses the supported syntaxes', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    expect(parseColor('rgba(0, 0, 255, 0.5)')).toEqual({ r: 0, g: 0, b: 255, a: 128 });
    expect(parseColor('hsl(120, 100%, 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 255 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('not a colour')).toBeNull();
  });
});
