// Writes catalog/plugins.json, the plugin list Studio falls back on when the site cannot be reached and nothing is cached.
// It is the site's own feed: the function behind https://kinetograph.dev/api/catalog (packages/site/src/lib/catalog-feed.ts)
// run over packages/site/content/catalog.json, so the route and this copy cannot differ. Run it after the site catalog changes:
//   npm run catalog -w @kinetographdev/studio          (writes)
//   node scripts/sync-catalog.mjs --check              (exits 1 when the committed copy is stale)
// Needs Node 22.18 or newer (it loads the site's TypeScript with type stripping).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '../../site');
const target = join(here, '../catalog/plugins.json');

const { catalogFeed } = await import(join(site, 'src/lib/catalog-feed.ts'));
const catalog = JSON.parse(readFileSync(join(site, 'content/catalog.json'), 'utf8'));
const text = `${JSON.stringify(catalogFeed(catalog.plugins), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== text) {
    console.error('packages/studio/catalog/plugins.json is out of date: run `npm run catalog -w @kinetographdev/studio`');
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}`);
}
