#!/usr/bin/env node
// The corpus harness (packages/cli/skills/kinetograph/references/ENGINE.md §10.5): how many frames of the tiny-agent episode 13 papercut project have nothing
// unsupported, what the engine cannot draw yet, and how far the native frames are from the real thing.
//
//   node scripts/corpus.mjs                         coverage of all 988 frames (no GPU, about a minute)
//   node scripts/corpus.mjs --range 0..150          part of the episode
//   node scripts/corpus.mjs --reference             also draw every 30th frame natively and compare it with the same
//                                                   frame of a real Remotion render: the project's out/*.mp4
//   node scripts/corpus.mjs --reference path.mp4    another render of the same project
//   --every 60         another step for the samples (default 30)
//   --entry <file> --comp <id>     another project
//
// Writes out/corpus/report.json (the doctor report plus the numbers below) and, for the samples, the native picture,
// the reference and their difference (x4) as PNGs in out/corpus/. Run `npm run build -w packages/cli` first.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = join(root, 'packages', 'cli', 'dist');
const cli = join(cliDir, 'cli.js');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = args[at + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};
const entry = option(
  'entry',
  process.env.KINETOGRAPH_CORPUS && join(process.env.KINETOGRAPH_CORPUS, 'tiny-agent/episodes/13-mods/papercut/src/index.ts'),
);
if (!entry) throw new Error('corpus.mjs: pass --entry <file>, or set KINETOGRAPH_CORPUS to the corpus repo');
const comp = option('comp', 'ModsPapercut');
const range = option('range');
const every = Number(option('every', '30'));
const out = resolve(option('out', join(root, 'out', 'corpus')));
const top = Number(option('top', '25'));

let reference = option('reference');
if (reference === true) {
  // The project's own render: the first .mp4 in out/ beside src/.
  const outDir = join(dirname(dirname(entry)), 'out');
  const found = existsSync(outDir) ? readdirSync(outDir).find((f) => f.endsWith('.mp4')) : undefined;
  if (!found) {
    console.error(`--reference: no .mp4 in ${outDir}; pass the path of a Remotion render of the project`);
    process.exit(2);
  }
  reference = join(outDir, found);
}

mkdirSync(out, { recursive: true });

function run(command, commandArgs, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout }));
  });
}

const started = Date.now();
const doctorArgs = ['doctor', entry, '--comp', comp, '--json'];
if (range) doctorArgs.push('--range', range);
const doctor = await run(process.execPath, [cli, ...doctorArgs]);
if (doctor.code !== 0) {
  console.error(doctor.stdout.trim() || `doctor exited with ${doctor.code}`);
  process.exit(doctor.code ?? 1);
}
const report = JSON.parse(doctor.stdout);

// ---- against a Remotion render ----

/** The frames sampled: the first of the range and every `every`th after it. */
function sampledFrames() {
  const frames = [];
  for (let f = report.first; f <= report.last; f += every) frames.push(f);
  return frames;
}

function pixelStats(a, b) {
  let max = 0;
  let sum = 0;
  let over2 = 0;
  let over48 = 0;
  let squares = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      squares += d * d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > max) max = pixelMax;
    if (pixelMax > 2) over2++;
    if (pixelMax > 48) over48++;
  }
  const n = (a.length / 4) * 3;
  const mse = squares / n;
  return {
    maxDiff: max,
    meanDiff: sum / n,
    differingPixels: over2,
    largeDiffPixels: over48,
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
  };
}

