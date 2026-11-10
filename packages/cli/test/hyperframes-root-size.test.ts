// A HyperFrames page whose `#root` is `height: 100%` over an `html` and `body` with no height (issue #112). A browser
// gives the page's `html` and `body` the viewport's size only when asked; here the composition's size is what a page
// without its own rule gets, so the percentage resolves to the composition, and a page's own rule still wins. A root
// with `data-width` and `data-height` is not that case: HyperFrames' runtime clips it and sets its size from them, as
// the layout step of its init does, whatever the stylesheet says. Drawn on the real addon through the built CLI; needs
// the built addon and `npm run build`, a GPU and ffmpeg.

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

/**
 * The issue's page; `style` is the page's rules and `size` the root's size attributes (none: the composition is the
 * viewport meta's 640x640). The red box is 400x400 at (100, 100) of a 640x640 composition.
 */
function page(name: string, style: string, extra = '', size = 'data-width="640" data-height="640" '): string {
  mkdirSync(join(dir, name));
  const file = join(dir, name, 'index.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta name="viewport" content="width=640, height=640"><style>
body { margin: 0; background: #0b0b0f; }
#box { position: absolute; left: 100px; top: 100px; width: 400px; height: 400px; background: #ff0000; }
${style}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="1" ${size}data-fps="30"><div id="box"></div></div>${extra}
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
    const png = still(page('percent', '#root { position: relative; width: 100%; height: 100%; overflow: hidden; }', '', ''), 'percent');
    expect(pixel(png, 300, 300)).toEqual(RED);
    expect(pixel(png, 50, 50)).toEqual(BACKGROUND);
  });

  it("leaves a page's own html and body size in charge", () => {
    // 320x320 clips the box (overflow: hidden on the 100%-high root) at 320, whatever the composition says.
    const png = still(
      page('own', 'html, body { width: 320px; height: 320px; margin: 0 } #root { position: relative; width: 100%; height: 100%; overflow: hidden; }', '', ''),
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

  it('warns in doctor, and fails render --strict, for a clipping root that lays out to no height, and not for one that does not', () => {
    const collapsed = page('collapsed', 'html, body { height: auto } #root { position: relative; width: 100%; height: 100%; overflow: hidden; }', '', '');
    const bad = spawnSync(process.execPath, [cli, 'doctor', collapsed, '--range', '0..=2'], { encoding: 'utf8' });
    expect(bad.stdout).toContain('the root composition #root clips its contents and is laid out 640x0');
    const strict = spawnSync(process.execPath, [cli, 'render', collapsed, '-o', join(dir, 'collapsed.mp4'), '--range', '0..=2', '--strict'], { encoding: 'utf8' });
    expect(strict.status).not.toBe(0);

    const fine = page('sized', '#root { position: relative; width: 100%; height: 100%; overflow: hidden; }', '', '');
    const good = spawnSync(process.execPath, [cli, 'doctor', fine, '--range', '0..=2'], { encoding: 'utf8' });
    expect(good.stdout).not.toContain('the root composition');
    expect(good.stdout).toContain('clean');
  });

  it('does not warn for a root sized by its data-width and data-height, whatever the stylesheet gives it', () => {
    // The repo's own fixture: a #root with no CSS size and only absolute children. Its attributes size it, as in HyperFrames.
    const fixture = spawnSync(process.execPath, [cli, 'doctor', join(here, 'fixtures', 'hf-document'), '--range', '0..=2'], { encoding: 'utf8' });
    expect(fixture.stdout).not.toContain('the root composition');
    // HyperFrames clips every root, so one with no size attributes that lays out to no height warns, `overflow: visible` or not.
    const visible = page('visible', 'html, body { height: auto } #root { position: relative; width: 100%; height: 0; overflow: visible; }', '', '');
    const run = spawnSync(process.execPath, [cli, 'doctor', visible, '--range', '0..=2'], { encoding: 'utf8' });
    expect(run.stdout).toContain('the root composition #root clips its contents and is laid out 640x0');
    // With only one of the two attributes the other side still lays out as the stylesheet says: here to no height.
    const half = page('half', 'html, body { height: auto } #root { position: relative; height: 0; }', '', 'data-width="640" ');
    expect(spawnSync(process.execPath, [cli, 'doctor', half, '--range', '0..=2'], { encoding: 'utf8' }).stdout).toContain('laid out 640x0');
  });

  it('draws a root that has no CSS size from its data-width and data-height', () => {
    // `overflow: hidden` with no height lays out to nothing: the page drew an empty frame before the root took its size.
    const png = still(page('attributes', '#root { position: relative; overflow: hidden; }'), 'attributes');
    expect(pixel(png, 300, 300)).toEqual(RED);
    expect(pixel(png, 50, 50)).toEqual(BACKGROUND);
    const run = spawnSync(process.execPath, [cli, 'doctor', join(dir, 'attributes', 'index.html'), '--range', '0..=2'], { encoding: 'utf8' });
    expect(run.stdout).not.toContain('the root composition');
  });

  it('clips what lies outside the root, which has the size its attributes give', () => {
    // The root is the composition's size, 100 px right of and below the page's corner; the box starts 50 px before its corner.
    const png = still(
      page('clipped', '#root { margin: 100px 0 0 100px } #box { left: -50px; top: -50px; width: 200px; height: 200px }'),
      'clipped',
    );
    expect(pixel(png, 150, 150)).toEqual(RED);
    expect(pixel(png, 75, 75)).toEqual(BACKGROUND);
  });

  it('decides the warning on every frame: only on the frames where a clipping root is empty', () => {
    // A timeline that collapses the root for the first 0.2 s (frames 0 to 5 at 30 fps) and restores it after.
    const resized = page(
      'resized',
      'html, body { height: auto } #root { position: relative; width: 100%; overflow: hidden; }',
      `<script>window.__timelines = { main: { duration: () => 1, seek(t) { document.getElementById('root').style.height = t < 0.2 ? '0px' : '640px'; } } };</script>`,
      '',
    );
    const run = spawnSync(process.execPath, [cli, 'doctor', resized, '--range', '0..=11', '--json'], { encoding: 'utf8' });
    const report = JSON.parse(run.stdout);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].reason).toContain('laid out 640x0');
    expect(report.issues[0].ranges).toEqual([[0, 5]]);
    // Starting later, the frames that warn are the same: they do not depend on which frame was drawn first.
    const late = spawnSync(process.execPath, [cli, 'doctor', resized, '--range', '4..=11', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(late.stdout).issues[0].ranges).toEqual([[4, 5]]);
  });
});
