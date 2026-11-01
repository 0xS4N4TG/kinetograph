import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { catalogFeed, SITE_URL } from '../src/lib/catalog-feed';

const catalog = JSON.parse(readFileSync(join(import.meta.dirname, '../content/catalog.json'), 'utf8')) as { plugins: { slug: string; name: string; title: string; description: string }[] };

describe('catalogFeed', () => {
  it('lists each plugin with only the public fields, unpublished, linking to its page', () => {
    const feed = catalogFeed(catalog.plugins);
    expect(feed.version).toBe(1);
    expect(Object.keys(feed).sort()).toEqual(['plugins', 'version']);
    expect(feed.plugins.map((p) => p.name)).toEqual(catalog.plugins.map((p) => p.name));
    for (const p of feed.plugins) {
      const source = catalog.plugins.find((c) => c.name === p.name)!;
      expect(p).toEqual({ name: source.name, slug: source.slug, title: source.title, description: source.description, published: false, url: `${SITE_URL}/plugins/${source.slug}/` });
    }
  });

  it('adds icon and version when the catalog has them, and publishes only on an explicit true', () => {
    const [p] = catalogFeed([{ slug: 'a', name: '@x/a', title: 'A', description: 'd', icon: 'https://x.test/a.svg', version: '1.2.3', published: true }]).plugins;
    expect(p).toEqual({ name: '@x/a', slug: 'a', title: 'A', description: 'd', icon: 'https://x.test/a.svg', version: '1.2.3', published: true, url: `${SITE_URL}/plugins/a/` });
    const [q] = catalogFeed([{ slug: 'b', name: 'b', title: 'B', description: '', icon: '', published: undefined }]).plugins;
    expect('icon' in q!).toBe(false);
    expect('version' in q!).toBe(false);
    expect(q!.published).toBe(false);
  });

  it('uses the given site address without doubling slashes, and is deterministic', () => {
    const a = catalogFeed(catalog.plugins, 'https://example.test/');
    expect(a.plugins[0]!.url).toBe(`https://example.test/plugins/${catalog.plugins[0]!.slug}/`);
    expect(JSON.stringify(catalogFeed(catalog.plugins))).toBe(JSON.stringify(catalogFeed(catalog.plugins)));
  });

  it('never names the private repository or calls a plugin open source or gives an install command', () => {
    const text = JSON.stringify(catalogFeed(catalog.plugins)).toLowerCase();
    expect(text).not.toContain('kinetograph-effects');
    expect(text).not.toContain('github.com');
    expect(text).not.toContain('open source');
    expect(text).not.toContain('npm install');
    expect(text).not.toContain('npm i ');
  });

  it('matches the copy bundled into Studio (run `npm run catalog -w @kinetographdev/studio` when this fails)', () => {
    const bundled = readFileSync(join(import.meta.dirname, '../../studio/catalog/plugins.json'), 'utf8');
    expect(JSON.parse(bundled)).toEqual(catalogFeed(catalog.plugins));
  });
});
