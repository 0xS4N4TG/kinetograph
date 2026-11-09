import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { agentPrompt, CATEGORIES, groupIds, items, related, search } from '../src/lib/library';

const site = join(import.meta.dirname, '..');

describe('the catalog items', () => {
  it('lists every template, component and taste of the registry once, with a poster on disk', () => {
    expect(items.length).toBe(76);
    expect(new Set(items.map((i) => i.name)).size).toBe(items.length);
    for (const i of items) expect(existsSync(join(site, 'public', i.poster))).toBe(true);
  });

  it('puts each item in a known category, and the kinds of component under components', () => {
    for (const i of items) expect(CATEGORIES.map((c) => c.id)).toContain(i.group);
    expect(groupIds('components')).toContain('charts');
    expect(groupIds('templates')).toEqual(['templates']);
  });
});

describe('search and related', () => {
  it('matches every word, in the title, the description or the category', () => {
    expect(search(items, '').length).toBe(items.length);
    expect(search(items, 'aurora').map((i) => i.name)).toContain('aurora');
    expect(search(items, 'chart taste')).toEqual([]);
    expect(search(items, 'zzzq')).toEqual([]);
  });

  it('gives other items of the same category first', () => {
    const aurora = items.find((i) => i.name === 'aurora')!;
    const rel = related(aurora);
    expect(rel).toHaveLength(3);
    expect(rel.every((i) => i.name !== 'aurora' && i.group === 'backgrounds')).toBe(true);
  });

  it('writes a prompt that names the item and the command', () => {
    const aurora = items.find((i) => i.name === 'aurora')!;
    expect(agentPrompt(aurora)).toContain('npx kinetograph add aurora');
  });
});
