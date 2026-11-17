// The page's scripts run before the scripts of the compositions it mounts (HyperFrames mounts them after the page ran).

import { describe, expect, it } from 'vitest';
import { inRunOrder, type HfScript } from '../src/hyperframes/plan.js';

const script = (file: string, scope: string | null): HfScript => ({ code: '', file, scope, sourceFile: null });

describe('the order scripts run in', () => {
  it('puts the page first and each composition after, keeping the order within each', () => {
    const scripts = [script('lib.js', null), script('a.html', 'a'), script('page-1', null), script('b.html', 'b'), script('page-2', null), script('a-module', 'a')];
    expect(inRunOrder(scripts).map((s) => s.file)).toEqual(['lib.js', 'page-1', 'page-2', 'a.html', 'b.html', 'a-module']);
  });
});