async function againstReference() {
  const { decodePng, encodePng } = await import(pathToFileURL(join(cliDir, 'png.js')).href);
  const frames = sampledFrames();
  const pad = (f) => String(f).padStart(5, '0');
  // The Remotion frames: one ffmpeg pass.
  const select = frames.map((f) => `eq(n\\,${f})`).join('+');
  const extract = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', reference, '-vf', `select='${select}'`, '-fps_mode', 'passthrough', join(out, 'ref-%05d.png')],
    { encoding: 'utf8' },
  );
  if (extract.status !== 0) {
    console.error(`ffmpeg could not read ${reference}: ${extract.stderr}`);
    process.exit(3);
  }
  const results = [];
  for (const [index, frame] of frames.entries()) {
    const native = join(out, `frame-${pad(frame)}-remotion-native.png`);
    const still = await run(process.execPath, [cli, 'still', entry, String(frame), '--comp', comp, '-o', native]);
    if (still.code !== 0) {
      console.error(`still of frame ${frame} failed`);
      continue;
    }
    const ref = decodePng(readFileSync(join(out, `ref-${String(index + 1).padStart(5, '0')}.png`)));
    const ours = decodePng(readFileSync(native));
    if (ref.width !== ours.width || ref.height !== ours.height) {
      console.error(`frame ${frame}: ${ours.width}x${ours.height} against ${ref.width}x${ref.height}`);
      continue;
    }
    writeFileSync(join(out, `frame-${pad(frame)}-remotion.png`), encodePng(ref.width, ref.height, ref.data));
    const diff = new Uint8Array(ours.data.length);
    for (let i = 0; i < diff.length; i += 4) {
      for (let c = 0; c < 3; c++) diff[i + c] = Math.min(255, Math.abs(ours.data[i + c] - ref.data[i + c]) * 4);
      diff[i + 3] = 255;
    }
    writeFileSync(join(out, `frame-${pad(frame)}-remotion-diff.png`), encodePng(ref.width, ref.height, diff));
    results.push({ frame, ...pixelStats(ours.data, ref.data) });
  }
  return results;
}

if (reference) report.reference = { file: reference, frames: await againstReference() };

// ---- print ----

const seconds = (Date.now() - started) / 1000;
const pct = (n, of) => `${((100 * n) / of).toFixed(1)}%`;
const lines = [];
lines.push(`${report.comp}: frames ${report.first}..${report.last} (${report.frames})`);
lines.push(`native: ${report.cleanFrames} of ${report.frames} (${pct(report.cleanFrames, report.frames)}); with unsupported content: ${report.unsupportedFrames}`);
if (report.notes?.length) lines.push('', 'stylesheet problems:', ...report.notes.map((n) => `  ${n}`));
if (report.issues.length > 0) {
  lines.push('', `${report.issues.length} kinds of unsupported item, most frames first (frames, element property: reason):`);
  for (const issue of report.issues.slice(0, top)) {
    const what = `${issue.element}${issue.property ? ` ${issue.property}` : ''}`;
    const values = issue.values.length ? `  [${issue.values.slice(0, 3).join(' | ')}]` : '';
    lines.push(`  ${String(issue.frames).padStart(4)}  ${what}: ${issue.reason}${values}`);
  }
  if (report.issues.length > top) lines.push(`  … and ${report.issues.length - top} more (report.json has all)`);
}
function table(title, rows) {
  const total = rows.reduce((sum, c) => sum + (c.largeDiffPixels ?? 0), 0);
  lines.push('', `${title} (${rows.length} frames):`);
  lines.push('  frame  max  mean    >2 levels  >48 levels   PSNR');
  for (const c of rows) {
    lines.push(
      `  ${String(c.frame).padStart(5)} ${String(c.maxDiff).padStart(4)}  ${c.meanDiff.toFixed(2).padStart(5)}  ` +
        `${String(c.differingPixels).padStart(9)}  ${String(c.largeDiffPixels ?? '').padStart(10)}  ${c.psnr === undefined ? '' : c.psnr.toFixed(1).padStart(5)}`,
    );
  }
  lines.push(`  pixels more than 48 levels apart, summed: ${total}`);
}
if (report.reference?.frames.length) table(`native against the Remotion render ${report.reference.file}, every ${every}th frame`, report.reference.frames);
lines.push('', `took ${seconds.toFixed(0)} s; report: ${join(out, 'report.json')}`);
console.log(lines.join('\n'));

writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, entry, seconds }, null, 2));
