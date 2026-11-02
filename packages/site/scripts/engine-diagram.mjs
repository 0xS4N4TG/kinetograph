// Writes the README's engine diagram as two static SVGs (light and dark): docs/readme/engine-light.svg and
// engine-dark.svg. It draws the same shapes as the docs site (src/lib/engine-diagram.ts) and turns every label into
// outline paths with opentype.js and Kalam (SIL OFL), so GitHub shows it exactly as drawn, with no web font needed.
//
//   npm run engine-diagram
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';

import { buildDiagram } from '../src/lib/engine-diagram.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../docs/readme');
const fontDir = resolve(here, '../node_modules/@fontsource/kalam/files');

const fonts = Object.fromEntries(
  [300, 400, 700].map((weight) => {
    const buf = readFileSync(resolve(fontDir, `kalam-latin-${weight}-normal.woff`));
    return [weight, opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))];
  }),
);

const themes = {
  light: { paper: '#fbf8f0', ink: '#1d1b18', muted: '#6a6459' },
  dark: { paper: '#17171a', ink: '#ecebe8', muted: '#9d9a93' },
};

const diagram = buildDiagram();

function labelPath(l) {
  const font = fonts[l.weight];
  const width = font.getAdvanceWidth(l.text, l.size);
  const x = l.anchor === 'middle' ? l.x - width / 2 : l.x;
  const d = font.getPath(l.text, x, l.y, l.size).toPathData(1);
  return { d, rotate: `rotate(${l.rot} ${l.x} ${l.y})` };
}

function svg(theme) {
  const c = themes[theme];
  const { width, height } = diagram;
  const paths = diagram.ink
    .map((p) => `<path d="${p.d}" stroke-width="${p.w}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''}/>`)
    .join('\n');
  const text = (tone) =>
    diagram.labels
      .filter((l) => l.tone === tone)
      .map((l) => {
        const { d, rotate } = labelPath(l);
        return `<path d="${d}" transform="${rotate}"/>`;
      })
      .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
<title>How Kinetograph makes a frame</title>
<desc>${diagram.alt}</desc>
<rect width="${width}" height="${height}" rx="16" fill="${c.paper}"/>
<g fill="none" stroke="${c.ink}" stroke-linecap="round" stroke-linejoin="round">
${paths}
</g>
<g fill="${c.ink}">
${text('ink')}
</g>
<g fill="${c.muted}">
${text('muted')}
</g>
</svg>
`;
}

mkdirSync(outDir, { recursive: true });
for (const theme of Object.keys(themes)) {
  const file = resolve(outDir, `engine-${theme}.svg`);
  writeFileSync(file, svg(theme));
  console.log(file);
}
