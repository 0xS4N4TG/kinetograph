import { afterEach, describe, expect, it } from 'vitest';

import { historyFor, noteTransitions, recordIsland, resetTransitionWindow, setHistoryMode } from '../src/dom/history.js';
import type { RequestNode } from '../src/request/build.js';

function canvas(recording: string): RequestNode {
  return { kind: 'element', tag: 'canvas', path: '0.0', attrs: { 'data-kg-webgl': recording, class: 'c' }, style: '', children: [] };
}

function island(attrs: Record<string, string>, recording: string): RequestNode {
  return { kind: 'element', tag: 'div', path: '0', attrs, style: 'transition: opacity 1s', children: [canvas(recording)] };
}

describe('island history', () => {
  afterEach(() => {
    setHistoryMode({ record: false });
    resetTransitionWindow();
  });

  it('keeps a hash of a canvas recording, not the recording, in every state of the window', () => {
    setHistoryMode({ record: true });
    const root = island({}, 'x');
    noteTransitions(root, []);
    const big = (n: number): string => JSON.stringify({ frame: n, pad: 'y'.repeat(200_000) });
    for (let i = 0; i < 5; i++) recordIsland('0', i / 30, island({}, big(i)));
    const states = historyFor('0', 1);
    expect(states.length).toBe(5);
    // Five frames of a 200 KB recording would be a megabyte; the states are a few hundred bytes each.
    expect(JSON.stringify(states).length).toBeLessThan(5_000);
    const hashes = states.map((s) => (s.root as { children: { attrs: Record<string, string> }[] }).children[0]!.attrs['data-kg-webgl']);
    expect(new Set(hashes).size).toBe(5);
    expect(hashes[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it('still starts a new state when a real attribute or style changes, and not when nothing does', () => {
    setHistoryMode({ record: true });
    noteTransitions(island({}, 'x'), []);
    recordIsland('0', 0, island({ 'data-a': '1' }, 'rec'));
    recordIsland('0', 0.1, island({ 'data-a': '1' }, 'rec'));
    recordIsland('0', 0.2, island({ 'data-a': '2' }, 'rec'));
    expect(historyFor('0', 1).map((s) => s.time)).toEqual([0, 0.2]);
  });
});
