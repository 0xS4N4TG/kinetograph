// The catalog's data: every item of the registry (public/r/index.json) with its clip and poster from content/catalog.json,
// and the plugins from the same file (they are npm packages, not registry items). Skill items are not in the catalog.
// Server side only: client components import lib/library-core.ts and get the items as props.
import type { Metadata } from 'next';

import catalog from '../../content/catalog.json';
import index from '../../public/r/index.json';
import { plugins } from './catalog';
import { CATEGORIES, type Item, type ItemType } from './library-core';

export * from './library-core';

type Entry = { id: string; category?: string; source: string; hero: { src: string; w: number; h: number } | null };
const entries = catalog as unknown as { templates: Entry[]; components: Entry[]; tastes: Entry[] };
const byId = new Map<string, Entry & { group: string }>([
  ...entries.templates.map((e) => [e.id, { ...e, group: 'templates' }] as const),
  ...entries.tastes.map((e) => [e.id, { ...e, group: 'tastes' }] as const),
  ...entries.components.map((e) => [e.id, { ...e, group: e.category! }] as const),
]);

const registryItems: Item[] = (index.items as { name: string; type: string; title: string; description: string }[])
  .filter((i) => i.type === 'template' || i.type === 'component' || i.type === 'taste')
  .flatMap((i) => {
    const e = byId.get(i.name);
    if (!e?.hero) return [];
    return [{ name: i.name, type: i.type as ItemType, title: i.title, description: i.description, group: e.group, poster: e.hero.src, ratio: e.hero.w / e.hero.h, folder: e.source }];
  });

const pluginItems: Item[] = plugins.flatMap((p) =>
  p.hero ? [{ name: `plugin-${p.slug}`, type: 'plugin' as const, title: p.title, description: p.description, group: 'plugins', poster: p.hero.src, ratio: p.hero.w / p.hero.h, folder: p.source }] : [],
);

/** The catalog's items in sidebar order, then registry order. */
export const items: Item[] = [...registryItems, ...pluginItems].sort((a, b) => CATEGORIES.findIndex((c) => c.id === a.group) - CATEGORIES.findIndex((c) => c.id === b.group));

/** The metadata of a page that only redirects to `to`: kept out of search, with the new address as its canonical one. */
export const movedTo = (to: string): Metadata => ({ title: 'Moved | Kinetograph', robots: { index: false }, alternates: { canonical: `https://kinetograph.dev${to}` } });

/** Each item's name with its category id: all the client sidebar needs to count and to mark the open category. */
export const groups: Record<string, string> = Object.fromEntries(items.map((i) => [i.name, i.group]));
