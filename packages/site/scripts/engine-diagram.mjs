// Writes the README's engine diagram as two static SVGs (light and dark): docs/readme/engine-light.svg and
// engine-dark.svg. It draws the same shapes as the docs site (src/lib/engine-diagram.ts) and turns every label into
// outline paths with opentype.js and Kalam (SIL OFL), so GitHub shows it exactly as drawn, with no web font needed.
//
//   npm run engine-diagram
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDiagram } from '../src/lib/engine-diagram.ts';
import { svg, themes } from './lib/sketch-svg.mjs';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/readme');
const diagram = buildDiagram();

mkdirSync(outDir, { recursive: true });
for (const theme of Object.keys(themes)) {
  const file = resolve(outDir, `engine-${theme}.svg`);
  writeFileSync(file, svg(diagram, theme, { title: 'How Kinetograph makes a frame', rx: 16 }));
  console.log(file);
}
