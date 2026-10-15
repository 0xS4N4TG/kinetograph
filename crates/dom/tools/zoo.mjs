#!/usr/bin/env node
// Writes a set of layout test islands (IslandRequest JSON) to a directory, to be compared with Chrome by
// chrome-compare.mjs:
//
//   node crates/dom/tools/zoo.mjs <out-dir> && node crates/dom/tools/chrome-compare.mjs <out-dir>
//
// Each island exercises one family of CSS layout: block and margins, flex, grid, inline text, positioning, floats,
// tables, replaced elements, units, transforms.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const out = process.argv[2];
if (!out) {
  console.error('usage: zoo.mjs <out-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const fonts = {
  'DM Sans': join(repo, 'assets/fonts/DMSans-Medium.ttf'),
  'Inter:800': join(repo, 'crates/dom/tests/fixtures/fonts/inter-800-latin.woff2'),
  'Archivo Black': join(repo, 'crates/dom/tests/fixtures/fonts/archivo-black-400-latin.woff2'),
  'JetBrains Mono:700': join(repo, 'crates/dom/tests/fixtures/fonts/jetbrains-mono-700-latin.woff2'),
};

let counter = 0;
const next = () => `$${counter++}`;
// el(tag, style, children, attrs): paths are assigned by `finish`.
const el = (tag, style = '', children = [], attrs = {}) => ({ kind: 'element', tag, path: '', attrs, style, children });
const text = (t) => ({ kind: 'text', text: t });
const div = (style, ...children) => el('div', style, children);
const span = (style, ...children) => el('span', style, children);

function assign(node, path) {
  if (node.kind === 'element') {
    node.path = path;
    node.children.forEach((c, i) => assign(c, `${path}.${i}`));
  } else if (node.kind === 'native') node.path = path;
}

const LOREM = 'The quick brown fox jumps over the lazy dog and keeps running through the quiet field until night.';
const base = 'font-family: "DM Sans"; font-size: 18px; line-height: 1.4;';

function write(name, root, { viewport = { width: 800, height: 600 }, stylesheets = [] } = {}) {
  assign(root, '$0');
  const request = { root, stylesheets, viewport, fonts, baseDir: repo, time: 0, path: '$0' };
  writeFileSync(join(out, `${String(counter++).padStart(2, '0')}-${name}.json`), JSON.stringify(request));
}

// ---- block ----
write(
  'margins',
  div(
    `${base} padding: 10px`,
    div('margin: 20px 0 30px; height: 40px; background: #ccc'),
    div('margin: 10px 0 25px; height: 40px'),
    div('margin-top: -15px; height: 30px'),
    div('', div('margin-top: 30px; height: 20px'), div('margin-bottom: 40px; height: 20px')),
    div('height: 0; margin: 12px 0'),
    div('overflow: hidden', div('margin-top: 22px; height: 10px')),
    div('width: 50%; margin: 0 auto; height: 20px'),
    div('width: 300px; margin-left: auto; height: 20px'),
    div('padding: 5%; border: 4px solid; height: 30px'),
    div('box-sizing: border-box; width: 200px; padding: 10px; border: 5px solid; height: 60px'),
    div('min-width: 400px; max-width: 250px; height: 10px'),
    div('width: 100px; min-height: 50px; max-height: 20px'),
  ),
);

write(
  'text-blocks',
  div(
    `${base} width: 500px`,
    el('h1', '', [text('A heading that is long enough to wrap onto a second line')]),
    el('p', '', [text(LOREM)]),
    el('p', 'text-align: justify', [text(LOREM + ' ' + LOREM)]),
    el('p', 'text-align: right; text-indent: 30px', [text(LOREM)]),
    el('blockquote', '', [text('Quote ' + LOREM)]),
    el('ul', '', [el('li', '', [text('first item')]), el('li', '', [text('second item that is quite a bit longer than the first one is')])]),
    el('ol', '', [el('li', '', [text('one')]), el('li', '', [text('two')])]),
    el('hr'),
    el('pre', '', [text('pre  formatted\n   text')]),
    el('h3', '', [text('Third')]),
    el('h6', '', [text('Sixth')]),
  ),
);

write(
  'inline',
  div(
    `${base} width: 420px`,
    text('Before '),
    span('padding: 2px 8px; border: 1px solid; margin: 0 4px', text('a padded span that wraps across the end of the line')),
    text(' after, '),
    el('b', '', [text('bold')]),
    text(' '),
    el('i', '', [text('italic')]),
    text(' '),
    el('code', '', [text('code()')]),
    text(' and '),
    span('display: inline-block; width: 60px; height: 30px; background: #ddd; vertical-align: middle', text('')),
    text(' inline-block '),
    span('display: inline-block; width: 50px; height: 50px; vertical-align: top'),
    text(' top '),
    span('font-size: 36px', text('Big')),
    text(' small '),
    el('sup', '', [text('sup')]),
    el('sub', '', [text('sub')]),
    el('br'),
    text('after break'),
  ),
);

write(
  'text-props',
  div(
    `${base} width: 500px`,
    div('letter-spacing: 3px', text('letter spacing here')),
    div('word-spacing: 12px', text('word spacing here for the words')),
    div('text-transform: uppercase', text('upper case text')),
    div('white-space: pre-wrap', text('pre   wrap\n  keeps   spaces and wraps when the line is too long to fit the box we gave it')),
    div('white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 200px', text(LOREM)),
    div('font-size: 11px; line-height: 1', text('small tight text')),
    div('font-size: 40px; line-height: 60px', text('Tall lines')),
    div('direction: rtl; text-align: start', text('rtl text')),
    div('font-family: "Inter"; font-weight: 800; font-size: 28px', text('Inter eight hundred')),
    div('font-family: "Archivo Black"; font-size: 28px; letter-spacing: -1px', text('Archivo Black')),
    div('font-family: "JetBrains Mono"; font-weight: 700; font-size: 16px', text('monospace text 0123456789')),
    div('font-variant-numeric: tabular-nums; font-feature-settings: "tnum"', text('1111 0000')),
    div('word-break: break-all; width: 120px', text('Supercalifragilisticexpialidocious')),
    div('overflow-wrap: anywhere; width: 120px', text('Supercalifragilisticexpialidocious')),
    div('hyphens: manual; width: 90px', text('soft­hyphen­ated word')),
    div('text-wrap: balance; width: 300px', text(LOREM)),
  ),
);

// ---- flex ----
const item = (style, label) => div(`background: #bbb; ${style}`, text(label));
write(
  'flex-row',
  div(
    `${base} display: flex; width: 700px; gap: 10px; padding: 10px; flex-wrap: wrap; align-items: flex-start`,
    item('flex: 1', 'one'),
    item('flex: 2 1 100px', 'two with more text inside it'),
    item('width: 120px; flex-shrink: 0', 'fixed'),
    item('flex: 0 0 30%; align-self: center; height: 80px', 'centre'),
    item('flex: 1 1 200px; order: -1', 'first'),
    item('margin-left: auto', 'auto'),
    item('min-width: 250px; flex: 0 1 100px', 'min'),
  ),
);
write(
  'flex-column',
  div(
    `${base} display: flex; flex-direction: column; height: 500px; width: 400px; justify-content: space-between; align-items: stretch`,
    item('', 'top'),
    item('flex: 1; min-height: 0', 'grows'),
    item('align-self: flex-end; width: 100px', 'end'),
    div('display: flex; justify-content: space-around', item('', 'a'), item('', 'b'), item('', 'c')),
    div('display: flex; justify-content: center; align-items: baseline', item('font-size: 30px', 'big'), item('font-size: 12px', 'small')),
  ),
);
write(
  'flex-nested',
  div(
    `${base} display: flex; width: 760px; height: 400px`,
    div('display: flex; flex-direction: column; flex: 1', item('flex: 1', 'a'), item('flex: 2', 'b')),
    div('display: flex; flex: 2; align-items: center; justify-content: center', item('padding: 20px', 'centered')),
    div('flex: 1; display: flex; flex-wrap: wrap-reverse; align-content: space-between', item('width: 40%', '1'), item('width: 40%', '2'), item('width: 40%', '3')),
  ),
);

// ---- grid ----
write(
  'grid',
  div(
    `${base} width: 760px`,
    div(
      'display: grid; grid-template-columns: 100px 1fr 2fr; gap: 10px 20px; padding: 5px',
      item('', '1'),
      item('grid-column: span 2', 'span two'),
      item('grid-row: span 2; height: 90px', 'tall'),
      item('', '4'),
      item('grid-column: 2 / -1', 'wide'),
    ),
    div(
      'display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 12px',
      ...Array.from({ length: 11 }, (_, i) => item('', `cell ${i}`)),
    ),
    div(
      'display: grid; grid-template-areas: "h h" "s m" "f f"; grid-template-columns: 150px 1fr; grid-template-rows: auto 1fr auto; height: 300px; margin-top: 12px; gap: 6px',
      item('grid-area: h', 'header'),
      item('grid-area: s', 'side'),
      item('grid-area: m', 'main'),
      item('grid-area: f', 'footer'),
    ),
    div(
      'display: grid; grid-auto-flow: column dense; grid-auto-columns: 80px; grid-template-rows: repeat(3, 40px); place-items: center; place-content: center; height: 200px; margin-top: 12px',
      ...Array.from({ length: 7 }, (_, i) => item('width: 30px; height: 20px', `${i}`)),
    ),
    div('display: grid; grid-template-columns: min-content max-content auto; width: 500px', item('', 'min content text'), item('', 'max content text here'), item('', 'auto')),
    div('display: grid; place-items: center; width: 300px; height: 100px', item('padding: 4px', 'centered')),
  ),
);

// ---- positioning ----
write(
  'positioned',
  div(
    `${base} position: relative; height: 560px; width: 700px`,
    div('position: absolute; top: 10px; left: 20px; width: 100px; height: 50px; background: #ccc', text('tl')),
    div('position: absolute; bottom: 10px; right: 10%; width: 20%; height: 15%', text('br')),
    div('position: absolute; inset: 100px 50px 200px 150px', text('inset')),
    div('position: absolute; left: 0; right: 0; top: 300px; margin: 0 auto; width: 200px; height: 30px', text('auto margins')),
    div('position: absolute; top: 50%; left: 50%; translate: -50% -50%; width: 120px; height: 60px', text('centred')),
    div('position: relative; top: 430px; left: 12px; width: 150px; height: 40px', text('relative')),
    div(
      'position: absolute; top: 470px; left: 300px; width: 250px; padding: 10px',
      div('position: absolute; right: 0; top: 0; width: 40px; height: 40px', text('in')),
      div('height: 60px', text('static child')),
    ),
    div('position: absolute; top: 330px; left: 20px; width: min-content', text('shrink to fit text')),
    div('position: fixed; top: 5px; right: 5px; width: 30px; height: 30px', text('fx')),
  ),
);

write(
  'floats',
  div(
    `${base} width: 500px`,
    div('float: left; width: 100px; height: 80px; margin: 0 10px 10px 0; background: #ccc'),
    div('float: right; width: 60px; height: 120px; margin-left: 10px; background: #bbb'),
    text(LOREM + ' ' + LOREM),
    div('clear: both; height: 20px'),
    div('overflow: hidden', div('float: left; width: 50px; height: 70px'), text('contained by overflow')),
  ),
);

write(
  'tables',
  div(
    `${base} width: 600px`,
    el('table', 'border-collapse: collapse; width: 100%', [
      el('tr', '', [el('th', 'border: 1px solid; padding: 4px', [text('Name')]), el('th', 'border: 1px solid; padding: 4px', [text('Value')])]),
      el('tr', '', [el('td', 'border: 1px solid; padding: 4px', [text('alpha')]), el('td', 'border: 1px solid; padding: 4px; text-align: right', [text('1')])]),
      el('tr', '', [el('td', 'border: 1px solid; padding: 4px', [text('a much longer name for a cell')]), el('td', 'border: 1px solid; padding: 4px', [text('22')])]),
    ]),
    div('display: table; width: 300px; margin-top: 12px', div('display: table-row', div('display: table-cell; padding: 6px', text('x')), div('display: table-cell; padding: 6px', text('yy')))),
  ),
);

// ---- replaced and units ----
write(
  'replaced',
  div(
    `${base} width: 700px`,
    el('img', 'display: block', [], { src: join(repo, 'crates/dom/tests/fixtures/none.png'), width: '120', height: '60' }),
    el('svg', 'display: block; background: #eee', [el('rect', '', [], { width: '20', height: '20', fill: 'red' })], { width: '200', height: '80', viewBox: '0 0 20 8' }),
    el('svg', 'width: 50%', [el('circle', '', [], { cx: '10', cy: '10', r: '9' })], { viewBox: '0 0 20 10' }),
    div('aspect-ratio: 16 / 9; width: 320px'),
    div('width: 40%; aspect-ratio: 2; max-height: 60px'),
    el('video', 'display: block; width: 300px', [], {}),
    el('button', '', [text('Button')]),
    el('input', '', [], { type: 'text', value: 'text' }),
  ),
);

write(
  'units',
  div(
    `${base} font-size: 20px`,
    div('width: 10em; height: 2rem'),
    div('width: 50vw; height: 10vh'),
    div('width: 40vmin; height: 5vmax'),
    div('width: calc(100% - 3em + 5px); height: calc(2 * 10px)'),
    div('width: min(300px, 50%); height: max(10px, 2ch)'),
    div('width: clamp(100px, 20vw, 400px); height: 1lh'),
    div('--x: 15px; width: var(--x); height: calc(var(--x) * 2)'),
    div('width: 12ch; height: 1ex'),
    div('width: 1in; height: 1cm; margin: 1mm'),
    div('width: 25.5pt; height: 3pc'),
  ),
);

write(
  'overflow',
  div(
    `${base} width: 400px`,
    div('width: 100px; height: 50px; overflow: auto', div('width: 300px; height: 200px')),
    div('width: 100px; height: 50px; overflow: hidden; border: 3px solid; padding: 4px', div('width: 300px; height: 200px')),
    div('width: 100px; height: 50px; overflow: visible', div('width: 300px; height: 200px')),
  ),
);

// ---- transforms ----
write(
  'transforms',
  div(
    `${base} position: relative; height: 560px`,
    div('position: absolute; left: 20px; top: 20px; width: 100px; height: 50px; transform: rotate(30deg)'),
    div('position: absolute; left: 200px; top: 20px; width: 100px; height: 50px; transform: scale(1.5, 0.5) skewX(20deg)'),
    div('position: absolute; left: 400px; top: 20px; width: 100px; height: 50px; transform: rotateX(50deg); transform-origin: top'),
    div('position: absolute; left: 20px; top: 200px; width: 100px; height: 100px; transform: perspective(300px) rotateY(40deg) translateZ(30px)'),
    div('position: absolute; left: 300px; top: 200px; width: 120px; height: 80px; translate: 20px 10px; rotate: 15deg; scale: 1.2'),
    div(
      'position: absolute; left: 500px; top: 200px; width: 100px; height: 100px; perspective: 400px',
      div('width: 100px; height: 100px; transform: rotateY(60deg); transform-origin: left'),
    ),
    div(
      'position: absolute; left: 20px; top: 400px; width: 200px; height: 100px; transform: rotate(10deg)',
      div('width: 80px; height: 30px; margin-left: 20px; transform: scale(2)'),
    ),
    div('position: absolute; left: 400px; top: 400px; width: 100px; height: 100px; transform: matrix(1, 0.3, -0.3, 1, 10, 5); transform-origin: 0 0'),
  ),
);

write(
  'display-misc',
  div(
    `${base} width: 500px`,
    div('display: none; height: 100px'),
    div('display: contents', div('height: 20px; background: #ccc'), div('height: 20px')),
    div('display: inline-flex; gap: 4px', item('', 'a'), item('', 'b')),
    div('display: inline-grid; grid-template-columns: 30px 30px', item('', 'x'), item('', 'y')),
    div('display: flow-root', div('float: left; width: 30px; height: 30px')),
    div('visibility: hidden; height: 10px'),
    div('display: list-item; margin-left: 20px', text('list item')),
    el('details', '', [el('summary', '', [text('Summary')]), div('', text('Hidden content'))]),
  ),
);

write(
  'tailwind-ish',
  div(
    `${base}`,
    div('class', text('')),
    div(
      'display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid #ddd',
      span('font-weight: 700; font-size: 20px', text('Brand')),
      div('display: flex; gap: 16px', ...['Home', 'Docs', 'Pricing', 'Blog'].map((t) => span('', text(t)))),
    ),
    div(
      'max-width: 640px; margin: 0 auto; padding: 32px 16px; text-align: center',
      el('h1', 'font-size: 48px; line-height: 1; margin: 0 0 16px', [text('Build things')]),
      el('p', 'color: #555; margin: 0 0 24px', [text(LOREM)]),
      div('display: inline-block; padding: 12px 24px; border-radius: 8px; background: #222; color: #fff', text('Get started')),
    ),
    div(
      'display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 0 24px',
      ...Array.from({ length: 3 }, (_, i) => div('border: 1px solid #ddd; border-radius: 8px; padding: 16px', el('h3', 'margin: 0 0 8px', [text(`Card ${i}`)]), el('p', 'margin: 0', [text(LOREM.slice(0, 40 + i * 20))]))),
    ),
  ),
);

console.log(`wrote ${counter} islands to ${out}`);
