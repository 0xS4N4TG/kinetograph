import { describe, expect, it } from 'vitest';
import type { Unsupported } from '@kinetograph/scene';
import { pathFor, planRuns } from '../src/runs.js';

const issue: Unsupported = { path: '$0 <div>', element: 'div', property: 'transform', value: 'skewX(10deg)', reason: 'skew' };
const frames = (pattern: string) => [...pattern].map((c, frame) => ({ frame, unsupported: c === 'c' ? [issue] : [] }));

describe('planRuns', () => {
  it('joins consecutive frames drawn the same way', () => {
    expect(planRuns(frames('nnccn'), 'auto')).toEqual([
      { first: 0, last: 1, path: 'native' },
      { first: 2, last: 3, path: 'chrome' },
      { first: 4, last: 4, path: 'native' },
    ]);
  });

  it('forces a path in native and chrome modes', () => {
    expect(planRuns(frames('ncn'), 'native')).toEqual([{ first: 0, last: 2, path: 'native' }]);
    expect(planRuns(frames('ncn'), 'chrome')).toEqual([{ first: 0, last: 2, path: 'chrome' }]);
    expect(pathFor([issue], 'auto')).toBe('chrome');
    expect(pathFor([], 'auto')).toBe('native');
  });

  it('sorts the frames and splits at gaps', () => {
    const input = [{ frame: 7, unsupported: [] }, { frame: 5, unsupported: [] }, { frame: 6, unsupported: [] }, { frame: 9, unsupported: [] }];
    expect(planRuns(input, 'auto')).toEqual([
      { first: 5, last: 7, path: 'native' },
      { first: 9, last: 9, path: 'native' },
    ]);
    expect(planRuns([], 'auto')).toEqual([]);
  });
});
