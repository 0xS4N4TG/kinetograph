import catalog from '../../content/catalog.json';

/** A still extracted by scripts/catalog.mjs: a webp under public/catalog, and the render frame it came from. */
export interface Image {
  src: string;
  w: number;
  h: number;
  from: string;
  at?: number;
  caption?: string;
}

/** A clip extracted by scripts/catalog.mjs: an mp4 under public/catalog, with its first frame as the poster (the Image fields). */
export interface Clip extends Image {
  video: string;
  len: number;
}

export interface Prop {
  name: string;
  type: string;
  optional: boolean;
  doc: string;
}

/** A public export of a plugin, read from its source: the JSDoc summary and, for a component or an effect, its props. */
export interface Export {
  name: string;
  kind: 'component' | 'effect' | 'function' | 'constant';
  summary: string;
  detail: string;
  propsOf?: string;
  props?: Prop[];
}

export interface GeneSlot {
  slot: string;
  note: string;
  genes: { id: string; note: string }[];
}

export interface Look {
  kind: string;
  uses: string;
  summary: string;
}

export interface Demo {
  id: string;
  title: string;
  text: string;
  compositions: string[];
  clips: Clip[];
}

export interface Plugin {
  slug: string;
  name: string;
  title: string;
  description: string;
  components: string[];
  hasPanel: boolean;
  hasTools: boolean;
  hasSkill: boolean;
  intro: string;
  features: { title: string; text: string; clip: Clip }[];
  exports: Export[];
  presets: { name: string; line: string; image: Image | null }[];
  presetNote: string;
  examples: { title: string; code: string }[];
  studio: { panel: string; tools: { name: string; text: string }[]; note: string; installed: string } | null;
  hero: Clip | null;
  demos: Demo[];
  /** Hexed: the genes each slot can roll. */
  genes?: GeneSlot[];
  /** VJ: the look kinds and the export that draws each. */
  looks?: Look[];
  /** Paper: the paper stocks, edge styles, page layouts and texture scans. */
  stocks?: string[];
  edges?: string[];
  layouts?: string[];
  textures?: string[];
  /** Kinetic Typography: the handwritten and display faces. */
  faces?: { hands: string[]; display: string[] };
}

export interface Template {
  id: string;
  title: string;
  description: string;
  change: string[];
  plugins: string[];
  compositions: string[];
  hero: Clip | null;
}

export const plugins = catalog.plugins as unknown as Plugin[];
export const templates = catalog.templates as unknown as Template[];

/** A plugin's title by its package name. */
export const pluginTitle = (name: string) => plugins.find((p) => p.name === name)?.title ?? name;
export const pluginByName = (name: string) => plugins.find((p) => p.name === name);
