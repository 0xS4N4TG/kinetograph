#!/usr/bin/env node
// Asks Chrome for Testing what `isPointInStroke` says for the cases of `stroke-cases.ts`, and writes the answers to
// `stroke-chrome.json`. Chrome is looked for in $KINETOGRAPH_CHROME and ~/.cache/kinetograph/chrome. Chrome is a test
// oracle here and nowhere else.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answers, cases, HEIGHT, WIDTH } from './stroke-cases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const chrome =
  process.env.KINETOGRAPH_CHROME ??
  execFileSync('find', [join(homedir(), '.cache/kinetograph/chrome'), '-name', 'Google Chrome for Testing', '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .find(Boolean);
if (!chrome) throw new Error('no Chrome for Testing; set KINETOGRAPH_CHROME');

const script = `
const WIDTH = ${WIDTH}, HEIGHT = ${HEIGHT};
const answers = ${answers.toString()};
const cases = [${cases.map(([name, setup]) => `[${JSON.stringify(name)}, ${setup.toString()}]`).join(',\n')}];
const out = {};
for (const [name, setup] of cases) {
  const c = document.createElement('canvas');
  c.width = WIDTH;
  c.height = HEIGHT;
  const ctx = c.getContext('2d');
  out[name] = answers(ctx, setup(ctx, Path2D));
}
document.getElementById('out').textContent = JSON.stringify(out);
`;
const dir = mkdtempSync(join(tmpdir(), 'stroke-chrome-'));
const page = join(dir, 'page.html');
writeFileSync(page, `<html><body><pre id="out"></pre><script>${script}</script></body></html>`);
const dom = execFileSync(chrome, ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--disable-gpu', '--dump-dom', `file://${page}`], {
  encoding: 'utf8',
  maxBuffer: 64 << 20,
});
const json = /<pre id="out">([^<]*)<\/pre>/.exec(dom)?.[1];
if (!json) throw new Error(`Chrome gave no answers:\n${dom.slice(0, 2000)}`);
writeFileSync(join(here, 'stroke-chrome.json'), `${JSON.stringify(JSON.parse(json.replaceAll('&quot;', '"')), null, 1)}\n`);
console.log(`wrote ${Object.keys(JSON.parse(json.replaceAll('&quot;', '"'))).length} cases`);
