// Scripted input (`--input`): a page that starts on a click draws nothing until one comes, so a project lists the events
// and they are dispatched on the virtual clock, before the frame's animation-frame callbacks. Drawn on the real addon
// through the built CLI; needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
let file: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-input-'));
  file = join(dir, 'index.html');
  // A "Play" overlay in a wrapper: the click bubbles to the wrapper's listener, which removes the overlay and starts a
  // loop that moves the red box one pixel-step per animation frame (so the loop is also seen to start on the clock).
  writeFileSync(
    file,
    `<!doctype html><html><head><meta name="viewport" content="width=200, height=100"><style>
body { margin: 0; background: #000000; }
#overlay { position: absolute; left: 0; top: 0; width: 200px; height: 100px; background: #0000ff; }
#box { position: absolute; left: 0; top: 40px; width: 20px; height: 20px; background: #ff0000; }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="200" data-height="100" data-fps="10">
<div id="wrap"><div id="overlay"><span id="play">Play</span></div></div><div id="box"></div></div>
<script>
let x = 0;
function loop() { x += 10; document.getElementById('box').style.left = x + 'px'; requestAnimationFrame(loop); }
document.getElementById('wrap').addEventListener('click', () => {
  document.getElementById('overlay').remove();
  requestAnimationFrame(loop);
});
</script></body></html>`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): { stderr: string; status: number | null } {
  const out = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { stderr: out.stderr, status: out.status };
}

function still(name: string, frame: number, extra: string[] = []): { png: string; stderr: string } {
  const png = join(dir, `${name}.png`);
  const result = run(['still', file, String(frame), '-o', png, ...extra]);
  expect(result.status, result.stderr).toBe(0);
  return { png, stderr: result.stderr };
}

function pixel(png: string, x: number, y: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
}

const BLUE = [0, 0, 255];
const BLACK = [0, 0, 0];
const RED = [255, 0, 0];
// Clicking the inner span at frame 3: the wrapper's listener hears it by bubbling.
const click = (frame: number): string => JSON.stringify([{ frame, type: 'click', selector: '#play' }]);

describe.skipIf(!ready)('--input', () => {
  it('leaves a page that waits for a click on its overlay, and says why', () => {
    const { png, stderr } = still('waiting', 8);
    expect(pixel(png, 150, 10)).toEqual(BLUE);
    expect(stderr).toContain('waits for a user gesture');
    expect(stderr).toContain('--input');
  });

  it('dispatches the click on the clock: the overlay is there before its frame and gone from it, and the loop starts then', () => {
    expect(pixel(still('c2', 2, ['--input', click(3)]).png, 150, 10)).toEqual(BLUE);
    const after = still('c6', 6, ['--input', click(3)]);
    expect(pixel(after.png, 150, 10)).toEqual(BLACK);
    expect(after.stderr).not.toContain('waits for a user gesture');
  });

  it('a still equals the frame of a render of every frame (history is replayed from frame 0)', () => {
    const out = join(dir, 'seq');
    const sequence = run(['render', file, '--sequence', '-o', out, '--input', click(3), '--range', '0..=9', '--concurrency', '1']);
    expect(sequence.status, sequence.stderr).toBe(0);
    const one = still('c7', 7, ['--input', click(3)]);
    const frames = readdirSync(out).filter((n) => /-0*7\.png$/.test(n));
    expect(frames).toHaveLength(1);
    const hash = (p: string): string => spawnSync('md5', ['-q', p], { encoding: 'utf8' }).stdout.trim();
    expect(hash(join(out, frames[0]!))).toBe(hash(one.png));
  });

  it('rejects an event that is not understood', () => {
    const bad = run(['still', file, '0', '-o', join(dir, 'bad.png'), '--input', '[{"frame":0,"type":"tap"}]']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('--input[0].type');
  });

  it('says when a selector matches nothing', () => {
    const missing = still('missing', 2, ['--input', JSON.stringify([{ frame: 0, type: 'click', selector: '#nope' }])]);
    expect(missing.stderr).toContain('no element matches "#nope"');
  });
});
