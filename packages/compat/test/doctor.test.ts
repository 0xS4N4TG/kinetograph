import { describe, expect, it } from 'vitest';
import type { Unsupported } from '@kinetograph/scene';
import { describeIssue, summarize } from '../src/doctor.js';

const item = (over: Partial<Unsupported> = {}): Unsupported => ({
  path: '$0 <div>',
  element: 'div',
  property: 'transform',
  value: 'skewX(10deg)',
  reason: 'skew is not supported',
  ...over,
});

/** One frame per character from 0: `.` is clean, anything else is a frame holding that key's items. */
function frames(pattern: string, items: Record<string, Unsupported[]> = {}) {
  return [...pattern].map((c, frame) => ({ frame, unsupported: c === '.' ? [] : (items[c] ?? [item()]) }));
}

describe('summarize', () => {
  it('reports a project with nothing unsupported as all clean', () => {
    const report = summarize('Main', frames('.....'));
    expect(report).toEqual({
      comp: 'Main',
      first: 0,
      last: 4,
      frames: 5,
      cleanFrames: 5,
      unsupportedFrames: 0,
      cleanShare: 1,
      issues: [],
    });
  });

  it('counts the frames with and without unsupported items', () => {
    const report = summarize('Main', frames('..xx.x..'));
    expect(report).toMatchObject({ first: 0, last: 7, frames: 8, cleanFrames: 5, unsupportedFrames: 3, cleanShare: 5 / 8 });
  });

  it('joins the frames of an issue into inclusive ascending ranges', () => {
    const [issue] = summarize('Main', frames('.xx..x.xxx')).issues;
    expect(issue).toMatchObject({ element: 'div', property: 'transform', reason: 'skew is not supported', frames: 6 });
    expect(issue!.ranges).toEqual([[1, 2], [5, 5], [7, 9]]);
  });

  it('groups by element, property and reason, not by value or path', () => {
    const a = item({ path: '$0 <div>', value: 'skewX(10deg)' });
    const b = item({ path: '$1 <div>', value: 'skewY(5deg)' });
    const differentReason = item({ reason: 'matrix does not decompose' });
    const differentElement = item({ element: 'span' });
    const differentProperty = item({ property: 'filter' });
    const report = summarize('Main', [
      { frame: 0, unsupported: [a, b, differentReason, differentElement, differentProperty] },
      { frame: 1, unsupported: [a] },
    ]);
    expect(report.issues).toHaveLength(4);
    const skew = report.issues.find((i) => i.element === 'div' && i.property === 'transform' && i.reason === 'skew is not supported')!;
    expect(skew.values).toEqual(['skewX(10deg)', 'skewY(5deg)']);
    expect(skew.paths).toEqual(['$0 <div>', '$1 <div>']);
    expect(skew.frames).toBe(2);
    expect(skew.ranges).toEqual([[0, 1]]);
  });

  it('counts a frame once for an issue however many items it has', () => {
    const many = [item({ path: '$0 <div>' }), item({ path: '$1 <div>' }), item({ path: '$2 <div>' })];
    const [issue] = summarize('Main', [{ frame: 3, unsupported: many }]).issues;
    expect(issue!.frames).toBe(1);
    expect(issue!.ranges).toEqual([[3, 3]]);
    expect(issue!.paths).toHaveLength(3);
  });

  it('lists at most 5 distinct values and 5 paths, in the order first seen', () => {
    const input = Array.from({ length: 9 }, (_, frame) => ({
      frame,
      unsupported: [item({ path: `$${frame % 7} <div>`, value: `skewX(${frame % 8}deg)` })],
    }));
    const [issue] = summarize('Main', input).issues;
    expect(issue!.values).toEqual(['skewX(0deg)', 'skewX(1deg)', 'skewX(2deg)', 'skewX(3deg)', 'skewX(4deg)']);
    expect(issue!.paths).toEqual(['$0 <div>', '$1 <div>', '$2 <div>', '$3 <div>', '$4 <div>']);
    expect(issue!.frames).toBe(9);
  });

  it('keeps an unsupported element, which has no property or value', () => {
    const canvas = item({ path: '$0.1 <canvas>', element: 'canvas', property: null, value: null, reason: 'element not supported' });
    const [issue] = summarize('Main', [{ frame: 0, unsupported: [canvas] }]).issues;
    expect(issue).toEqual({
      element: 'canvas',
      property: null,
      reason: 'element not supported',
      values: [],
      paths: ['$0.1 <canvas>'],
      ranges: [[0, 0]],
      frames: 1,
    });
  });

  it('sorts the issues by frames, most first, then by first frame', () => {
    const rare = item({ element: 'span', property: 'letterSpacing', reason: 'rare' });
    const early = item({ element: 'p', property: 'textDecoration', reason: 'early' });
    const common = item({ element: 'div', property: 'filter', reason: 'common' });
    const report = summarize('Main', [
      { frame: 0, unsupported: [early] },
      { frame: 1, unsupported: [early, common] },
      { frame: 2, unsupported: [common, rare] },
      { frame: 3, unsupported: [common] },
    ]);
    expect(report.issues.map((i) => i.reason)).toEqual(['common', 'early', 'rare']);
    expect(report.issues.map((i) => i.frames)).toEqual([3, 2, 1]);
  });

  it('breaks a tie on first frame, then on names, so the order is stable', () => {
    const b = item({ element: 'b', reason: 'r' });
    const a = item({ element: 'a', reason: 'r' });
    const later = item({ element: 'a', reason: 'later' });
    const report = summarize('Main', [
      { frame: 0, unsupported: [b, a] },
      { frame: 1, unsupported: [later] },
      { frame: 2, unsupported: [later] },
    ]);
    // `later` has 2 frames and goes first; `a` and `b` tie at 1 frame from frame 0 and sort by element.
    expect(report.issues.map((i) => `${i.element}/${i.reason}`)).toEqual(['a/later', 'a/r', 'b/r']);
  });

  it('puts the issue that starts earlier first when the frame counts tie', () => {
    const late = item({ reason: 'late' });
    const early = item({ reason: 'early' });
    const report = summarize('Main', [
      { frame: 0, unsupported: [early] },
      { frame: 5, unsupported: [late] },
    ]);
    expect(report.issues.map((i) => i.reason)).toEqual(['early', 'late']);
  });

  it('accepts frames out of order, a range that does not start at 0, and gaps', () => {
    const report = summarize('Main', [
      { frame: 12, unsupported: [item()] },
      { frame: 10, unsupported: [] },
      { frame: 11, unsupported: [item()] },
      { frame: 20, unsupported: [item()] },
    ]);
    expect(report).toMatchObject({ first: 10, last: 20, frames: 4, cleanFrames: 1, unsupportedFrames: 3 });
    expect(report.issues[0]!.ranges).toEqual([[11, 12], [20, 20]]);
  });

  it('merges a frame given twice into one frame', () => {
    const other = item({ property: 'filter', reason: 'f' });
    const report = summarize('Main', [
      { frame: 4, unsupported: [item()] },
      { frame: 4, unsupported: [other] },
      { frame: 5, unsupported: [] },
    ]);
    expect(report).toMatchObject({ frames: 2, cleanFrames: 1, unsupportedFrames: 1 });
    expect(report.issues.map((i) => i.frames)).toEqual([1, 1]);
  });

  it('handles no frames at all: nothing is unsupported', () => {
    expect(summarize('Main', [])).toEqual({
      comp: 'Main', first: 0, last: 0, frames: 0, cleanFrames: 0, unsupportedFrames: 0, cleanShare: 1, issues: [],
    });
  });

  it('does not change its input', () => {
    const input = [{ frame: 1, unsupported: [item()] }, { frame: 0, unsupported: [] }];
    const copy = structuredClone(input);
    summarize('Main', input);
    expect(input).toEqual(copy);
  });

  it('reports no clean frame when every frame has an item', () => {
    expect(summarize('Main', frames('xxx'))).toMatchObject({ cleanFrames: 0, unsupportedFrames: 3, cleanShare: 0 });
  });
});

describe('describeIssue', () => {
  it('names the element, the property and the reason', () => {
    expect(describeIssue({ element: 'div', property: 'transform', reason: 'skew is not supported' })).toBe('div transform: skew is not supported');
    expect(describeIssue({ element: 'canvas', property: null, reason: 'element not supported' })).toBe('canvas: element not supported');
  });
});
