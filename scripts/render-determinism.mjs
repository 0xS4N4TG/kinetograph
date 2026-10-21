#!/usr/bin/env node
// Rendering is a pure function of (project, frame): every frame must come out the same at any concurrency, in any
// order, and drawn alone. This renders a project several ways and compares what the videos decode to.
//
//   node scripts/render-determinism.mjs examples/launch/index.tsx --comp launch --frames 449..457,758..768
//   node scripts/render-determinism.mjs examples/showcase/index.tsx --comp Showcase --frames 0,100,200
//
// For the listed frames (default: none) it draws the span from the first to the last at --concurrency 1 and at
// --concurrency N (default 4, chunks of KINETOGRAPH_CHUNK frames, default 8 here, open to splitting) and each frame
// alone, in a process of its own, all as lossless H.264 (libx264 at crf 0, 4:4:4), so that a decoded frame is a
// function of the pixels drawn. Every frame of every way must decode to the same bytes. With --whole it also renders
// the whole project --runs times (default 2) at each of the two concurrencies with the default encoder and compares the
// decoded frame lists, which is what `ffmpeg -f framemd5` gives.
//
//   --comp <id>  --concurrency <n>  --runs <n>  --whole  --chunk <frames>
// Run `npm run build` first. Needs ffmpeg and a GPU.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const entry = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!entry) {
  console.error('usage: render-determinism.mjs <entry> [--comp id] [--frames 449..457,758] [--concurrency 4] [--whole] [--runs 2]');
  process.exit(2);
}
const comp = option('comp');
const workers = Number(option('concurrency', 4));
const runs = Number(option('runs', 2));
const chunk = String(option('chunk', 8));
const frames = (option('frames', '') || '')
  .split(',')
  .filter(Boolean)
  .flatMap((part) => {
    const m = /^(\d+)\.\.(\d+)$/.exec(part);
    return m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i) : [Number(part)];
  });
const dir = mkdtempSync(join(tmpdir(), 'kinetograph-determinism-'));
let failures = 0;

function render(name, extra, env = {}) {
  const output = join(dir, name);
  const run = spawnSync(
    'node',
    [cli, 'render', resolve(entry), ...(comp ? ['--comp', comp] : []), '-o', output, ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  if (run.status !== 0) {
    console.error(`render ${name} failed:\n${run.stderr}${run.stdout}`);
    process.exit(1);
  }
  return output;
}

/** One md5 per decoded video frame. */
function decoded(file) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function same(label, got, want, first = 0) {
  const bad = [];
  want.forEach((hash, i) => {
    if (got[i] !== hash) bad.push(first + i);
  });
  if (got.length !== want.length) bad.push(`(${got.length} frames, not ${want.length})`);
  console.log(`${bad.length === 0 ? 'ok  ' : 'FAIL'} ${label}${bad.length ? `: differs at frames ${bad.join(' ')}` : ''}`);
  if (bad.length) failures += 1;
}

if (frames.length > 0) {
  const first = Math.min(...frames);
  const last = Math.max(...frames);
  const lossless = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p'];
  const span = ['--range', `${first}..=${last}`, ...lossless];
  const sequential = decoded(render('seq.mp4', [...span, '--concurrency', '1']));
  const parallel = decoded(render('par.mp4', [...span, '--concurrency', String(workers)], { KINETOGRAPH_CHUNK: chunk, KINETOGRAPH_MINSPLIT: '2' }));
  same(`frames ${first}..=${last}: concurrency ${workers} (chunks of ${chunk}) against 1`, parallel, sequential, first);
  for (const frame of frames) {
    const alone = decoded(render('one.mp4', ['--range', `${frame}..=${frame}`, ...lossless]));
    same(`frame ${frame} alone against the span at concurrency 1`, alone, [sequential[frame - first]], frame);
  }
}

if (args.includes('--whole')) {
  const lists = [];
  for (const concurrency of [1, workers]) {
    for (let run = 1; run <= runs; run++) {
      lists.push({ label: `whole, concurrency ${concurrency}, run ${run}`, hashes: decoded(render(`whole-${concurrency}-${run}.mp4`, ['--concurrency', String(concurrency)])) });
    }
  }
  for (const { label, hashes } of lists.slice(1)) same(label, hashes, lists[0].hashes);
  console.log(`${lists[0].hashes.length} frames in each list`);
}

rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
