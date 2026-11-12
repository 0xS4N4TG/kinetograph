// The parts of a plugin page that are drawn from content/catalog.json (features, looks, slots), as Markdown. The page's MDX
// holds a tag for each (`<Features />`, `<Presets />`, `<Genes />`); the Markdown export of the page (the Copy Markdown button and
// /llms.mdx/catalog/plugin-<slug>.md) swaps each tag for the same facts as text, so an agent reads what a visitor sees.
import type { Plugin } from './catalog';

export function featuresMarkdown(p: Plugin): string {
  return p.features.map((f) => `### ${f.title}\n\n${f.text}${f.clip?.caption ? `\n\n${f.clip.caption}` : ''}`).join('\n\n');
}

export function presetsMarkdown(p: Plugin): string {
  if (p.presets.length === 0) return '';
  const rows = p.presets.map((r) => `- \`${r.name}\`${r.line ? `: ${r.line}` : ''}`).join('\n');
  return `${p.presetNote ? `${p.presetNote}\n\n` : ''}${rows}`;
}

export function genesMarkdown(p: Plugin): string {
  return (p.genes ?? []).map((s) => `- \`${s.slot}\`: ${s.note}. ${s.genes.map((g) => g.id).join(', ')}.`).join('\n');
}

/** The page's Markdown: title, the one-line description, the install command, then the MDX text with each data tag expanded. */
export function pluginMarkdown(p: Plugin, text: string): string {
  const tags: Record<string, string> = { Features: featuresMarkdown(p), Presets: presetsMarkdown(p), Genes: genesMarkdown(p) };
  const body = text.replace(/<(Features|Presets|Genes) ?\/>/g, (_, tag: string) => tags[tag]);
  return `# ${p.title} plugin\n\n${p.description}\n\n\`\`\`sh\nnpm install ${p.name}\n\`\`\`\n\n${body}\n\n- npm: https://www.npmjs.com/package/${p.name}\n- Source: ${sourceUrl(p)}\n`;
}

/** The plugin's folder in the kinetograph-ui repository. */
export const sourceUrl = (p: Plugin) => `https://github.com/0xS4N4TG/kinetograph-ui/tree/main/${p.source}`;
