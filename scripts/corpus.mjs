#!/usr/bin/env node
// The corpus harness (docs/ENGINE.md §10): how much of the tiny-agent episode 13 papercut project the engine draws
// natively, what it cannot draw yet, and how far the native frames are from Chrome's.
//
//   node scripts/corpus.mjs                       coverage of all 988 frames (no GPU, a minute or two)
//   node scripts/corpus.mjs --range 0..150        part of the episode
//   node scripts/corpus.mjs --compare             also draw every 30th frame natively and in Chrome (needs the GPU and
//                                                 KINETOGRAPH_CHROME, or Chrome for Testing in ~/.cache/kinetograph/chrome)
//   node scripts/corpus.mjs --compare --every 60  another step
//   node scripts/corpus.mjs --entry <file> --comp <id>   another project
//
// Writes out/corpus/report.json (the doctor report plus the numbers below) and, with --compare, the native, Chrome
// and difference pictures of each sampled frame in out/corpus/. Run `npm run build -w packages/cli` first.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const entry = option(
  'entry',
  join(homedir(), '$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/src/index.ts'),
);
const comp = option('comp', 'ModsPapercut');
const range = option('range');
const compare = args.includes('--compare');
const every = option('every', '30');
const out = resolve(option('out', join(root, 'out', 'corpus')));
const top = Number(option('top', '25'));

mkdirSync(out, { recursive: true });
const doctorArgs = ['doctor', entry, '--comp', comp, '--json'];
if (range) doctorArgs.push('--range', range);
if (compare) doctorArgs.push('--compare-every', every, '--compare-dir', out);

const started = Date.now();
const child = spawn(process.execPath, [cli, ...doctorArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
const code = await new Promise((done) => child.on('close', done));
if (code !== 0) {
  console.error(stdout.trim() || `doctor exited with ${code}`);
  process.exit(code ?? 1);
}
const report = JSON.parse(stdout);
const seconds = (Date.now() - started) / 1000;

const pct = (n, of) => `${((100 * n) / of).toFixed(1)}%`;
const lines = [];
lines.push(`${report.comp}: frames ${report.first}..${report.last} (${report.frames})`);
lines.push(`native: ${report.nativeFrames} of ${report.frames} (${pct(report.nativeFrames, report.frames)}); not native: ${report.chromeFrames}`);
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
if (report.compare?.length) {
  const total = report.compare.reduce((sum, c) => sum + c.largeDiffPixels, 0);
  lines.push('', `native against Chrome, every ${every}th frame (${report.compare.length} frames):`);
  lines.push('  frame  path    max  mean    >2 levels  >48 levels');
  for (const c of report.compare) {
    lines.push(
      `  ${String(c.frame).padStart(5)}  ${c.path.padEnd(6)} ${String(c.maxDiff).padStart(4)}  ${c.meanDiff.toFixed(2).padStart(5)}  ` +
        `${String(c.differingPixels).padStart(9)}  ${String(c.largeDiffPixels ?? '').padStart(10)}`,
    );
  }
  lines.push(`  pixels more than 48 levels apart, summed: ${total}`);
}
lines.push('', `took ${seconds.toFixed(0)} s; report: ${join(out, 'report.json')}`);
console.log(lines.join('\n'));

writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, entry, seconds }, null, 2));
