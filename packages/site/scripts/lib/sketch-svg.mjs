// Turns a sketched diagram (src/lib/sketch.ts) into a static SVG. Every label becomes outline paths, made with
// opentype.js and Kalam (SIL OFL), so the picture looks the same everywhere with no web font needed. Shared by
// engine-diagram.mjs (the README) and illustrations.mjs (the docs).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';

const fontDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@fontsource/kalam/files');

export const fonts = Object.fromEntries(
  [300, 400, 700].map((weight) => {
    const buf = readFileSync(resolve(fontDir, `kalam-latin-${weight}-normal.woff`));
    return [weight, opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))];
  }),
);

export const themes = {
  light: { paper: '#fbf8f0', ink: '#1d1b18', muted: '#6a6459' },
  dark: { paper: '#17171a', ink: '#ecebe8', muted: '#9d9a93' },
};

function textWidth(l) {
  return fonts[l.weight].getAdvanceWidth(l.text, l.size);
}

function labelPath(l) {
  const width = textWidth(l);
  const x = l.anchor === 'middle' ? l.x - width / 2 : l.anchor === 'end' ? l.x - width : l.x;
  const d = fonts[l.weight].getPath(l.text, x, l.y, l.size).toPathData(1);
  return { d, rotate: `rotate(${l.rot} ${l.x} ${l.y})` };
}

/** Where a label sits on the page, for the checks below. */
function span(l) {
  const w = textWidth(l);
  const x0 = l.anchor === 'middle' ? l.x - w / 2 : l.anchor === 'end' ? l.x - w : l.x;
  return { x0, x1: x0 + w, y0: l.y - l.size * 0.85, y1: l.y + l.size * 0.3 };
}

/** Labels that run off the picture, outgrow their box or sit on another label. */
export function problems(diagram, name) {
  const out = [];
  const spans = diagram.labels.map((l) => ({ l, ...span(l) }));
  for (const s of spans) {
    const at = `${name}: "${s.l.text}"`;
    if (s.x0 < 6 || s.x1 > diagram.width - 6 || s.y0 < 2 || s.y1 > diagram.height - 2) out.push(`${at} leaves the picture`);
    if (s.l.fit && s.x1 - s.x0 > s.l.fit) out.push(`${at} is ${Math.round(s.x1 - s.x0)} wide, its box allows ${s.l.fit}`);
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.x0 < b.x1 - 2 && b.x0 < a.x1 - 2 && a.y0 < b.y1 - 2 && b.y0 < a.y1 - 2) out.push(`${name}: "${a.l.text}" overlaps "${b.l.text}"`);
    }
  }
  return out;
}

/** `rx` rounds the paper; leave it 0 where the page already clips the picture. */
export function svg(diagram, theme, { title, rx = 0 }) {
  const c = themes[theme];
  const { width, height } = diagram;
  const paths = diagram.ink
    .map((p) => {
      const stroke = p.tone === 'muted' ? ` stroke="${c.muted}"` : '';
      return `<path d="${p.d}" stroke-width="${p.w}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''}${stroke}/>`;
    })
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
<title>${title}</title>
<desc>${diagram.alt}</desc>
<rect width="${width}" height="${height}"${rx ? ` rx="${rx}"` : ''} fill="${c.paper}"/>
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
