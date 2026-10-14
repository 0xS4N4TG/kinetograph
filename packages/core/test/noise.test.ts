import { describe, expect, it } from 'vitest';
import { noise2D, noise3D, noise4D } from '../src/noise.js';
import { expectClose, fixture } from './helpers.js';

describe('noise', () => {
  const data = fixture('noise.json');

  it('matches recorded 2D, 3D and 4D values for several seeds', () => {
    expect(data.cases.length).toBeGreaterThan(1000);
    for (const c of data.cases) {
      const fn = c.dim === 2 ? noise2D : c.dim === 3 ? noise3D : noise4D;
      expectClose((fn as any)(c.seed, ...c.args), c.value, 1e-9, JSON.stringify(c));
    }
  });

  it('stays within -1..1 and is the same for the same seed', () => {
    for (let i = 0; i < 200; i++) {
      const v = noise2D('range', i * 0.37, i * 0.11);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    expect(noise3D('s', 1.3, 2.6, 3.9)).toBe(noise3D('s', 1.3, 2.6, 3.9));
    expect(noise3D('s', 1.3, 2.6, 3.9)).not.toBe(noise3D('t', 1.3, 2.6, 3.9));
  });
});
