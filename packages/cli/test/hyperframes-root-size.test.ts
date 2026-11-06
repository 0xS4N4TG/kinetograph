// A HyperFrames page whose `#root` is `height: 100%` over an `html` and `body` with no height (issue #112). A browser
// gives the page's `html` and `body` the viewport's size only when asked; here the composition's size is what a page
// without its own rule gets, so the percentage resolves to the composition, and a page's own rule still wins. Drawn on
// the real addon through the built CLI; needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
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
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-root-size-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The issue's page; `style` is the page's rules. The red box is 400x400 at (100, 100) of a 640x640 composition. */
function page(name: string, style: string, extra = ''): string {
  mkdirSync(join(dir, name));
  const file = join(dir, name, 'index.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><style>
body { margin: 0; background: #0b0b0f; }
#box { position: absolute; left: 100px; top: 100px; width: 400px; height: 400px; background: #ff0000; }
${style}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="640" data-height="640" data-fps="30"><div id="box"></div></div>${extra}
</body></html>`,
  );
  return file;
}

function still(file: string, name: string): string {
  const out = join(dir, `${name}.png`);
  const run = spawnSync(process.execPath, [cli, 'still', file, '5', '-o', out], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return out;
}

function pixel(file: string, x: number, y: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
}

const RED = [255, 0, 0];
const BACKGROUND = [11, 11, 15];

describe.skipIf(!ready)('the size of a HyperFrames page without a height on html and body', () => {
  it('gives #root { height: 100% } the composition height', () => {
    const png = still(page('percent', '#root { position: relative; width: 100%; height: 100%; overflow: hidden; }'), 'percent');
    expect(pixel(png, 300, 300)).toEqual(RED);
    expect(pixel(png, 50, 50)).toEqual(BACKGROUND);
  });

  it("leaves a page's own html and body size in charge", () => {
    // 320x320 clips the box (overflow: hidden on the 100%-high root) at 320, whatever the composition says.
    const png = still(
      page('own', 'html, body { width: 320px; height: 320px; margin: 0 } #root { position: relative; width: 100%; height: 100%; overflow: hidden; }'),
      'own',
    );
    expect(pixel(png, 300, 300)).toEqual(RED);
    expect(pixel(png, 400, 400)).toEqual(BACKGROUND);
  });

  it('lays out a page that uses no percentages as before', () => {
    // A fixed-size root, and a box at the bottom of the initial containing block: neither moves.
    const png = still(
      page(
        'fixed',
        '#root { position: relative; width: 640px; height: 640px; overflow: hidden; } #foot { position: absolute; left: 0; bottom: 0; width: 50px; height: 50px; background: #0000ff; }',
        '<div id="foot"></div>',
      ),
      'fixed',
    );
    expect(pixel(png, 300, 300)).toEqual(RED);
    expect(pixel(png, 50, 50)).toEqual(BACKGROUND);
    expect(pixel(png, 25, 615)).toEqual([0, 0, 255]);
    expect(pixel(png, 25, 565)).toEqual(BACKGROUND);
  });

  it('warns in doctor, and fails render --strict, for a root that still lays out to no height, and not for one that does not', () => {
    const collapsed = page('collapsed', 'html, body { height: auto } #root { position: relative; width: 100%; height: 100%; overflow: hidden; }');
    const bad = spawnSync(process.execPath, [cli, 'doctor', collapsed, '--range', '0..=2'], { encoding: 'utf8' });
    expect(bad.stdout).toContain('the root composition #root is laid out 640x0');
    const strict = spawnSync(process.execPath, [cli, 'render', collapsed, '-o', join(dir, 'collapsed.mp4'), '--range', '0..=2', '--strict'], { encoding: 'utf8' });
    expect(strict.status).not.toBe(0);

    const fine = page('sized', '#root { position: relative; width: 100%; height: 100%; overflow: hidden; }');
    const good = spawnSync(process.execPath, [cli, 'doctor', fine, '--range', '0..=2'], { encoding: 'utf8' });
    expect(good.stdout).not.toContain('the root composition');
    expect(good.stdout).toContain('clean');
  });
});
