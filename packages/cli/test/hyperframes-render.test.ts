// `kinetograph render <dir>` on a HyperFrames project, on the real addon and the built CLI: the GSAP timelines drive
// the picture, a frame drawn on its own is the one a sequential render draws, and the workers agree. Needs the built
// addon and `npm run build`, a GPU and ffmpeg; skipped where one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const project = join(here, 'fixtures', 'hf-nyt');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const gsap = existsSync(join(here, '..', '..', '..', 'node_modules', 'gsap', 'dist', 'gsap.min.js'));
const ready = addon && haveFfmpeg && gsap && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-render-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function framemd5(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

describe.skipIf(!ready)('rendering a HyperFrames project', () => {
  it('lists the root composition at the size, rate and length the HTML declares', () => {
    const out = run(['compositions', project, '--json']);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ compositions: [{ id: 'main', width: 1920, height: 1080, fps: 30, durationInFrames: 450 }] });
  });

  it('draws the chart as the timeline says, the same for every worker and for a frame drawn from scratch', () => {
    const flags = ['--range', '148..=151', '--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p', '--draft'];
    expect(run(['render', project, '-o', join(dir, 'one.mp4'), '--concurrency', '1', ...flags]).status).toBe(0);
    expect(run(['render', project, '-o', join(dir, 'two.mp4'), '--concurrency', '2', ...flags]).status).toBe(0);
    const one = framemd5('one.mp4');
    expect(one).toHaveLength(4);
    expect(framemd5('two.mp4')).toEqual(one);
    // Frame 150 drawn alone (the scene starts at frame 0, then jumps) is frame 150 of the run above.
    expect(run(['render', project, '-o', join(dir, 'alone.mp4'), '--concurrency', '1', ...flags.map((f) => (f === '148..=151' ? '150..=150' : f))]).status).toBe(0);
    expect(framemd5('alone.mp4')[0]).toBe(one[2]);
    // The timeline moves the picture: the first frame is not the same as the 150th.
    expect(run(['render', project, '-o', join(dir, 'start.mp4'), '--concurrency', '1', ...flags.map((f) => (f === '148..=151' ? '0..=0' : f))]).status).toBe(0);
    expect(framemd5('start.mp4')[0]).not.toBe(one[2]);
  });
  it('draws a WebGPU canvas from the time hf-seek gives it, the same alone, in sequence and across workers, with nothing unsupported', () => {
    const webgpu = join(here, 'fixtures', 'hf-webgpu');
    const flags = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p', '--strict'];
    expect(run(['render', webgpu, '-o', join(dir, 'gpu-seq.mp4'), '--concurrency', '1', '--range', '0..=20', ...flags]).status).toBe(0);
    expect(run(['render', webgpu, '-o', join(dir, 'gpu-two.mp4'), '--concurrency', '2', '--range', '0..=20', ...flags]).status).toBe(0);
    expect(run(['render', webgpu, '-o', join(dir, 'gpu-alone.mp4'), '--concurrency', '1', '--range', '20..=20', ...flags]).status).toBe(0);
    const seq = framemd5('gpu-seq.mp4');
    expect(seq).toHaveLength(21);
    expect(framemd5('gpu-two.mp4')).toEqual(seq);
    expect(framemd5('gpu-alone.mp4')[0]).toBe(seq[20]);
    // The time moves the picture.
    expect(seq[0]).not.toBe(seq[20]);
  });
});
