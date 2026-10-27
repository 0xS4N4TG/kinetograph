// Blender parity for `kinetograph track`: tracks the same clip, points and settings with Blender's "Track Markers"
// (blender_track.py, headless) and with Kinetograph, and prints how far apart the markers are.
//
//   node scripts/track-parity/compare.mjs [cases.json] [--blender PATH] [--cli] [--out DIR]
//
// cases.json (default: cases.json beside this file) is a list of {name, video, points: [[x, y], ...], model?,
// pattern?, search?, match?, minCorrelation?, from?, to?, backwards?}; a relative video is relative to the repository.
// Blender is $BLENDER, else `blender` on the PATH, else /Applications/Blender.app. Kinetograph is the `track` example
// (cargo build --release -p kinetograph-track --example track; $CARGO_TARGET_DIR is honoured), or with --cli the
// built CLI (packages/cli/dist/cli.js). Exit code 1 when a case is over its tolerance (default 0.001 px), or tracks a
// different set of frames or loses a track at another frame.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const useCli = args.includes('--cli') && (args.splice(args.indexOf('--cli'), 1), true);
const blender =
  flag('--blender') ?? process.env.BLENDER ?? (existsSync('/Applications/Blender.app') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender');
const outDir = resolve(flag('--out') ?? join(repo, 'target/track-parity'));
const casesPath = resolve(args[0] ?? join(here, 'cases.json'));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const targetDir = process.env.CARGO_TARGET_DIR ?? join(repo, 'target');
const example = join(targetDir, 'release/examples/track');

function ours(c) {
  const video = resolve(repo, c.video);
  const options = [
    ...(c.model ? ['--model', c.model] : []),
    ...(c.pattern ? ['--pattern', String(c.pattern)] : []),
    ...(c.search ? ['--search', String(c.search)] : []),
    ...(c.match ? ['--match', c.match] : []),
    ...(c.minCorrelation !== undefined ? ['--min-correlation', String(c.minCorrelation)] : []),
    ...(c.from !== undefined ? ['--from', String(c.from)] : []),
    ...(c.to !== undefined ? ['--to', String(c.to)] : []),
    ...(c.backwards ? ['--backwards'] : []),
  ];
  if (useCli) {
    const out = join(outDir, `${c.name}.kinetograph.json`);
    const points = c.points.flatMap(([x, y]) => ['--point', `${x},${y}`]);
    execFileSync(process.execPath, [join(repo, 'packages/cli/dist/cli.js'), 'track', video, ...points, ...options, '-o', out], { stdio: 'inherit' });
    return JSON.parse(readFileSync(out, 'utf8'));
  }
  const text = execFileSync(example, [video, ...c.points.map(([x, y]) => `${x},${y}`), ...options], { maxBuffer: 1 << 28 }).toString();
  writeFileSync(join(outDir, `${c.name}.kinetograph.json`), text);
  return JSON.parse(text);
}

function theirs(c) {
  const out = join(outDir, `${c.name}.blender.json`);
  const settings = { ...c, video: resolve(repo, c.video) };
  execFileSync(blender, ['-b', '--factory-startup', '--python', join(here, 'blender_track.py'), '--', JSON.stringify(settings), out], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(readFileSync(out, 'utf8'));
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// Blender keeps a marker as an f32 fraction of the frame (v up): ours goes through the same rounding before comparing.
const asBlender = ([x, y], w, h) => [Math.fround(x / w) * w, (1 - Math.fround(Math.fround(h - y) / h)) * h];
let failed = false;
const rows = [];
for (const c of cases) {
  const b = theirs(c);
  const k = ours(c);
  const tolerance = c.tolerance ?? 0.001;
  k.tracks.forEach((kt, i) => {
    const bt = b.tracks[i];
    const byFrame = new Map(bt.frames.map((m) => [m.frame, m]));
    const centre = [];
    const corner = [];
    let only = 0;
    for (const m of kt.frames) {
      const other = byFrame.get(m.frame);
      if (!other) {
        only++;
        continue;
      }
      byFrame.delete(m.frame);
      const [w, h] = [k.clip.width, k.clip.height];
      centre.push(dist(asBlender(m.center, w, h), other.center));
      corner.push(Math.max(...m.corners.map((p, j) => dist(asBlender(p, w, h), other.corners[j]))));
    }
    const max = (xs) => (xs.length ? Math.max(...xs) : 0);
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const row = {
      case: c.name,
      track: kt.name,
      model: kt.model,
      match: c.match ?? 'keyframe',
      frames: `${kt.frames.length} / ${bt.frames.length}`,
      onlyOurs: only,
      onlyBlender: byFrame.size,
      lost: `${JSON.stringify(kt.lost)} / ${JSON.stringify(bt.lost)}`,
      centreMax: max(centre),
      centreMean: mean(centre),
      cornerMax: max(corner),
    };
    row.ok =
      only === 0 &&
      byFrame.size === 0 &&
      JSON.stringify(kt.lost) === JSON.stringify(bt.lost) &&
      row.centreMax <= tolerance &&
      row.cornerMax <= tolerance;
    failed ||= !row.ok;
    rows.push(row);
  });
}

const fmt = (x) => (typeof x === 'number' ? x.toExponential(2) : x);
const head = ['case', 'track', 'model', 'match', 'frames (ours / Blender)', 'lost (ours / Blender)', 'centre max px', 'centre mean px', 'corner max px', 'ok'];
console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
for (const r of rows) {
  console.log(`| ${[r.case, r.track, r.model, r.match, r.frames, r.lost, fmt(r.centreMax), fmt(r.centreMean), fmt(r.cornerMax), r.ok ? 'yes' : 'NO'].join(' | ')} |`);
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
process.exit(failed ? 1 : 0);
