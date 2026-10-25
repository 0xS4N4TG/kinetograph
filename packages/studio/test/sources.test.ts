import { describe, expect, it } from 'vitest';
import { nameLayers, relativeSource } from '../src/real-engine.js';
import { lookupName } from '../src/util.js';
import type { InspectLayer } from '../src/protocol.js';

describe('relativeSource', () => {
  const at = { line: 3, column: 9 };

  it('is relative to the directory the studio started in', () => {
    // esbuild reports a path relative to the entry's directory.
    expect(relativeSource({ file: 'shots/a.tsx', ...at }, '/work/examples/showcase', '/work')).toEqual({ file: 'examples/showcase/shots/a.tsx', ...at });
    expect(relativeSource({ file: '../lib/b.tsx', ...at }, '/work/examples/showcase', '/work')).toEqual({ file: 'examples/lib/b.tsx', ...at });
  });

  it('stays absolute outside it', () => {
    expect(relativeSource({ file: '../../../x.tsx', ...at }, '/work/a/b', '/work/a')).toEqual({ file: '/x.tsx', ...at });
    expect(relativeSource({ file: '/elsewhere/c.tsx', ...at }, '/work/a', '/work')).toEqual({ file: '/elsewhere/c.tsx', ...at });
  });
});

describe('nameLayers', () => {
  it('lays the names over the layers at any depth and leaves the others alone', () => {
    const layer = (id: string, children?: InspectLayer[]) => ({ id, type: 'group', ...(children ? { children } : {}) }) as unknown as InspectLayer;
    const source = { file: 'a.tsx', line: 1, column: 1 };
    const named = nameLayers([layer('$0', [layer('$0.0'), layer('free')])], { $0: { label: 'Opening', component: 'Main', source }, '$0.0': { label: 'Title' } });
    expect(named[0]).toMatchObject({ id: '$0', label: 'Opening', component: 'Main', source });
    expect(named[0]!.children![0]).toMatchObject({ id: '$0.0', label: 'Title' });
    expect(named[0]!.children![0]).not.toHaveProperty('component');
    expect(named[0]!.children![1]).not.toHaveProperty('label');
  });
});

describe('lookupName', () => {
  const names = { '$0.1': { label: 'Word \u00b7 \u201cI\u201d', component: 'Word' }, bg: { label: 'bg' } };

  it('names the layers the addon adds under an element after the element', () => {
    expect(lookupName(names, '$0.1')).toBe(names['$0.1']);
    expect(lookupName(names, '$0.1.shadow2')).toEqual({ label: 'Word \u00b7 \u201cI\u201d \u00b7 shadow2', component: 'Word' });
    expect(lookupName(names, '$0.1.border.top')?.label).toBe('Word \u00b7 \u201cI\u201d \u00b7 border top');
    expect(lookupName(names, '$0.1.svg.3')?.label).toBe('Word \u00b7 \u201cI\u201d \u00b7 svg 3');
  });

  it('has no name for a layer that is not under a named one', () => {
    expect(lookupName(names, '$7.3')).toBeUndefined();
    expect(lookupName(undefined, '$0.1')).toBeUndefined();
  });
});
