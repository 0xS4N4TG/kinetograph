#!/usr/bin/env node
// Compares the layout the DOM engine makes (domLayoutBoxes) with Chrome's for the same islands.
//
//   node crates/dom/tools/chrome-compare.mjs <island.json | directory of them> [--tolerance 1] [--verbose]
//
// An island file is an IslandRequest as JSON (packages/cli/skills/kinetograph/references/ENGINE.md §2), e.g. what `renderDomIsland` is called with. Chrome
// gets the same tree built with createElementNS in a page of its own (body margin 0, a `position: relative` box of
// the viewport's size, `@font-face` for each registered font, `<base>` at baseDir), and `getBoundingClientRect` of
// every element with a host-tree path is compared with the engine's `rect`. Chrome for Testing is looked for in
// $KINETOGRAPH_CHROME and ~/.cache/kinetograph/chrome. Tests and this tool may use Chrome; the engine never does.
//
// Needs the addon built (`npm run build:release -w crates/node`) and `npm ci` for puppeteer-core.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const native = require(resolve(here, '../../node/index.js'));
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const tolerance = Number(flag('tolerance', '1'));
const verbose = args.includes('--verbose');
const inputs = args.filter((a, i) => !a.startsWith('--') && !['--tolerance'].includes(args[i - 1]));
if (inputs.length === 0) {
  console.error('usage: chrome-compare.mjs <island.json | directory> [--tolerance px] [--verbose]');
  process.exit(2);
}

function findChrome() {
  if (process.env.KINETOGRAPH_CHROME && existsSync(process.env.KINETOGRAPH_CHROME)) return process.env.KINETOGRAPH_CHROME;
  const found = execFileSync('find', [join(homedir(), '.cache/kinetograph/chrome'), '-name', 'Google Chrome for Testing', '-type', 'f'], {
    encoding: 'utf8',
  })
    .split('\n')
    .find(Boolean);
  if (!found) throw new Error('no Chrome for Testing; set KINETOGRAPH_CHROME');
  return found;
}

const files = inputs.flatMap((p) =>
  statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => join(p, f)) : [p],
);

/** `Inter:800i` -> { family: 'Inter', weight: 800, style: 'italic' } (fontKey of @kinetograph/scene). */
function parseKey(key) {
  const m = /^(.*):(\d+)(i?)$/.exec(key);
  return m ? { family: m[1], weight: Number(m[2]), style: m[3] ? 'italic' : 'normal' } : { family: key, weight: 400, style: 'normal' };
}

function pageHtml(req) {
  const faces = Object.entries(req.fonts ?? {})
    .map(([key, file]) => {
      const { family, weight, style } = parseKey(key);
      return `@font-face { font-family: ${JSON.stringify(family)}; font-weight: ${weight}; font-style: ${style}; src: url(${JSON.stringify(
        pathToFileURL(resolve(req.baseDir, file)).href,
      )}); }`;
    })
    .join('\n');
  const sheets = (req.stylesheets ?? []).map((css) => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`).join('\n');
  const base = pathToFileURL(req.baseDir.endsWith('/') ? req.baseDir : `${req.baseDir}/`).href;
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><style>${faces}\nkg-native{display:block}</style>${sheets}</head>
<body style="margin:0"><div id="kg-island" style="position:relative;display:block;width:${req.viewport.width}px;height:${req.viewport.height}px"></div></body></html>`;
}

/** Runs in the page: builds the tree, waits for fonts and images, measures every element with a path. */
async function measure(root) {
  const SVG = 'http://www.w3.org/2000/svg';
  const paths = new Map();
  function build(node, inSvg) {
    if (node.kind === 'text') return document.createTextNode(node.text);
    if (node.kind === 'native') {
      const el = document.createElement('kg-native');
      el.style.cssText = `width: ${node.width ?? 0}px; height: ${node.height ?? 0}px`;
      paths.set(node.path, el);
      return el;
    }
    if (node.tag === 'script') return document.createComment('script');
    const svg = inSvg || node.tag === 'svg';
    const el = svg ? document.createElementNS(SVG, node.tag) : document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      if (name === 'style') continue;
      if (name.startsWith('xlink:')) el.setAttributeNS('http://www.w3.org/1999/xlink', name, value);
      else el.setAttribute(name, value);
    }
    if (node.style && node.style.trim() !== '') el.setAttribute('style', node.style);
    paths.set(node.path, el);
    const childSvg = svg && node.tag !== 'foreignObject';
    for (const child of node.children ?? []) el.appendChild(build(child, childSvg));
    return el;
  }
  const island = document.getElementById('kg-island');
  island.appendChild(build(root, false));
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => ((i.onload = ok), (i.onerror = ok))))));
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  const origin = island.getBoundingClientRect();
  const out = {};
  for (const [path, el] of paths) {
    const r = el.getBoundingClientRect();
    out[path] = {
      tag: el.localName,
      rect: { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height },
      offset: el.offsetWidth === undefined ? null : { width: el.offsetWidth, height: el.offsetHeight },
    };
  }
  return out;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-mock-keychain', '--password-store=basic', '--allow-file-access-from-files', '--disable-web-security', '--no-sandbox', '--font-render-hinting=none'],
});
const dir = mkdtempSync(join(tmpdir(), 'kg-compare-'));
let worst = 0;
let bad = 0;
let total = 0;
try {
  for (const file of files) {
    const req = JSON.parse(readFileSync(file, 'utf8'));
    const ours = JSON.parse(native.domLayoutBoxes(JSON.stringify(req)));
    const page = await browser.newPage();
    await page.setViewport({ width: Math.ceil(req.viewport.width), height: Math.ceil(req.viewport.height) });
    const html = join(dir, 'page.html');
    writeFileSync(html, pageHtml(req));
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    const chrome = await page.evaluate(measure, req.root);
    await page.close();

    const rows = [];
    for (const [path, c] of Object.entries(chrome)) {
      const o = ours[path];
      if (!o) continue;
      const d = Math.max(
        Math.abs(o.rect.x - c.rect.x),
        Math.abs(o.rect.y - c.rect.y),
        Math.abs(o.rect.width - c.rect.width),
        Math.abs(o.rect.height - c.rect.height),
      );
      total++;
      worst = Math.max(worst, d);
      if (d > tolerance) {
        bad++;
        rows.push({ path, tag: c.tag, d, ours: o.rect, chrome: c.rect });
      }
    }
    const f = (r) => `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`;
    console.log(`${file}: ${Object.keys(chrome).length} elements, ${rows.length} differ by more than ${tolerance}px`);
    for (const r of rows.slice(0, verbose ? 1000 : 6)) console.log(`   ${r.path} <${r.tag}> ours ${f(r.ours)}  chrome ${f(r.chrome)}  (${r.d.toFixed(1)})`);
  }
} finally {
  await browser.close();
}
console.log(`\n${total} elements in ${files.length} islands, ${bad} differ by more than ${tolerance}px, worst ${worst.toFixed(2)}px`);
