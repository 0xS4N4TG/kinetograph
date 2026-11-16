import { describe, expect, it } from 'vitest';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GROUPS, PAPERCUT, SCENES, WORKERS } from '../src/data/speed';
import { expandSpeed, groupedScenes } from '../src/lib/speed-markdown';

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

describe('speed videos', () => {
  it('names every video in plain words, with a length, a frame count and a size that agree with the measured fps', () => {
    for (const s of SCENES) {
      // An internal id (mg1, dm4) is a stable key, never the label.
      expect(s.title, s.id).not.toMatch(/\b(mg|dm|pr)\d\b/);
      expect(s.title.split(/\s+/).length, s.title).toBeLessThanOrEqual(4);
      expect(s.summary.length, s.id).toBeGreaterThan(10);
      expect(s.size, s.id).toMatch(/^\d+x\d+$/);
      // Frames over the render's fps and over the video's 30 fps both give its length (rounded to a second), and the render ran every frame.
      expect(Math.abs(s.frames / 30 - s.seconds), s.id).toBeLessThanOrEqual(0.5);
      expect(Math.abs(s.kinetograph.fps * s.kinetograph.s - s.frames) / s.frames, s.id).toBeLessThan(0.02);
    }
    expect(new Set(SCENES.map((s) => s.title)).size).toBe(SCENES.length);
  });

  it('points every thumbnail at a file that exists, and groups every video once', () => {
    for (const s of SCENES) if (s.thumb) expect(existsSync(join(__dirname, '../public', s.thumb)), s.id).toBe(true);
    const grouped = groupedScenes().flatMap((g) => g.scenes.map((s) => s.id));
    expect([...grouped].sort()).toEqual(SCENES.map((s) => s.id).sort());
    expect(GROUPS.map((g) => g.kind)).toEqual(['port', 'page', 'project']);
  });

  it('keeps private source out of the visible words', () => {
    expect(`${PAPERCUT.note} ${PAPERCUT.detail}`).not.toMatch(/private|corpus|swap|profiled further/i);
    expect(`${PAPERCUT.note}`).toContain('1.5 frames per second');
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
    // The plain title leads each row, with the internal id in its own column.
    expect(out).toContain('| Paper cut-out explainer | papercut | 1080x1920 | 988 | Kinetograph |');
    expect(out).toContain('**The same video in all three engines.**');
    expect(out).toContain('- 60-second film (film): ');
  });
});
