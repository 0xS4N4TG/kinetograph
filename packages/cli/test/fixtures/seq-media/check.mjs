#!/usr/bin/env node
// Reads back the two renders of the seq-media fixture (index.tsx) and checks media timing inside timed <Sequence>s.
//   RateTrim: Sequence from=15 trimBefore=10 playbackRate=2, 60 frames. Child frame c = (f - 15) * 2 + 10 at abs frame f >= 15.
//             Click onsets (clicks at source frames 20, 40, 60, 80 after the trim) at abs frames 20, 30, 40, 50.
//   Loop:     Sequence durationInFrames=30 loop, 90 frames. Video file frame = f mod 30; clicks at rel 0 and 20 of each
//             30-frame iteration, i.e. abs frames 0, 20, 30, 50, 60, 80.
// Usage: node packages/cli/test/fixtures/seq-media/check.mjs <ratetrim.mp4> <loop.mp4>
// Needs ffmpeg and ffprobe on PATH and assets/ made by make-assets.sh. Exit code 1 when any check fails.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [rtPath, loopPath] = process.argv.slice(2);
if (!rtPath || !loopPath) {
  console.error('usage: check.mjs <ratetrim.mp4> <loop.mp4>');
  process.exit(2);
}

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets');
const W = 160;
const H = 90;
const FPS = 30;
const SR = 48000;
const TOL_MS = 12;
const LUMA_TOL = 2; // a rendered frame counts as file frame n when its mean luma is within this of the source's
const ONSET_THRESHOLD = 0.1; // RMS (full scale 1.0) over a 4 ms window
const WIN = 192; // 4 ms at 48 kHz
const HOP = 48; // 1 ms

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 1 << 30 });

function probe(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate', '-of', 'csv=p=0', path]).toString().trim();
  return out;
}

// Mean luma of every frame, decoded as gray (same conversion for the source and the renders).
function lumaFrames(path) {
  const buf = ff(['-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const n = buf.length / (W * H);
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * W * H;
    for (let j = 0; j < W * H; j++) s += buf[o + j];
    means.push(s / (W * H));
  }
  return means;
}

// Mono 48 kHz samples, float.
function samples(path) {
  const buf = ff(['-i', path, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
  const x = new Float32Array(buf.length / 4);
  for (let i = 0; i < x.length; i++) x[i] = buf.readFloatLE(i * 4);
  return x;
}

// Bursts of RMS above threshold; onset = centre of the first window of each burst.
function onsets(x) {
  const times = [];
  let inBurst = false;
  let maxRms = 0;
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    let acc = 0;
    for (let j = s; j < s + WIN; j++) acc += x[j] * x[j];
    const rms = Math.sqrt(acc / WIN);
    if (rms > maxRms) maxRms = rms;
    if (rms >= ONSET_THRESHOLD) {
      if (!inBurst) times.push((s + WIN / 2) / SR);
      inBurst = true;
    } else {
      inBurst = false;
    }
  }
  return { times, maxRms };
}

// Source luma per file frame. Frames 0..8 of gray.mp4 are all luma 0 and 118..119 are both 255, so those
// file frames cannot be told apart by luma; a match accepts any file frame within LUMA_TOL of the rendered luma.
const ref = lumaFrames(join(ASSETS, 'gray.mp4'));
const refCandidates = (m) => {
  const out = [];
  for (let n = 0; n < ref.length; n++) if (Math.abs(ref[n] - m) <= LUMA_TOL) out.push(n);
  return out;
};
const nearest = (m) => {
  let best = 0;
  for (let n = 1; n < ref.length; n++) if (Math.abs(ref[n] - m) < Math.abs(ref[best] - m)) best = n;
  return best;
};

console.log('source gray.mp4 luma (file frame -> mean Y):');
console.log('  ' + [0, 1, 8, 9, 10, 30, 60, 90, 117, 118, 119].map((n) => `${n}:${ref[n].toFixed(1)}`).join('  '));

function checkVideo(label, path, expectedFileFrame, frameCount, dims) {
  console.log(`\n${label}: ${path}`);
  console.log(`  stream ${probe(path)} (expect ${dims})`);
  const luma = lumaFrames(path);
  check(luma.length === frameCount, `${label} video has ${frameCount} frames (got ${luma.length})`);
  const rows = [];
  const bad = [];
  for (let f = 0; f < luma.length; f++) {
    const m = luma[f];
    const exp = expectedFileFrame(f);
    if (exp === null) {
      rows.push(`f${f}:Y${m.toFixed(1)}`);
      continue;
    }
    const ok = refCandidates(m).some((n) => Math.abs(n - exp) <= 1);
    rows.push(`f${f}:Y${m.toFixed(1)}->n${nearest(m)}(exp ${exp})${ok ? '' : ' X'}`);
    if (!ok) bad.push(`f${f} luma ${m.toFixed(2)} nearest n${nearest(m)} expected n${exp}`);
  }
  for (let i = 0; i < rows.length; i += 6) console.log('  ' + rows.slice(i, i + 6).join('  '));
  check(bad.length === 0, `${label} file frame matches expected for every frame with video` +
    (bad.length ? `: ${bad.length} mismatches, first: ${bad.slice(0, 5).join('; ')}` : ''));
  return luma;
}

function checkOnsets(label, path, expectedFrames) {
  const x = samples(path);
  const { times, maxRms } = onsets(x);
  console.log(`\n${label} audio: ${x.length} samples, ${(x.length / SR).toFixed(3)} s, max window RMS ${maxRms.toFixed(3)}`);
  console.log('  measured onsets: ' + (times.length ? times.map((t) => `${t.toFixed(4)}s (f${(t * FPS).toFixed(2)})`).join(', ') : 'none'));
  check(times.length === expectedFrames.length, `${label} onset count ${expectedFrames.length} (got ${times.length})`);
  expectedFrames.forEach((f, i) => {
    const want = f / FPS;
    const got = times[i];
    if (got === undefined) return check(false, `${label} onset ${i} at f${f} missing`);
    const errMs = (got - want) * 1000;
    check(Math.abs(errMs) <= TOL_MS,
      `${label} onset ${i}: expected f${f} (${want.toFixed(4)} s), measured ${got.toFixed(4)} s, error ${errMs.toFixed(1)} ms (tol ${TOL_MS})`);
  });
}

// RateTrim: frames before 15 are background (black); from 15 on, file frame = (f - 15) * 2 + 10.
const rtExpect = (f) => (f < 15 ? null : (f - 15) * 2 + 10);
const loopExpect = (f) => f % 30;

const rtLuma = checkVideo('RateTrim video', rtPath, rtExpect, 60, '160x90');
console.log('  frames 0..14 (expect background, no gray): ' +
  rtLuma.slice(0, 15).map((m, f) => `f${f}:Y${m.toFixed(1)}`).join(' '));
check(rtLuma.slice(0, 15).every((m) => m <= 20), 'RateTrim frames 0..14 are background (luma <= 20)');
checkOnsets('RateTrim', rtPath, [20, 30, 40, 50]);
{
  const x = samples(rtPath);
  const { times } = onsets(x);
  const early = times.filter((t) => t * FPS < 15 - 0.5);
  check(early.length === 0, `RateTrim no audio before frame 15 (${early.length} early onsets)`);
}

checkVideo('Loop video', loopPath, loopExpect, 90, '160x90');
checkOnsets('Loop', loopPath, [0, 20, 30, 50, 60, 80]);

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} check(s):`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
