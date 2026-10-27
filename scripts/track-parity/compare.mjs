// Blender parity for `kinetograph track`: tracks the same clip, points and settings with Blender's "Track Markers"
// (blender_track.py, headless) and with Kinetograph, and prints how far apart the markers are. Cases can also place
// their points with "Detect Features" and make plane tracks ("Create Plane Track") from the tracked points.
//
//   node scripts/track-parity/compare.mjs [cases.json] [--blender PATH] [--cli] [--out DIR] [--only NAME]
//
// cases.json (default: cases.json beside this file) is a list of {name, video, points: [[x, y], ...], model?,
// pattern?, search?, match?, minCorrelation?, margin?, from?, to?, backwards?, detect?: {margin?, threshold?,
// minDistance?, inside?|outside?: [[x, y, x, y, ...], ...]}, detectOnly?, planes?: [{name?, tracks?}], tolerance?};
// a relative video is relative to the repository. Blender is $BLENDER, else `blender` on the PATH, else
// /Applications/Blender.app. Kinetograph is the `track` example (cargo build --release -p kinetograph-track --example
// track; $CARGO_TARGET_DIR is honoured), or with --cli the built CLI (packages/cli/dist/cli.js). Exit code 1 when a
// case is over its tolerance (default 0.001 px), tracks a different set of frames, loses a track at another frame,
// detects a different list of features, or carries a plane to other frames.

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
const only = flag('--only');
const casesPath = resolve(args[0] ?? join(here, 'cases.json'));
const cases = JSON.parse(readFileSync(casesPath, 'utf8')).filter((c) => !only || c.name === only);
mkdirSync(outDir, { recursive: true });

const targetDir = process.env.CARGO_TARGET_DIR ?? join(repo, 'target');
const example = join(targetDir, 'release/examples/track');

