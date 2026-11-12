// A `<video>` made by a page, given to WebGL (`texImage2D`) and Canvas 2D (`drawImage`) every frame, shows the picture
// for the frame's virtual time (frame / fps, looped), whether the frame comes from a still, a sequence or several
// workers. `clip.mp4` is 12 fps, 24 pictures of 2 s, each its own colour. Drawn on the real addon through the built CLI;
// needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const project = join(here, 'fixtures', 'hf-webgl-video');
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
  dir = mkdtempSync(join(tmpdir(), 'kg-webgl-video-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

/** The RGB of one pixel of a picture file. */
function pixel(file: string, x: number, y: number, vf = ''): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${vf}crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
}
/** The centre pixel of picture `n` of the clip, as ffmpeg decodes it. */
function clipFrame(n: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(project, 'clip.mp4'), '-vf', 'format=rgb24,crop=1:1:32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(n * 3, n * 3 + 3)];
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);
const md5 = (file: string) => createHash('md5').update(readFileSync(file)).digest('hex');

describe.skipIf(!ready)('a page that uploads a <video> to WebGL and to a 2D canvas every frame', () => {
  // Frame N is at N / 30 s; the clip is 2 s long and loops, and holds a picture each 1 / 12 s.
  const cases: [number, number][] = [[11, 4], [26, 10], [66, 2]];
  for (const [frame, picture] of cases) {
    it(`frame ${frame} shows the clip's picture ${picture} in both`, () => {
      const out = join(dir, `f${frame}.png`);
      expect(run(['still', project, String(frame), '-o', out]).status).toBe(0);
      const expected = clipFrame(picture);
      expect(near(pixel(out, 32, 36), expected), `webgl ${pixel(out, 32, 36)} vs ${expected}`).toBe(true);
      expect(near(pixel(out, 96, 36), expected), `2d ${pixel(out, 96, 36)} vs ${expected}`).toBe(true);
    });
  }

  it('a still is the same picture as the frame of a sequence at one worker and at four', () => {
    for (const frame of [11, 26]) {
      const still = join(dir, `s${frame}.png`);
      expect(run(['still', project, String(frame), '-o', still]).status).toBe(0);
      for (const concurrency of [1, 4]) {
        const out = join(dir, `seq-${frame}-${concurrency}`);
        expect(run(['render', project, '--range', `0..=${frame}`, '--sequence', '--concurrency', String(concurrency), '-o', out]).status).toBe(0);
        const last = readdirSync(out).filter((f) => f.endsWith('.png')).sort().at(-1)!;
        expect(md5(join(out, last))).toBe(md5(still));
      }
    }
  });
});
