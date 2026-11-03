#!/usr/bin/env node
// Compares the oracle's PNGs with Kinetograph's: PSNR and SSIM (ffmpeg, over RGBA) for each (effect, backend), and writes
// the status of each effect.
//
//   node scripts/remotion-effects/compare.mjs <rDir> <kDir> <effects.json> <out.json>
//
// status: "supported" when the picture of the backend `auto` picks (webgpu, webgl2, 2d: the first Kinetograph draws) matches at 50 dB PSNR or more; "approximated"
// from 25 to 50 dB (edges and rounding differ, the picture is the same); "not yet" when it failed or is below that.
// The numbers are for one frame and one set of parameters (params.mjs): a floor, not a proof for every parameter.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NOTES } from './notes.mjs';

const [rDir, kDir, effectsFile, outFile] = process.argv.slice(2).map((p) => resolve(p));
const { version, effects } = JSON.parse(readFileSync(effectsFile, 'utf8'));
const metric = (a, b, filter, pattern) => {
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', a, '-i', b, '-lavfi', `[0:v]format=rgba[a];[1:v]format=rgba[b];[a][b]${filter}`, '-f', 'null', '-'], { encoding: 'utf8' });
  const all = [...stderr.matchAll(pattern)];
  const last = all.at(-1)?.[1];
  // 999 dB stands for identical pictures (ffmpeg says inf).
  return last === undefined ? null : last === 'inf' ? 999 : Number(last);
};

const failures = {};
for (const file of ['report-webgl2.json', 'report-webgpu.json', 'report-2d.json', 'report-webgl2-webgpu-2d.json']) {
  if (!existsSync(join(kDir, file))) continue;
  for (const r of JSON.parse(readFileSync(join(kDir, file), 'utf8'))) if (!r.ok) failures[`${r.id}/${r.backend}`] = r.error;
}
const result = {};
for (const [id, info] of Object.entries(effects)) {
  const backends = {};
  for (const backend of info.impls ?? []) {
    const a = join(rDir, `r-${id}-${backend}.png`);
    const b = join(kDir, `k-${id}-${backend}.png`);
    if (!existsSync(a)) continue;
    if (!existsSync(b)) {
      backends[backend] = { error: failures[`${id}/${backend}`] ?? 'not rendered' };
      continue;
    }
    backends[backend] = { psnr: metric(a, b, 'psnr', /average:([0-9.a-z]+)/g), ssim: metric(a, b, 'ssim', /All:([0-9.]+)/g) };
  }
  const drawn = Object.entries(backends).filter(([, v]) => v.psnr !== undefined && v.psnr !== null).map(([backend, v]) => ({ backend, ...v }));
  // `auto` tries webgpu, then webgl2, then 2d, and keeps the first that draws: that is the effect's picture.
  const auto = ['webgpu', 'webgl2', '2d'].map((b) => drawn.find((v) => v.backend === b)).find((v) => v !== undefined);
  const status = auto === undefined ? 'not yet' : auto.psnr >= 50 ? 'supported' : auto.psnr >= 25 ? 'approximated' : 'not yet';
  result[id] = { sub: info.sub, backends: info.impls, status, ...(NOTES[id] ? { note: NOTES[id] } : {}), measured: backends };
}
writeFileSync(outFile, JSON.stringify({ version, frame: 0, size: '960x540', effects: result }, null, 1));
const count = (s) => Object.values(result).filter((e) => e.status === s).length;
console.log(`${Object.keys(result).length} effects: ${count('supported')} supported, ${count('approximated')} approximated, ${count('not yet')} not yet`);
