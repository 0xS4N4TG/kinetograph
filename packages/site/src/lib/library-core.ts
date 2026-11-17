// The catalog's types and pure helpers. This file imports no data, so client components can use it without bundling
// content/catalog.json; lib/library.ts holds the items.

export type ItemType = 'template' | 'component' | 'taste' | 'plugin';

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

/** The kinds of motion component, as lib/catalog.ts lists them (a test keeps the two equal). */
export const COMPONENT_KINDS = [
  { id: 'grids', title: 'Grids', blurb: 'Photo walls that ripple in and move the camera.' },
  { id: 'carousels', title: 'Carousels', blurb: 'Cards that ride a circle, an orbit or a path.' },
  { id: 'charts', title: 'Charts', blurb: 'Bars, lines and candles that draw their own data in.' },
  { id: 'backgrounds', title: 'Backgrounds', blurb: 'Moving grounds for type: aurora, gradients, dots.' },
  { id: 'audio-viz', title: 'Audio', blurb: 'Scopes and plasma drawn from the audio file.' },
  { id: 'effects', title: 'Effects', blurb: 'Light leaks, halation, glass lenses and film burns.' },
] as const;

/** The sidebar, in order: the whole-video kinds, plugins, then the components with one entry per kind. */
export const CATEGORIES: Category[] = [
  { id: 'templates', title: 'Templates', blurb: 'Whole videos to start from: launch films, explainers, reels.' },
  { id: 'tastes', title: 'Tastes', blurb: 'A style to make new reels in: palette, type and motion.' },
  { id: 'plugins', title: 'Plugins', blurb: 'npm packages that add looks, captions, paper and tracking.' },
  ...COMPONENT_KINDS.map((k) => ({ ...k, parent: 'components' as const })),
];

/** The sidebar entry that holds all the components. */
export const COMPONENTS_BLURB = 'Single pieces: charts, grids, backgrounds and effects.';

/** A plugin's item name is `plugin-<slug>`, which keeps it apart from a library item of the same name (there is a `paper` component). */
export const pluginSlug = (item: Item) => item.name.replace(/^plugin-/, '');

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

/** Up to `n` other items of `list`: the same category first, then the same type. */
export function related(list: Item[], item: Item, n = 3): Item[] {
  const rank = (i: Item) => (i.group === item.group ? 0 : i.type === item.type ? 1 : 2);
  return list
    .filter((i) => i.name !== item.name)
    .map((i, k) => [i, k] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .slice(0, n)
    .map(([i]) => i);
}

/** The prompt that asks an agent to add an item. */
export function agentPrompt(item: Item): string {
  if (item.type === 'plugin') {
    return `Add the ${item.title} plugin to my Kinetograph project with \`npm install @kinetographdev/${pluginSlug(item)}\`, read its skill, and use it in my video. Then render a draft.`;
  }
  const use =
    item.type === 'template' ? 'Change its words and pictures to match my project, then render a draft.' : item.type === 'taste' ? 'Make my next video in that style, then render a draft.' : 'Use it in my video, then render a draft.';
  return `Add the ${item.title} ${item.type} from the Kinetograph library to my project with \`npx kinetograph add ${item.name}\`. ${use}`;
}
