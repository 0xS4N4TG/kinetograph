#!/usr/bin/env node
// Offline blob analysis for the tracking overlay. Decodes a clip with ffmpeg to small grayscale frames, thresholds
// them, finds connected blobs and follows them across frames with stable ids. The render only reads the JSON, so it
// stays a pure function of (project, frame); this tool is deterministic too (no clock, no randomness).
//
//   node tools/blobs/analyse.mjs <clip.mp4> [--out blobs/<clip>.json] [--width 160] [--mode median|diff|bright]
//                                [--thresh 0.1] [--max 12] [--min-area 0.0006] [--max-area 0.12]
//
// Modes: `median` (default) marks pixels that differ from the clip's per-pixel median picture, which suits a still
// camera with things moving in front of it; `diff` marks pixels that changed since two frames ago (any camera);
// `bright` marks pixels above `thresh` (0..1) of full brightness and `dark` those below it; `contrast` marks pixels that stand out from their
// surroundings (a wide blur of the same frame) by more than `thresh`, which picks out features on a still picture.
// Join modes with `+` to take the union, e.g. `median+contrast`; then `--thresh` is the first one's and
// `--thresh2` (default 0.08) is the `contrast` threshold.
//
// Output: { clip, fps, frames: <count>, mode, blobs: [ [ {id, x, y, w, h}, ... ] per frame ] } with x, y the blob's
// centre and w, h its size, all as fractions of the picture (0..1). `id` is stable while a blob is followed.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const clip = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
if (!clip) { console.error('usage: analyse.mjs <clip.mp4> [--out file] [--width 160] [--mode median|diff|bright] [--thresh 0.1] [--max 12]'); process.exit(2); }
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODE = opt('mode', 'median');
const MODES = MODE.split('+');
const THRESH = Number(opt('thresh', MODES[0] === 'bright' ? '0.85' : MODES[0] === 'dark' ? '0.3' : '0.1'));
const THRESH2 = Number(opt('thresh2', '0.08'));
const MAX = Number(opt('max', '12'));
const MIN_AREA = Number(opt('min-area', '0.0006'));
const MAX_AREA = Number(opt('max-area', '0.12'));
const OUT = opt('out', join(root, 'blobs', `${basename(clip, extname(clip))}.json`));

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', clip], { encoding: 'utf8' });
const [sw, sh, rate] = probe.stdout.trim().split(',');
const [rn, rd] = rate.split('/').map(Number);
const fps = rn / (rd || 1);
const W = Number(opt('width', '160'));
const H = Math.round((W * Number(sh)) / Number(sw));
const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
if (dec.status !== 0) { console.error(String(dec.stderr)); process.exit(1); }
const N = Math.floor(dec.stdout.length / (W * H));
const frames = Array.from({ length: N }, (_, i) => dec.stdout.subarray(i * W * H, (i + 1) * W * H));

/** 3x3 box blur, so single noisy pixels do not make blobs. */
function blur(f) {
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) { s += f[yy * W + xx]; c++; }
    }
    o[y * W + x] = s / c;
  }
  return o;
}
const smooth = frames.map(blur);

let background = null;
if (MODES.includes('median')) {
  background = new Uint8Array(W * H);
  const step = Math.max(1, Math.floor(N / 31));
  const idx = []; for (let i = 0; i < N; i += step) idx.push(i);
  const col = new Uint8Array(idx.length);
  for (let p = 0; p < W * H; p++) {
    idx.forEach((fi, k) => { col[k] = smooth[fi][p]; });
    background[p] = [...col].sort((a, b) => a - b)[idx.length >> 1];
  }
}

/** A wide blur (box, radius 10, twice) of a frame: what the surroundings of a pixel look like. */
function wideBlur(f) {
  const R = 10;
  let a = Float32Array.from(f);
  for (let pass = 0; pass < 2; pass++) {
    const h = new Float32Array(W * H), v = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += a[y * W + xx]; c++; } }
      h[y * W + x] = s / c;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += h[yy * W + x]; c++; } }
      v[y * W + x] = s / c;
    }
    a = v;
  }
  return a;
}

