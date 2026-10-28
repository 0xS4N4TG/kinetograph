#!/usr/bin/env node
// Records what Chrome for Testing computes for the Web Animations cases in ../test/fixtures/waapi-cases.json: for each
// case and time, an element (200 x 100 in a 400 x 300 box) is animated, paused and seeked, and its computed value of the
// property is kept. The test (packages/react/test/waapi-native.test.tsx) checks the engine's values against these.
//
//   node packages/compat/tools/waapi-chrome.mjs > packages/compat/test/fixtures/waapi-chrome.json
//
// Chrome is looked for in $KINETOGRAPH_CHROME and ~/.cache/kinetograph/chrome. Tests may use Chrome; the engine never does.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const cases = JSON.parse(readFileSync(join(here, '../test/fixtures/waapi-cases.json'), 'utf8'));

function findChrome() {
  if (process.env.KINETOGRAPH_CHROME && existsSync(process.env.KINETOGRAPH_CHROME)) return process.env.KINETOGRAPH_CHROME;
  const found = execFileSync('find', [join(homedir(), '.cache/kinetograph/chrome'), '-name', 'Google Chrome for Testing', '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .find(Boolean);
  if (!found) throw new Error('no Chrome for Testing; set KINETOGRAPH_CHROME');
  return found;
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body style="margin:0"><div id="box" style="position:relative;width:400px;height:300px"></div></body></html>');
const version = await browser.version();
const results = await page.evaluate((cases) => {
  const out = [];
  for (const c of cases) {
    const values = [];
    for (const t of c.times) {
      const box = document.getElementById('box');
      box.innerHTML = '';
      const el = document.createElement('div');
      el.style.width = '200px';
      el.style.height = '100px';
      for (const [k, v] of Object.entries(c.style ?? {})) el.style.setProperty(k, v);
      box.appendChild(el);
      const animations = [el.animate(c.keyframes, c.options)];
      if (c.second) animations.push(el.animate(c.second.keyframes, c.second.options));
      for (const a of animations) {
        a.pause();
        if (c.playbackRate !== undefined) a.playbackRate = c.playbackRate;
        a.currentTime = t;
      }
      values.push(getComputedStyle(el).getPropertyValue(c.property));
      for (const a of animations) a.cancel();
    }
    out.push({ name: c.name, values });
  }
  return out;
}, cases);
console.log(JSON.stringify({ chrome: version, results }, null, 1));
await browser.close();
