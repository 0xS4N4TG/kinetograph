import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { plugins } from '../src/lib/catalog';
import { pluginMarkdown } from '../src/lib/plugin-markdown';

const site = join(import.meta.dirname, '..');
const mdx = (slug: string) => readFileSync(join(site, 'content/catalog', `plugin-${slug}.mdx`), 'utf8');
const docs = (path: string) => join(site, 'content/docs/(developers)', path);

describe("each plugin's catalog page", () => {
  it('has one MDX file with a title and a description, and nothing else sits beside them', () => {
    expect(readdirSync(join(site, 'content/catalog')).sort()).toEqual(plugins.map((p) => `plugin-${p.slug}.mdx`).sort());
    for (const p of plugins) expect(mdx(p.slug), p.slug).toMatch(/^---\ntitle: .+\ndescription: .+\n---\n/);
  });

  it('draws the catalog data only for tags the plugin has data for (a look is shown when it has a picture)', () => {
    for (const p of plugins) {
      const text = mdx(p.slug);
      expect(text, p.slug).toContain('<Features />');
      expect(text.includes('<Presets />'), p.slug).toBe(p.presets.some((r) => r.image));
      expect(text.includes('<Genes />'), p.slug).toBe(Boolean(p.genes));
    }
  });

  it('exports its features, looks and slots as Markdown, with no tag left over', () => {
    for (const p of plugins) {
      const md = pluginMarkdown(p, mdx(p.slug));
      expect(md, p.slug).toContain(`npm install ${p.name}`);
      for (const f of p.features) expect(md, `${p.slug}: ${f.title}`).toContain(f.text);
      for (const r of mdx(p.slug).includes('<Presets />') ? p.presets : []) expect(md, `${p.slug}: ${r.name}`).toContain(`\`${r.name}\``);
      for (const s of p.genes ?? []) for (const g of s.genes) expect(md, `${p.slug}: ${g.id}`).toContain(g.id);
      expect(md, p.slug).not.toMatch(/<(Features|Presets|Genes) ?\/>/);
    }
  });
});

describe('the docs', () => {
  it('have no page of one plugin, and no sidebar entry for one', () => {
    const meta = readFileSync(docs('meta.json'), 'utf8');
    for (const p of plugins) {
      for (const area of ['plugins', 'packages']) {
        expect(existsSync(docs(`${area}/${p.slug}.mdx`)), `${area}/${p.slug}`).toBe(false);
        expect(meta).not.toContain(`"${area}/${p.slug}"`);
      }
    }
  });

  it('send each removed address to its catalog page', () => {
    for (const p of plugins) {
      for (const area of ['plugins', 'packages']) {
        const page = readFileSync(join(site, 'src/app/docs', area, p.slug, 'page.tsx'), 'utf8');
        expect(page).toContain(`'/catalog/plugin-${p.slug}/'`);
      }
    }
  });
});
