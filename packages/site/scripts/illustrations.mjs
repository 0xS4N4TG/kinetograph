// Draws the docs illustrations (src/lib/illustrations/*.ts) as static SVGs, a light and a -dark file for each, in
// public/docs-media/illustrations, and writes their size into manifest.json. Labels become outline paths in Kalam
// (SIL OFL), so an <img> shows them with no web font. Alt text comes from the manifest.
//
//   npm run illustrations
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { illustrations } from '../src/lib/illustrations/index.ts';
import { problems, svg, themes } from './lib/sketch-svg.mjs';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/docs-media/illustrations');
const manifestFile = resolve(dir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

let bad = 0;
for (const item of manifest.illustrations) {
  const made = illustrations[item.name];
  if (!made) throw new Error(`no drawing for ${item.name}`);
  const diagram = made.build(item.alt);
  for (const p of problems(diagram, item.name)) {
    console.warn(p);
    bad++;
  }
  for (const theme of Object.keys(themes)) {
    writeFileSync(resolve(dir, item.name + (theme === 'dark' ? '-dark' : '') + '.svg'), svg(diagram, theme, { title: made.title }));
  }
  item.width = diagram.width;
  item.height = diagram.height;
  console.log(`${item.name} ${diagram.width}x${diagram.height}`);
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
if (bad) process.exitCode = 1;
