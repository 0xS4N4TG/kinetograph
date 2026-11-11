import { describe, expect, it } from 'vitest';

import { SCENES, WORKERS } from '../src/data/speed';
import { expandSpeed } from '../src/lib/speed-markdown';

describe('speed data', () => {
  it('states each ratio as the other engine median over the Kinetograph median, within rounding of the printed times', () => {
    for (const s of SCENES) {
      for (const [other, r] of [[s.hyperframes, s.vsHyperframes], [s.remotion, s.vsRemotion]] as const) {
        if (!other || !r) continue;
        // Medians are printed to 0.01 s, so the stated ratio may differ from the printed one by a rounding step.
        expect(Math.abs(other.s / s.kinetograph.s - r.x), s.id).toBeLessThan(0.15);
        expect(r.lo).toBeLessThanOrEqual(r.x);
        expect(r.hi).toBeGreaterThanOrEqual(r.x);
      }
    }
  });

  it('keeps the median inside its min-max and the frame parts adding up to the total', () => {
    for (const s of SCENES) {
      for (const run of [s.kinetograph, s.hyperframes, s.remotion]) {
        if (!run) continue;
        expect(run.s).toBeGreaterThanOrEqual(run.min);
        expect(run.s).toBeLessThanOrEqual(run.max);
      }
    }
    expect(WORKERS.frameMs.reduce((a, p) => a + p.ms, 0)).toBeCloseTo(WORKERS.frameMsTotal, 5);
  });
});

describe('speed export', () => {
  const page = '# x\n\n<SpeedSummary />\n\n<SpeedBars />\n\n<WorkerSection>\n  ## Worker scaling\n\n  Gain <Fact k="gain" />.\n\n  <WorkerScaling />\n</WorkerSection>\n\n<SpeedMethod />\n';

  it('replaces every component tag with text that carries the numbers', () => {
    const out = expandSpeed(page);
    expect(out).not.toMatch(/<\/?(Speed|Worker|Fact|FrameTime)/);
    expect(out).toContain('| Remotion 4.0.542 | 646.13 | 644.35–654.40 | 1.5 | 10599 | 31.6× (31.5–32.0×) |');
    expect(out).toContain('| 4 | 8.56 | 1.33× |');
    expect(out).toContain('Gain 1.33×.');
    expect(out).toContain('- Node: v26.7.0');
  });
});