function ours(c) {
  const video = resolve(repo, c.video);
  const d = c.detect;
  const to = c.detectOnly ? (c.backwards ? c.to : (c.from ?? 0)) : c.to;
  const options = [
    ...(c.model ? ['--model', c.model] : []),
    ...(c.pattern ? ['--pattern', String(c.pattern)] : []),
    ...(c.search ? ['--search', String(c.search)] : []),
    ...(c.match ? ['--match', c.match] : []),
    ...(c.minCorrelation !== undefined ? ['--min-correlation', String(c.minCorrelation)] : []),
    ...(c.margin !== undefined ? ['--margin', String(c.margin)] : []),
    ...(c.from !== undefined ? ['--from', String(c.from)] : []),
    ...(to !== undefined ? ['--to', String(to)] : []),
    ...(c.backwards ? ['--backwards'] : []),
    ...(d ? ['--detect'] : []),
    ...(d?.margin !== undefined ? ['--detect-margin', String(d.margin)] : []),
    ...(d?.threshold !== undefined ? ['--detect-threshold', String(d.threshold)] : []),
    ...(d?.minDistance !== undefined ? ['--detect-distance', String(d.minDistance)] : []),
    ...(d?.inside ?? []).flatMap((p) => ['--detect-inside', p.join(',')]),
    ...(d?.outside ?? []).flatMap((p) => ['--detect-outside', p.join(',')]),
    ...(c.planes ?? []).flatMap((p, i) => ['--plane', `${p.name ?? `plane${i + 1}`}=${p.tracks ? p.tracks.join(',') : 'all'}`]),
  ];
  const points = c.points ?? [];
  if (useCli) {
    const out = join(outDir, `${c.name}.kinetograph.json`);
    execFileSync(process.execPath, [join(repo, 'packages/cli/dist/cli.js'), 'track', video, ...points.flatMap(([x, y]) => ['--point', `${x},${y}`]), ...options, '-o', out], {
      stdio: 'inherit',
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  }
  const text = execFileSync(example, [video, ...points.map(([x, y]) => `${x},${y}`), ...options], { maxBuffer: 1 << 28 }).toString();
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
const max = (xs) => (xs.length ? Math.max(...xs) : 0);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
let failed = false;
const rows = [];
const detectRows = [];
const planeRows = [];
for (const c of cases) {
  const b = theirs(c);
  const k = ours(c);
  const tolerance = c.tolerance ?? 0.001;
  const [w, h] = [k.clip.width, k.clip.height];

  if (c.detect) {
    // Our detected points, as the normalised f32 positions Blender gives their markers.
    const given = (c.points ?? []).length;
    const mine = k.tracks.slice(given).map((t) => {
      const [x, y] = t.frames.find((m) => m.frame === (c.backwards ? c.to : (c.from ?? 0))).center;
      return [Math.fround(x / w), Math.fround((h - y) / h)];
    });
    const same = (a, p) => a[0] === p[0] && a[1] === p[1];
    const inOrder = mine.filter((p, i) => b.detected[i] && same(b.detected[i], p)).length;
    const key = (p) => `${p[0]},${p[1]}`;
    const theirsSet = new Set(b.detected.map(key));
    const inBoth = mine.filter((p) => theirsSet.has(key(p))).length;
    const row = {
      case: c.name,
      threshold: c.detect.threshold ?? 0.5,
      minDistance: c.detect.minDistance ?? 120,
      margin: c.detect.margin ?? 16,
      placement: c.detect.inside ? 'inside' : c.detect.outside ? 'outside' : 'frame',
      features: `${mine.length} / ${b.detected.length}`,
      inBoth,
      inOrder,
    };
    row.ok = mine.length === b.detected.length && inOrder === mine.length;
    failed ||= !row.ok;
    detectRows.push(row);
  }

  if (!c.detectOnly) {
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
        centre.push(dist(asBlender(m.center, w, h), other.center));
        corner.push(Math.max(...m.corners.map((p, j) => dist(asBlender(p, w, h), other.corners[j]))));
      }
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

  (b.planes ?? []).forEach((bp, i) => {
    const kp = (k.planes ?? [])[i] ?? { name: bp.name, frames: [], tracks: [] };
    // Blender carries a plane to a frame before or after the clip when a track's disabled marker is there; a track
    // file only has the clip's frames.
    const inClip = bp.frames.filter((m) => m.frame >= 0 && m.frame < k.clip.frames);
    const byFrame = new Map(inClip.map((m) => [m.frame, m]));
    const corner = [];
    let onlyOurs = 0;
    for (const m of kp.frames) {
      const other = byFrame.get(m.frame);
      if (!other) {
        onlyOurs++;
        continue;
      }
      byFrame.delete(m.frame);
      // Plane corners are written in f64, exactly Blender's f32 normalised corners times the frame size.
      corner.push(Math.max(...m.corners.map((p, j) => dist(p, other.corners[j]))));
    }
    const span = (fs) => (fs.length ? `${fs[0].frame}..${fs.at(-1).frame}` : '-');
    const row = {
      case: c.name,
      plane: bp.name,
      tracks: kp.tracks.length,
      frames: `${span(kp.frames)} / ${span(inClip)}`,
      onlyOurs,
      onlyBlender: byFrame.size,
      cornerMax: max(corner),
      cornerMean: mean(corner),
    };
    row.ok = onlyOurs === 0 && byFrame.size === 0 && kp.frames.length > 0 && row.cornerMax <= tolerance;
    failed ||= !row.ok;
    planeRows.push(row);
  });
}

const fmt = (x) => (typeof x === 'number' && !Number.isInteger(x) ? x.toExponential(2) : x);
const table = (head, list, cells) => {
  if (!list.length) return;
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
  for (const r of list) console.log(`| ${cells(r).map(fmt).join(' | ')} |`);
  console.log();
};
table(
  ['case', 'track', 'model', 'match', 'frames (ours / Blender)', 'lost (ours / Blender)', 'centre max px', 'centre mean px', 'corner max px', 'ok'],
  rows,
  (r) => [r.case, r.track, r.model, r.match, r.frames, r.lost, r.centreMax, r.centreMean, r.cornerMax, r.ok ? 'yes' : 'NO'],
);
table(
  ['case', 'threshold', 'min distance', 'margin', 'placement', 'features (ours / Blender)', 'same position', 'same position and order', 'ok'],
  detectRows,
  (r) => [r.case, String(r.threshold), r.minDistance, r.margin, r.placement, r.features, r.inBoth, r.inOrder, r.ok ? 'yes' : 'NO'],
);
table(
  ['case', 'plane', 'tracks', 'frames (ours / Blender)', 'corner max px', 'corner mean px', 'ok'],
  planeRows,
  (r) => [r.case, r.plane, r.tracks, r.frames, r.cornerMax, r.cornerMean, r.ok ? 'yes' : 'NO'],
);
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ tracks: rows, detect: detectRows, planes: planeRows }, null, 2));
process.exit(failed ? 1 : 0);
