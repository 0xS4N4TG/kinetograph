// @kinetographdev/p5-brush on the real addon and the built CLI: a frame is the same alone, in sequence and at any
// concurrency, and the brush moves. Needs the WebGL support of the addon (p5.brush draws with WebGL2), the built
// CLI and this package's dist, a GPU and ffmpeg; skipped where one is missing. `KINETOGRAPH_CLI` names another CLI build.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.env.KINETOGRAPH_CLI ?? join(here, '..', '..', '..', 'cli', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(cli) && existsSync(join(here, '..', 'dist', 'index.js'));

const PROJECT = `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { BrushCanvas } from '@kinetographdev/p5-brush';

const Strokes = () => (
  <AbsoluteFill>
    <BrushCanvas seed={7} origin="top-left" background="#f4efe6" draw={(b, frame) => {
      const t = Math.max(0.05, frame / 11);
      b.set('HB', '#2f2a26', 1.2);
      b.line(10, 20, 10 + 200 * t, 60);
      b.fill('#d7a86e', 160);
      b.circle(120, 90, 10 + 20 * t);
    }} />
  </AbsoluteFill>
);
registerRoot(() => <Composition id="Strokes" component={Strokes} width={256} height={144} fps={30} durationInFrames={12} />);
`;

// Inside this package's node_modules, which is ignored, so that `p5.brush` and `@kinetographdev/p5-brush` resolve from the workspace.
const dir = join(here, '..', 'node_modules', '.cache', 'render-test');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), PROJECT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lossless = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p'];

function render(output: string, extra: string[] = []) {
  const run = spawnSync('node', [cli, 'render', join(dir, 'index.tsx'), '-o', join(dir, output), ...lossless, ...extra], { encoding: 'utf8' });
  return { status: run.status, log: run.stderr + run.stdout };
}

function frames(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

describe.skipIf(!ready)('@kinetographdev/p5-brush', () => {
  it('draws a frame that is the same at concurrency 1 and 4 and when rendered alone', () => {
    const one = render('c1.mp4', ['--concurrency', '1']);
    expect(one.status, one.log).toBe(0);
    const four = render('c4.mp4', ['--concurrency', '4']);
    expect(four.status, four.log).toBe(0);
    const seq = frames('c1.mp4');
    expect(seq).toHaveLength(12);
    expect(frames('c4.mp4')).toEqual(seq);
    // The brush is drawn and moves.
    expect(new Set(seq).size).toBe(12);
    for (const f of [0, 5, 11]) {
      const alone = render(`f${f}.mp4`, ['--range', `${f}..=${f}`]);
      expect(alone.status, alone.log).toBe(0);
      expect(frames(`f${f}.mp4`)).toEqual([seq[f]]);
    }
  });
});
