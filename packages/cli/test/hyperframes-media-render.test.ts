// A HyperFrames project that uses what the loader added: a speed ramp on a video, a colour grade, `data-hidden`, a
// top-level `const` shared by two scripts, a page `<template>` and an `@media` rule that reaches into an `<svg>`. Drawn on
// the real addon through the built CLI; needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAutomation, sourceTimeAt } from '@kinetographdev/core/hyperframes';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const project = join(here, 'fixtures', 'hf-media');
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
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-media-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function framemd5(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

/** The RGB of one pixel of a PNG. */
function pixel(file: string, x: number, y: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
}

describe.skipIf(!ready)('a HyperFrames project with ramps, grades, hidden clips and shared scripts', () => {
  it('draws each feature at frame 60', () => {
    expect(run(['still', project, '60', '-o', join(dir, 'f60.png')]).status).toBe(0);
    // `data-hidden` takes the red square out; the green one is 70 px wide because the second script read the first's const.
    expect(pixel('f60.png', 380, 50)).toEqual([0, 0, 0]);
    expect(pixel('f60.png', 475, 50)).toEqual([0, 255, 0]);
    expect(pixel('f60.png', 520, 50)).toEqual([0, 0, 0]);
    // The template's content, cloned by a script.
    expect(pixel('f60.png', 50, 170)).toEqual([0, 0, 255]);
    // The `@media (min-width: 600px)` rule reaches the shape in the `<svg>`; the `max-width: 100px` one does not.
    expect(pixel('f60.png', 160, 170)).toEqual([255, 255, 0]);
    // Exposure -1 halves the colour (in sRGB, as HyperFrames' grade does).
    const plain = pixel('f60.png', 270, 50);
    const graded = pixel('f60.png', 160, 50);
    graded.forEach((v, i) => expect(Math.abs(v - plain[i]! * 0.5)).toBeLessThanOrEqual(2));
    // The ramped video shows the file at the integral of the rate: its grey level is the frame number (luma 16 + 1.5 N).
    const lane = parseAutomation(JSON.stringify({ version: 1, lanes: [{ target: 'rate', points: [{ t: 0, v: 1 }, { t: 3, v: 2.5 }] }] }))!.rate!;
    const sourceFrame = sourceTimeAt(lane, 2) * 30;
    const grey = pixel('f60.png', 50, 50)[0]!;
    const luma = (grey * 219) / 255 + 16;
    expect(Math.abs((luma - 16) / 1.5 - sourceFrame)).toBeLessThan(1.5);
  });

  it('draws a frame alone as in a sequence, and the same for 1 and 4 workers', () => {
    const flags = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p', '--draft'];
    expect(run(['render', project, '-o', join(dir, 'one.mp4'), '--range', '58..=62', '--concurrency', '1', ...flags]).status).toBe(0);
    expect(run(['render', project, '-o', join(dir, 'four.mp4'), '--range', '58..=62', '--concurrency', '4', ...flags]).status).toBe(0);
    const one = framemd5('one.mp4');
    expect(one).toHaveLength(5);
    expect(framemd5('four.mp4')).toEqual(one);
    expect(run(['render', project, '-o', join(dir, 'alone.mp4'), '--range', '60..=60', '--concurrency', '1', ...flags]).status).toBe(0);
    expect(framemd5('alone.mp4')[0]).toBe(one[2]);
    // The ramp moves the picture from frame to frame.
    expect(new Set(one).size).toBe(5);
  });
});
