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
  // Remotion 4.0.539: a hue of `grad` is 0.9 degrees a unit (it was read as radians because the name ends in `rad`), and every
  // unit wraps to one turn, so `hwb(720 0% 0%)` is red.
  describe('hue angles (Remotion 4.0.539)', () => {
    const at = (color: string) => interpolateColors(0, [0, 1], [color, color]);

    it('reads hwb() hues in any unit and wraps them', () => {
      expect(at('hwb(100grad 0% 0%)')).toBe(at('hwb(90deg 0% 0%)'));
      expect(at('hwb(90deg 0% 0%)')).toBe('rgba(128, 255, 0, 1)');
      expect(at('hwb(2turn 0% 0%)')).toBe(at('hwb(0 0% 0%)'));
      expect(at('hwb(720 0% 0%)')).toBe('rgba(255, 0, 0, 1)');
      expect(at('hwb(720deg 0% 0%)')).toBe('rgba(255, 0, 0, 1)');
      expect(at('hwb(-90deg 0% 0%)')).toBe(at('hwb(270deg 0% 0%)'));
      expect(at('hwb(-0.25turn 0% 0%)')).toBe(at('hwb(270deg 0% 0%)'));
      expect(at('hwb(400grad 0% 0%)')).toBe(at('hwb(0deg 0% 0%)'));
      expect(at(`hwb(${Math.PI / 2}rad 0% 0%)`)).toBe(at('hwb(90deg 0% 0%)'));
      expect(at('hwb(450deg 10% 20% / 0.5)')).toBe(at('hwb(90deg 10% 20% / 0.5)'));
    });

    it('reads lch() and oklch() hues in any unit and wraps them', () => {
      for (const fn of ['lch(60 40', 'oklch(0.7 0.15']) {
        const reference = at(`${fn} 90deg)`);
        expect(at(`${fn} 100grad)`), fn).toBe(reference);
        expect(at(`${fn} 0.25turn)`), fn).toBe(reference);
        expect(at(`${fn} 450deg)`), fn).toBe(reference);
        expect(at(`${fn} 5turn)`), fn).toBe(at(`${fn} 0deg)`));
        expect(at(`${fn} -270deg)`), fn).toBe(reference);
        expect(at(`${fn} 90deg / 0.5)`), fn).toBe(at(`${fn} 100grad / 0.5)`));
      }
    });

    it('interpolates between wrapped hues', () => {
      expect(interpolateColors(0.5, [0, 1], ['hwb(720 0% 0%)', 'hwb(0 0% 0%)'])).toBe('rgba(255, 0, 0, 1)');
      expect(interpolateColors(1, [0, 1], ['hwb(0 0% 0%)', 'hwb(100grad 0% 0%)'])).toBe('rgba(128, 255, 0, 1)');
    });
  });
});
