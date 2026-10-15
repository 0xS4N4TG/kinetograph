import { describe, expect, it } from 'vitest';
import { measureSpring, spring } from '../src/spring.js';
import { expectClose, fixture } from './helpers.js';

describe('spring', () => {
  const data = fixture('spring.json');

  it('matches recorded values across configs, fps and fractional frames', () => {
    for (const c of data.cases) {
      expectClose(spring({ frame: c.frame, fps: c.fps, config: c.config }), c.value, 1e-9, JSON.stringify(c));
    }
  });

  it('matches recorded values for from/to, durationInFrames, delay, reverse and clamping', () => {
    for (const c of data.optionCases) {
      const run = () => spring({ frame: c.frame, fps: c.fps, ...c.options });
      if (c.value !== null && typeof c.value === 'object') expect(run, JSON.stringify(c)).toThrow(c.value.error);
      else expectClose(run(), c.value, 1e-9, JSON.stringify(c));
    }
  });

  it('reproduces the recorded errors', () => {
    for (const e of data.edge) {
      const run = () => (spring as any)(e.o);
      if (e.error) expect(run, e.label).toThrow(e.error);
      else if (e.value === null) expect(Number.isFinite(run()), e.label).toBe(false);
      else expectClose(run(), e.value, 1e-9, e.label);
    }
  });
});

describe('measureSpring', () => {
  it('matches recorded durations', () => {
    for (const c of fixture('spring.json').measure) {
      expect(measureSpring({ fps: c.fps, config: c.config, ...c.extra }), JSON.stringify(c)).toBe(c.value);
    }
  });
});
