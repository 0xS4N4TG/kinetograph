#!/usr/bin/env node
// node packages/cli/scripts/build-registry.mjs <items-dir> <out-dir>
// Builds the registry files (r/<name>.json, r/index.json, r/schema.json, r/files/…) from a folder of items in the
// layout of docs/registry.md. Needs the CLI built first: npm run build -w kinetograph.

import { resolve } from 'node:path';
import { buildRegistry } from '../dist/registry/build.js';

const [src, out] = process.argv.slice(2);
if (!src || !out || process.argv.length > 4) {
  console.error('usage: node packages/cli/scripts/build-registry.mjs <items-dir> <out-dir>');
  process.exit(2);
}
try {
  const { items, written } = buildRegistry(resolve(src), resolve(out));
  console.log(`built ${items.length} item${items.length === 1 ? '' : 's'} into ${resolve(out)}`);
  for (const file of written) console.log(`  ${file}`);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
