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
  /** A feature with no media is text only: clip is null. */
  features: { title: string; text: string; clip: Clip | null }[];
  exports: Export[];
  presets: { name: string; line: string; image: Image | null }[];
  presetNote: string;
  examples: { title: string; code: string }[];
  studio: { panel: string; tools: { name: string; text: string }[]; note: string; installed: string } | null;
  hero: Clip | null;
  demos: Demo[];
  /** The plugin's folder in the kinetograph-ui repo, for the Source link. */
  source: string;
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

/** One prop of a motion component, read from its zod schema: nested fields are written `colors.ink`. */
export interface ComponentProp {
  name: string;
  type: string;
  /** A short literal default; empty when it is long or computed. */
  default: string;
  doc: string;
}

export interface Component {
  id: string;
  title: string;
  description: string;
  change: string[];
  plugins: string[];
  compositions: string[];
  hero: Clip | null;
  /** The kind of a motion component (one of KINDS). Templates have none. */
  category?: string;
  props?: ComponentProp[];
  /** The item's folder in the kinetograph-ui repo, for the Source link. */
  source: string;
}

/** The kinds of motion component, in page order. */
export const KINDS = [
  { id: 'grids', title: 'Grids' },
  { id: 'carousels', title: 'Carousels' },
  { id: 'charts', title: 'Charts' },
  { id: 'backgrounds', title: 'Backgrounds' },
  { id: 'audio-viz', title: 'Audio' },
  { id: 'effects', title: 'Effects' },
] as const;

export const plugins = catalog.plugins as unknown as Plugin[];
export const components = catalog.components as unknown as Component[];
/** Templates are whole videos you start from. They share the Component shape; none has a category. */
export const templates = (catalog as unknown as { templates: Component[] }).templates;

/** A taste: a reusable style (palette, type, motion), shown by a cut of its demo reel. */
export interface Taste {
  id: string;
  title: string;
  description: string;
  hero: Clip | null;
  source: string;
}
export const tastes = (catalog as unknown as { tastes?: Taste[] }).tastes ?? [];

/** A plugin's title by its package name. */
export const pluginTitle = (name: string) => plugins.find((p) => p.name === name)?.title ?? name;
export const pluginByName = (name: string) => plugins.find((p) => p.name === name);
