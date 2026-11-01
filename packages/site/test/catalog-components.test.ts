import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { KINDS } from '../src/lib/catalog';

type Entry = {
  id: string;
  title: string;
  description: string;
  category?: string;
  props?: { name: string; type: string; default: string; doc: string }[];
  hero: { src: string; video: string } | null;
};
const site = join(import.meta.dirname, '..');
const { components } = JSON.parse(readFileSync(join(site, 'content/catalog.json'), 'utf8')) as { components: Entry[] };
const kinds = components.filter((c) => c.category);

describe('motion components in the catalog', () => {
  it('has unique ids, and every category is a known kind', () => {
    expect(new Set(components.map((c) => c.id)).size).toBe(components.length);
    for (const c of kinds) expect(KINDS.map((k) => k.id)).toContain(c.category);
  });

  it('keeps the first seven components as the uncategorised scenes', () => {
    expect(components.slice(0, 7).every((c) => !c.category)).toBe(true);
    expect(kinds.length).toBe(components.length - 7);
  });

  it('gives each one props with a description, and its clip and poster on disk', () => {
    for (const c of kinds) {
      expect(c.props?.length, c.id).toBeGreaterThan(0);
      for (const p of c.props ?? []) expect(p.doc, `${c.id}.${p.name}`).not.toBe('');
      if (c.hero) {
        expect(existsSync(join(site, 'public', c.hero.video)), c.hero.video).toBe(true);
        expect(existsSync(join(site, 'public', c.hero.src)), c.hero.src).toBe(true);
      }
    }
  });

  it('says nothing about the private repository, a source it was modelled on, or open source', () => {
    const text = JSON.stringify(kinds.map((c) => [c.title, c.description])).toLowerCase();
    for (const word of ['kinetograph-effects', 'github.com', 'open source', 'remake', 'rebuild', 'seamless', 'stunning', 'elevate', 'vibrant', 'robust']) {
      expect(text, word).not.toContain(word);
    }
  });
});
