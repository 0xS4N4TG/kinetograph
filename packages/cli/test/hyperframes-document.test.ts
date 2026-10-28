// A HyperFrames page that styles its own `html` and `body`: `:root` custom properties and font size (`rem`), `html >
// body`, classes on both, inheritance from `body`, `getComputedStyle(document.body)`, `document.documentElement.style`,
// `document.querySelector('body')` and `:root` from a script, and an element a script appends to `document.body`. The
// expected colours and boxes are what Chrome draws (HyperFrames' own still of the page, within 1 level). Drawn on the
// real addon through the built CLI; needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const project = join(here, 'fixtures', 'hf-document');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-document-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pixel(file: string, x: number, y: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
}

const near = (have: number[], want: number[]): void => have.forEach((v, i) => expect(Math.abs(v - want[i]!), `${have} vs ${want}`).toBeLessThanOrEqual(1));

describe.skipIf(!ready)("a HyperFrames page's own html and body", () => {
  it('are styled, inherited from, read and written as in a browser', () => {
    const run = spawnSync(process.execPath, [cli, 'still', project, '0', '-o', join(dir, 'f0.png')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    // The canvas takes `html`'s background.
    near(pixel('f0.png', 5, 170), [20, 30, 60]);
    // `.box`: 5rem wide at the `:root` font size of 20px, `var(--size)` tall as the script set it on
    // `document.documentElement`, coloured by `html.theme body.dark .box` with `--accent` from `html`'s style attribute.
    near(pixel('f0.png', 105, 65), [220, 40, 40]);
    near(pixel('f0.png', 115, 40), [20, 30, 60]);
    near(pixel('f0.png', 60, 75), [20, 30, 60]);
    // `getComputedStyle(document.body).color` (from `html > body`), `--accent` read from `document.documentElement`.
    near(pixel('f0.png', 225, 35), [0, 200, 0]);
    near(pixel('f0.png', 225, 105), [220, 40, 40]);
    // `document.querySelector('body')` and `document.querySelector(':root')` are the page's.
    near(pixel('f0.png', 285, 105), [0, 120, 255]);
    // An element appended to `document.body` matches `body > .appended`.
    near(pixel('f0.png', 290, 20), [255, 255, 0]);
  });
});
