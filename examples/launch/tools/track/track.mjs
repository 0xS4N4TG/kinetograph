#!/usr/bin/env node
// Offline point tracker for the shot 7 captions: follows one patch of a clip (a head, a plane) frame to frame by
// template matching, and writes where it is on every frame. The film only reads the JSON, so a render never runs this.
//
//   node tools/track/track.mjs --in public/footage/parade.mp4 --box 900,300,120,120 [--fps 30] [--search 40]
//                              [--adapt 0.08] [--out track/parade.json]
//
// --box is x,y,w,h of the patch on the clip's first frame, in output pixels (1920x1080, the clip filling the frame).
// Matching runs on a grey 480x270 copy: for each frame, the patch's best place (least squared difference) within
// --search pixels of the last one; the template drifts toward what it finds by --adapt, so it follows slow changes.
// Output: { clip, fps, width, height, points: [[x, y], ...] }, one point per frame, the patch centre in output pixels.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const IN = opt('in');
const OUT = opt('out');
const FPS = Number(opt('fps', '30'));
const SEARCH = Number(opt('search', '40'));
const ADAPT = Number(opt('adapt', '0.08'));
const [bx, by, bw, bh] = (opt('box') ?? '').split(',').map(Number);
if (!IN || !OUT || [bx, by, bw, bh].some((v) => !Number.isFinite(v))) {
  console.error('usage: track.mjs --in clip.mp4 --box x,y,w,h --out out.json');
  process.exit(2);
}

const W = 1920, H = 1080, S = 4; // output size, and the shrink to the matching copy
const w = W / S, h = H / S;
const ff = spawn('ffmpeg', ['-v', 'error', '-i', IN, '-vf', `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']);
const chunks = [];
ff.stdout.on('data', (c) => chunks.push(c));
ff.stderr.pipe(process.stderr);
ff.on('close', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const all = Buffer.concat(chunks);
  const n = Math.floor(all.length / (w * h));
  const tw = Math.round(bw / S), th = Math.round(bh / S), r = Math.round(SEARCH / S);
  let x = Math.round(bx / S), y = Math.round(by / S);
  const frame = (i) => all.subarray(i * w * h, (i + 1) * w * h);
  const tpl = new Float64Array(tw * th);
  const f0 = frame(0);
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) tpl[j * tw + i] = f0[(y + j) * w + x + i];
  const points = [];
  for (let f = 0; f < n; f++) {
    const img = frame(f);
    let best = Infinity, bxf = x, byf = y;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const ox = x + dx, oy = y + dy;
      if (ox < 0 || oy < 0 || ox + tw > w || oy + th > h) continue;
      let ssd = 0;
      for (let j = 0; j < th && ssd < best; j++) {
        const row = (oy + j) * w + ox;
        for (let i = 0; i < tw; i++) { const d = img[row + i] - tpl[j * tw + i]; ssd += d * d; }
      }
      if (ssd < best) { best = ssd; bxf = ox; byf = oy; }
    }
    x = bxf; y = byf;
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) tpl[j * tw + i] += (img[(y + j) * w + x + i] - tpl[j * tw + i]) * ADAPT;
    points.push([Math.round((x + tw / 2) * S), Math.round((y + th / 2) * S)]);
  }
  writeFileSync(OUT, JSON.stringify({ clip: IN, fps: FPS, width: W, height: H, points }) + '\n');
  console.log(`${n} frames -> ${OUT}`);
});