function mask(i) {
  const m = new Uint8Array(W * H);
  const f = smooth[i];
  const wide = MODES.includes('contrast') ? wideBlur(f) : null;
  for (let p = 0; p < W * H; p++) {
    let on = false;
    MODES.forEach((mode, k) => {
      const t = (k === 0 ? THRESH : THRESH2) * 255;
      if (mode === 'bright') on ||= f[p] > t;
      else if (mode === 'dark') on ||= f[p] < t;
      else if (mode === 'diff') on ||= i >= 2 && Math.abs(f[p] - smooth[i - 2][p]) > t;
      else if (mode === 'contrast') on ||= Math.abs(f[p] - wide[p]) > t;
      else on ||= Math.abs(f[p] - background[p]) > t;
    });
    m[p] = on ? 1 : 0;
  }
  return m;
}
function dilate(m) {
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) o[yy * W + xx] = 1;
    }
  }
  return o;
}

/** Connected components (8 neighbours), as boxes in picture fractions. */
function components(m) {
  const seen = new Uint8Array(W * H);
  const out = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const q = yy * W + xx;
        if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (area / (W * H) < MIN_AREA || area / (W * H) > MAX_AREA) continue;
    out.push({ x: (x0 + x1 + 1) / 2 / W, y: (y0 + y1 + 1) / 2 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H, area });
  }
  return out.sort((a, b) => b.area - a.area || a.x - b.x || a.y - b.y).slice(0, MAX);
}

// Nearest-neighbour tracking: closest pairs first, within MAX_JUMP of the picture's width; an unmatched blob gets a
// new id; a track that goes unseen for more than KEEP frames is dropped. Boxes ease towards the new detection.
const MAX_JUMP = 0.18, KEEP = 8, EASE = 0.6, SHOW_AFTER = 2;
let tracks = [];
let nextId = 1;
const perFrame = [];
for (let i = 0; i < N; i++) {
  const dets = components(dilate(dilate(mask(i))));
  const pairs = [];
  tracks.forEach((t, ti) => dets.forEach((d, di) => pairs.push({ ti, di, dist: Math.hypot(t.x - d.x, t.y - d.y) })));
  pairs.sort((a, b) => a.dist - b.dist || a.ti - b.ti || a.di - b.di);
  const usedT = new Set(), usedD = new Set();
  for (const p of pairs) {
    if (p.dist > MAX_JUMP || usedT.has(p.ti) || usedD.has(p.di)) continue;
    usedT.add(p.ti); usedD.add(p.di);
    const t = tracks[p.ti], d = dets[p.di];
    t.x += (d.x - t.x) * EASE; t.y += (d.y - t.y) * EASE; t.w += (d.w - t.w) * EASE; t.h += (d.h - t.h) * EASE;
    t.age++; t.missed = 0;
  }
  tracks.forEach((t, ti) => { if (!usedT.has(ti)) t.missed++; });
  dets.forEach((d, di) => { if (!usedD.has(di)) tracks.push({ id: nextId++, x: d.x, y: d.y, w: d.w, h: d.h, age: 1, missed: 0 }); });
  tracks = tracks.filter((t) => t.missed <= KEEP);
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  perFrame.push(tracks.filter((t) => t.missed === 0 && t.age >= SHOW_AFTER).sort((a, b) => a.id - b.id)
    .map((t) => ({ id: t.id, x: r4(t.x), y: r4(t.y), w: r4(t.w), h: r4(t.h) })));
}

mkdirSync(dirname(OUT), { recursive: true });
const head = JSON.stringify({ clip: basename(clip), fps, frames: N, mode: MODE, width: W, height: H });
writeFileSync(OUT, `${head.slice(0, -1)},"blobs":[\n${perFrame.map((f) => ' ' + JSON.stringify(f)).join(',\n')}\n]}\n`);
console.log(`${N} frames, ${nextId - 1} ids, ${(perFrame.reduce((a, f) => a + f.length, 0) / N).toFixed(1)} blobs/frame -> ${OUT}`);
