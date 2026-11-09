// The catalog page's data: every item of the registry (public/r/index.json) with its clip and poster from
// content/catalog.json. Skill items are not in the catalog. The helpers are plain functions so tests can run them.
import index from '../../public/r/index.json';
import catalog from '../../content/catalog.json';
import type { Metadata } from 'next';

import { KINDS } from './catalog';

export type ItemType = 'template' | 'component' | 'taste';

/** What a card and a page need: no file contents. `ratio` is the poster's width over its height. */
export interface Item {
  name: string;
  type: ItemType;
  title: string;
  description: string;
  /** The id of the Category the item is listed under. */
  group: string;
  poster: string;
  ratio: number;
  /** The item's folder in the kinetograph-ui repo. */
  folder: string;
}

export interface Category {
  id: string;
  title: string;
  blurb: string;
  /** The top-level group a sub-category belongs to, if any: the kinds of component. */
  parent?: 'components';
}

const KIND_BLURBS: Record<string, string> = {
  grids: 'Photo walls that ripple in and move the camera.',
  carousels: 'Cards that ride a circle, an orbit or a path.',
  charts: 'Bars, lines and candles that draw their own data in.',
  backgrounds: 'Moving grounds for type: aurora, gradients, dots.',
  'audio-viz': 'Scopes and plasma drawn from the audio file.',
  effects: 'Light leaks, halation, glass lenses and film burns.',
};

/** The sidebar, in order: the two whole-video kinds, then the components with one entry per kind. */
export const CATEGORIES: Category[] = [
  { id: 'templates', title: 'Templates', blurb: 'Whole videos to start from: launch films, explainers, reels.' },
  { id: 'tastes', title: 'Tastes', blurb: 'A style to make new reels in: palette, type and motion.' },
  ...KINDS.map((k) => ({ id: k.id, title: k.title, blurb: KIND_BLURBS[k.id], parent: 'components' as const })),
];

/** The sidebar entry that holds all the components. */
export const COMPONENTS_BLURB = 'Single pieces: charts, grids, backgrounds and effects.';

type Entry = { id: string; category?: string; source: string; hero: { src: string; w: number; h: number } | null };
const entries = catalog as unknown as { templates: Entry[]; components: Entry[]; tastes: Entry[] };
const byId = new Map<string, Entry & { group: string }>([
  ...entries.templates.map((e) => [e.id, { ...e, group: 'templates' }] as const),
  ...entries.tastes.map((e) => [e.id, { ...e, group: 'tastes' }] as const),
  ...entries.components.map((e) => [e.id, { ...e, group: e.category! }] as const),
]);

/** The catalog's items in sidebar order, then registry order. */
export const items: Item[] = (index.items as { name: string; type: string; title: string; description: string }[])
  .filter((i) => i.type === 'template' || i.type === 'component' || i.type === 'taste')
  .flatMap((i) => {
    const e = byId.get(i.name);
    if (!e?.hero) return [];
    return [{ name: i.name, type: i.type as ItemType, title: i.title, description: i.description, group: e.group, poster: e.hero.src, ratio: e.hero.w / e.hero.h, folder: e.source }];
  })
  .sort((a, b) => CATEGORIES.findIndex((c) => c.id === a.group) - CATEGORIES.findIndex((c) => c.id === b.group));

export const categoryOf = (item: Item) => CATEGORIES.find((c) => c.id === item.group)!;

/** The ids a `?c=` value selects: a category, or `components` for every kind of component. */
export const groupIds = (c: string) => (c === 'components' ? CATEGORIES.filter((x) => x.parent === 'components').map((x) => x.id) : [c]);

/** The items that match every word of a search, in the title, the description or the category. */
export function search(list: Item[], query: string): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;
  return list.filter((i) => {
    const hay = `${i.name} ${i.title} ${i.description} ${i.type} ${categoryOf(i).title}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Up to `n` other items: the same category first, then the same type. */
export function related(item: Item, n = 3): Item[] {
  const others = items.filter((i) => i.name !== item.name);
  const rank = (i: Item) => (i.group === item.group ? 0 : i.type === item.type ? 1 : 2);
  return others
    .map((i, k) => [i, k] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .slice(0, n)
    .map(([i]) => i);
}

/** The metadata of a page that only redirects to `to`: kept out of search, with the new address as its canonical one. */
export const movedTo = (to: string): Metadata => ({ title: 'Moved | Kinetograph', robots: { index: false }, alternates: { canonical: `https://kinetograph.dev${to}` } });

/** The prompt that asks an agent to add an item. */
export function agentPrompt(item: Item): string {
  const what = item.type === 'template' ? 'template' : item.type === 'taste' ? 'taste' : 'component';
  const use =
    item.type === 'template' ? 'Change its words and pictures to match my project, then render a draft.' : item.type === 'taste' ? 'Make my next video in that style, then render a draft.' : 'Use it in my video, then render a draft.';
  return `Add the ${item.title} ${what} from the Kinetograph library to my project with \`npx kinetograph add ${item.name}\`. ${use}`;
}
