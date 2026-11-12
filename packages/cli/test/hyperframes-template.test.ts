// A page's `<template>`: `template.content.getElementById(...)` finds an element of the content, and
// `content.cloneNode(true)` appended to the page draws it. Drawn on the real addon through the built CLI; needs the
// built addon and `npm run build`, a GPU and ffmpeg.

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
const project = join(here, 'fixtures', 'hf-template');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const ready = addon && spawnSync('ffmpeg', ['-version']).status === 0 && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-template-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ready)("a page's <template>", () => {
  it('has a content fragment a script finds an element in and clones into the page', () => {
    const run = spawnSync(process.execPath, [cli, 'still', project, '0', '-o', join(dir, 'f0.png'), '--json'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toMatch(/getElementById is not a function/);
    const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'f0.png'), '-vf', 'crop=1:1:60:60', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
    // The card the script recoloured and cloned: green, not the template's red.
    expect([...out.subarray(0, 3)]).toEqual([0, 200, 0]);
  });
});
