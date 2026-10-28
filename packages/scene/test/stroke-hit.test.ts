// `isPointInStroke` against Chrome's answers (`fixtures/stroke-chrome.json`, made by `fixtures/stroke-chrome.mjs`):
// every pixel centre of each case, with caps, joins, miter limits, dashes, curves, transforms and dots. Straight
// segments agree exactly. Along a curve Skia's stroker approximates the offset curve, so Chrome may answer otherwise
// for a point within a tenth of a pixel of the edge (the exact edge, measured: it is Chrome that is off there); such a
// point is accepted when ours answers as Chrome's a tenth of a pixel away.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCanvasContext, Path2D } from '../src/index.js';
import { answers, cases, HEIGHT, WIDTH } from './fixtures/stroke-cases.js';

const chrome = JSON.parse(readFileSync(new URL('./fixtures/stroke-chrome.json', import.meta.url), 'utf8')) as Record<string, string>;

describe('isPointInStroke', () => {
  it('strokes a path solid, at once, when its dashes are too many for Skia', () => {
    const ctx = createCanvasContext({ size: () => ({ width: 2000, height: 10 }) });
    ctx.lineWidth = 4;
    ctx.setLineDash([1e-6, 1e-6]);
    ctx.beginPath();
    ctx.moveTo(0, 5);
    ctx.lineTo(1000, 5);
    const start = performance.now();
    expect(ctx.isPointInStroke(500, 6)).toBe(true);
    expect(ctx.isPointInStroke(500, 8)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  for (const [name, setup] of cases) {
    it(`answers as Chrome does: ${name}`, () => {
      const ctx = createCanvasContext({ size: () => ({ width: WIDTH, height: HEIGHT }) });
      const path = setup(ctx, Path2D);
      const ours = answers(ctx, path);
      const theirs = chrome[name]!;
      expect(theirs).toHaveLength(WIDTH * HEIGHT);
      const hit = (x: number, y: number) => (path === null ? ctx.isPointInStroke(x, y) : ctx.isPointInStroke(path as Path2D, x, y));
      const differ: string[] = [];
      let near = 0;
      for (let i = 0; i < ours.length; i += 1) {
        if (ours[i] === theirs[i]) continue;
        const [x, y] = [(i % WIDTH) + 0.5, Math.floor(i / WIDTH) + 0.5];
        const want = theirs[i] === '1';
        const steps = [-0.1, 0, 0.1];
        if (steps.some((dx) => steps.some((dy) => hit(x + dx, y + dy) === want))) near += 1;
        else differ.push(`(${x}, ${y}): ours ${ours[i]}`);
      }
      expect(differ).toEqual([]);
      expect(near).toBeLessThan(WIDTH * HEIGHT * 0.005);
      expect(theirs).toContain('1');
    });
  }
});
