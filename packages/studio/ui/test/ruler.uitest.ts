import { describe, expect, it } from 'vitest';

import { buildRuler, chooseStep, chooseSubdivisions, MIN_LABEL_PX, MIN_MINOR_PX, rulerLabel } from '../src/lib/ruler';

describe('ruler labels', () => {
  it('writes whole seconds as mm:ss and others with their fraction', () => {
    expect(rulerLabel(0)).toBe('00:00');
    expect(rulerLabel(1)).toBe('00:01');
    expect(rulerLabel(1.5)).toBe('00:01.5');
    expect(rulerLabel(61)).toBe('01:01');
    expect(rulerLabel(0.1 * 3)).toBe('00:00.3');
    expect(rulerLabel(1 / 30)).toBe('00:00.03');
  });
});

describe('step choice', () => {
  it('labels every second with a quarter-ish of dots at a normal zoom, and keeps marks apart', () => {
    // 30 fps at 3 px a frame: one second is 90 px.
    expect(chooseStep(30, 3)).toBe(1);
    expect(chooseSubdivisions(1, 30, 3)).toBe(5);
  });

  it('labels half seconds, with marks every 0.1 s, when zoomed in', () => {
    expect(chooseStep(30, 5)).toBe(0.5);
    expect(chooseSubdivisions(0.5, 30, 5)).toBe(5);
    // Far in, a mark for every frame.
    expect(chooseSubdivisions(0.5, 30, 20)).toBe(15);
    expect(chooseSubdivisions(0.1, 30, 40)).toBe(3);
  });

  it('labels 5 and 10 seconds, marks per second, when zoomed out', () => {
    expect(chooseStep(30, 0.5)).toBe(5);
    expect(chooseSubdivisions(5, 30, 0.5)).toBe(5);
    expect(chooseStep(30, 0.35)).toBe(10);
    expect(chooseSubdivisions(10, 30, 0.35)).toBe(10);
  });

  it('never leaves labels or marks closer than the minimum', () => {
    for (const fps of [24, 30, 60]) {
      for (let ppf = 0.05; ppf < 60; ppf *= 1.3) {
        const r = buildRuler(fps, 600, ppf);
        for (let i = 1; i < r.labels.length; i++) expect(r.labels[i]!.x - r.labels[i - 1]!.x).toBeGreaterThanOrEqual(MIN_LABEL_PX - 1e-6);
        const gaps = r.minor.map((m) => m.x).sort((x, y) => x - y);
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]! - gaps[i - 1]!).toBeGreaterThan(0);
        if (r.minor.length > 0) {
          const per = r.minor.filter((m) => m.frame > 0 && m.frame < r.step * fps);
          for (let i = 1; i < per.length; i++) expect(per[i]!.x - per[i - 1]!.x).toBeGreaterThanOrEqual(MIN_MINOR_PX - 1e-6);
        }
      }
    }
  });
});

describe('positions', () => {
  it('puts every mark at frame * pxPerFrame, fractional frames included', () => {
    const r = buildRuler(30, 90, 3);
    const one = r.labels.find((l) => l.text === '00:01')!;
    expect(one.frame).toBe(30);
    expect(one.x).toBe(30 * 3);
    // 5 gaps a second at 30 fps: marks every 6 frames.
    expect(r.minor.filter((m) => m.frame > 30 && m.frame < 60).map((m) => m.frame)).toEqual([36, 42, 48, 54]);
    const quarter = buildRuler(30, 90, 4.2); // 1 s = 126 px: still 1 s labels
    expect(quarter.step).toBe(1);
    const fractional = buildRuler(30, 90, 5).minor.find((m) => Number.isInteger(m.frame) === false);
    expect(fractional === undefined || fractional.x === fractional.frame * 5).toBe(true);
  });

  it('has no mark at a label, none past the end, and a label at 0', () => {
    const r = buildRuler(30, 100, 3);
    expect(r.labels[0]).toMatchObject({ frame: 0, x: 0, text: '00:00', whole: true });
    const at = new Set(r.labels.map((l) => l.frame));
    for (const m of r.minor) {
      expect(at.has(m.frame)).toBe(false);
      expect(m.frame).toBeLessThan(100);
    }
    expect(r.labels.every((l) => l.frame < 100)).toBe(true);
  });

  it('marks half-second labels as not whole', () => {
    const r = buildRuler(30, 90, 5);
    expect(r.labels.map((l) => [l.text, l.whole])).toEqual([['00:00', true], ['00:00.5', false], ['00:01', true], ['00:01.5', false], ['00:02', true], ['00:02.5', false]]);
  });
});
