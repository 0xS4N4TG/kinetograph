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
      else {
        // The fixture was recorded before 4.0.539, which holds a falling clamped spring at its target as well.
        const o = c.options;
        const falling = o.config?.overshootClamping && (o.from ?? 0) > (o.to ?? 1);
        expectClose(run(), falling ? Math.max(c.value, o.to ?? 1) : c.value, 1e-9, JSON.stringify(c));
      }
    }
  });

  // Remotion 4.0.539: overshoot clamping stops the normalised progress at 1 before it is mapped to from..to, so it holds for
  // rising, falling, fractional and negative ranges (it used to compare the progress with the output `to`).
  it('clamps overshoot for any custom range (Remotion 4.0.539)', () => {
    const config = { damping: 5 };
    expect(spring({ frame: 10, fps: 30, config, from: 0, to: 100 })).toBeCloseTo(144.26, 1); // unclamped
    expect(spring({ frame: 10, fps: 30, config: { ...config, overshootClamping: true }, from: 0, to: 100 })).toBe(100);
    for (const [from, to] of [[0, 100], [100, 0], [0, 0.5], [0.5, 0], [-100, -50], [-50, -100], [-20, 30], [30, -20]]) {
      let hitTarget = false;
      for (let frame = 0; frame <= 90; frame++) {
        const progress = spring({ frame, fps: 30, config });
        const expected = from + (to - from) * Math.min(progress, 1);
        const got = spring({ frame, fps: 30, config: { ...config, overshootClamping: true }, from, to });
        expectClose(got, expected, 1e-9, `${from}->${to} frame ${frame}`);
        if (progress > 1) hitTarget = got === to || Math.abs(got - to) < 1e-9;
      }
      expect(hitTarget, `${from}->${to} never overshoots`).toBe(true);
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
