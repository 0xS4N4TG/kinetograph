// SVG that a script builds after load is styled by the page's CSS like any other: rules from a <style> tag (@media ones
// too, and transform, filter and clip-path) reach shapes made with createElementNS in an effect and with d3-selection.
// Runs `kinetograph still` on the built CLI and the real addon, so it needs `npm run build` and a GPU; skipped where
// one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodePng, type Rgba } from '../src/png.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
// KINETOGRAPH_TEST_ADDON points the CLI at a freshly built .node file (vitest's own loader reads NAPI_RS_NATIVE_LIBRARY_PATH too).
const testAddon = process.env.KINETOGRAPH_TEST_ADDON;
const addon = (() => {
  if (testAddon !== undefined) return existsSync(testAddon);
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const hasD3 = (() => {
  try {
    createRequire(import.meta.url).resolve('d3-selection');
    return true;
  } catch {
    return false;
  }
})();
const ready = addon && existsSync(cli);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-svg-script-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function still(project: string, args: string[]): Rgba {
  const out = join(dir, `${Math.random().toString(36).slice(2)}.png`);
  const env = testAddon === undefined ? process.env : { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: testAddon };
  const run = spawnSync(process.execPath, [cli, 'still', project, '0', ...args, '-o', out], { encoding: 'utf8', env });
  expect(run.status, run.stderr).toBe(0);
  return decodePng(readFileSync(out));
}

const at = (img: Rgba, x: number, y: number): [number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};
const near = (got: [number, number, number], want: [number, number, number]): void => {
  for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!), `${got} vs ${want}`).toBeLessThanOrEqual(8);
};
const WHITE: [number, number, number] = [255, 255, 255];
const ORANGE: [number, number, number] = [255, 165, 0];

describe.skipIf(!ready)('SVG a script builds', () => {
  const project = join(here, 'fixtures', 'svg-script', 'index.tsx');

  it('takes the page CSS when made with createElementNS in a layout effect, @media rules included', () => {
    const img = still(project, ['--comp', 'Plain']);
    near(at(img, 100, 40), ORANGE); // the .arc path's stroke
    near(at(img, 40, 30), [0, 170, 0]); // the .dot circle's fill
    near(at(img, 135, 20), [255, 0, 255]); // @media (min-width: 100px) holds
    near(at(img, 175, 20), [0, 0, 0]); // @media (max-width: 10px) does not
  });

  it.skipIf(!hasD3)('takes the page CSS when made with d3-selection', () => {
    const img = still(project, ['--comp', 'D3']);
    near(at(img, 25, 90), [170, 0, 0]); // .chart .bar, a rule that crosses from the HTML into the svg
    near(at(img, 100, 10), ORANGE);
    near(at(img, 300, 150), WHITE);
  });
});

describe.skipIf(!ready)('a HyperFrames page whose script adds SVG shapes', () => {
  const project = join(here, 'fixtures', 'hf-svg-css');

  it('gets fills, strokes, @media rules, transform, filter and clip-path from the composition CSS', () => {
    const img = still(project, []);
    near(at(img, 100, 40), ORANGE);
    near(at(img, 40, 30), [0, 170, 0]);
    near(at(img, 315, 20), [255, 0, 255]); // @media (min-width: 100px)
    near(at(img, 355, 20), [0, 0, 0]); // @media (max-width: 10px) does not hold
    // transform: translate(100px, 0) moves the rect from x 0..40 to 100..140.
    near(at(img, 20, 170), WHITE);
    near(at(img, 120, 170), [170, 0, 170]);
    // filter: url(#f) blurs the blue square, so its edge spreads outside the rect.
    near(at(img, 140, 120), [0, 0, 255]);
    expect(at(img, 117, 120)).not.toEqual(WHITE);
    // clip-path: url(#c) keeps x 220..250 of the rect that spans 220..280.
    near(at(img, 235, 120), [0, 170, 170]);
    near(at(img, 265, 120), WHITE);
  });
});
