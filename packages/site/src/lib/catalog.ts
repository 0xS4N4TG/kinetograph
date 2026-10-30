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

export interface ComponentDoc {
  name: string;
  kind: 'component' | 'look';
  summary: string;
  props: [string, string][];
  after: string;
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
  about: string[];
  componentDocs: ComponentDoc[];
  presets: { name: string; line: string; image: Image | null }[];
  presetNote: string;
  examples: { title: string; code: string }[];
  studio: { panel: string; tools: { name: string; text: string }[]; note: string; installed: string } | null;
  hero: Image | null;
  demos: { id: string; title: string; text: string; stills: Image[] }[];
}

export interface Template {
  id: string;
  title: string;
  description: string;
  change: string[];
  plugins: string[];
  compositions: string[];
  hero: Image | null;
}

export const plugins = catalog.plugins as unknown as Plugin[];
export const templates = catalog.templates as unknown as Template[];

/** A plugin's title by its package name. */
export const pluginTitle = (name: string) => plugins.find((p) => p.name === name)?.title ?? name;
export const pluginByName = (name: string) => plugins.find((p) => p.name === name);
