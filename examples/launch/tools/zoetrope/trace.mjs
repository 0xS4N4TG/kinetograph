#!/usr/bin/env node
// Offline tracer for the m4 zoetrope: turns Muybridge's "The Horse in Motion" card (1878, public domain) into pen
// strokes, one set per frame of the gallop. The film only reads the JSON, so a render never runs this.
//
//   node tools/zoetrope/trace.mjs --in out/sources/muybridge/horse-in-motion-hires.tiff --out public/mg/horse.json
//
// The card is a 4 x 3 grid of photographs; frames 1 to 11 are the gallop (12 is the horse standing). For each cell:
// threshold the dark silhouette, open the mask (erode, then dilate) so the card's thin grid and ground lines drop
// out, keep the horse and rider (the biggest dark shape, and any piece over a few percent of it, such as a tail
// wisp), then write its outline as polylines and a fill of horizontal hatch lines, the way a pen plotter would draw
// it. Coordinates are in the cell's own box, 0..1 across and 0..ASPECT down.
// Output: { aspect, frames: [{ outline: [[x, y, x, y, ...], ...], hatch: [[x1, y1, x2, y2], ...] }, ...] }

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const IN = opt('in');
const OUT = opt('out');
const WIDTH = Number(opt('width', '2400'));
const DARK = Number(opt('dark', '80'));
const OPEN = Number(opt('open', '2'));
const HATCH = Number(opt('hatch', '0.012'));
if (!IN || !OUT) {
  console.error('usage: trace.mjs --in card.tiff --out horse.json [--width 2400] [--dark 80] [--open 2] [--hatch 0.012]');
  process.exit(2);
}

// The cells, as fractions of the card, measured on a 1600 x 985 view and inset from the black borders.
const CW = 1600, CH = 985;
const COLS = [[44, 394], [433, 777], [816, 1157], [1198, 1557]];
const ROWS = [[52, 266], [302, 513], [548, 768]];

const probe = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', IN]);
let dims = '';
probe.stdout.on('data', (c) => (dims += c));
probe.on('close', () => {
  const [sw, sh] = dims.trim().split(',').map(Number);
  const W = WIDTH, H = Math.round((WIDTH * sh) / sw / 2) * 2;
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', IN, '-vf', `scale=${W}:${H},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  const chunks = [];
  ff.stdout.on('data', (c) => chunks.push(c));
  ff.stderr.pipe(process.stderr);
  ff.on('close', (code) => {
    if (code !== 0) process.exit(code ?? 1);
    const img = Buffer.concat(chunks);
    const frames = [];
    let aspect = 0;
    for (let n = 0; n < 11; n++) {
      const [x0, x1] = COLS[n % 4].map((v) => Math.round((v / CW) * W));
      const [y0, y1] = ROWS[Math.floor(n / 4)].map((v) => Math.round((v / CH) * H));
      const cw = x1 - x0, ch = y1 - y0;
      aspect ||= ch / cw;
      let m = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = img[(y0 + y) * W + x0 + x] < DARK ? 1 : 0;
      m = morph(morph(m, cw, ch, OPEN, false), cw, ch, OPEN, true);
      m = keepBig(m, cw, ch);
      frames.push({ outline: outline(m, cw, ch), hatch: hatch(m, cw, ch) });
    }
    writeFileSync(OUT, JSON.stringify({ aspect: round(aspect), frames }));
    console.log(`wrote ${OUT}: ${frames.length} frames, ${frames.map((f) => `${f.outline.length}/${f.hatch.length}`).join(' ')}`);
  });
});

const round = (v) => Math.round(v * 10000) / 10000;

/** Erode (grow false) or dilate (grow true) a 0/1 mask by a square of radius r. */
function morph(m, w, h, r, grow) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -r; dy <= r && v === (grow ? 0 : 1); dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : m[yy * w + xx];
          if (grow ? s : !s) { v = grow ? 1 : 0; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Keeps the biggest connected shape and any other over 4% of its size. */
function keepBig(m, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % w, y = (p - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (m[q] && label[q] < 0) { label[q] = id; stack.push(q); }
      }
    }
    sizes.push(size);
  }
  const big = Math.max(...sizes);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0 && sizes[label[i]] >= big * 0.04) out[i] = 1;
  return out;
}

/** The mask's outline by marching squares, joined into polylines and simplified, in cell units (x / w, y / w). */
function outline(m, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]);
  const segs = [];
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = (at(x, y) << 3) | (at(x + 1, y) << 2) | (at(x + 1, y + 1) << 1) | at(x, y + 1);
      if (c === 0 || c === 15) continue;
      const T = [x + 1, y + 0.5], R = [x + 1.5, y + 1], B = [x + 1, y + 1.5], L = [x + 0.5, y + 1];
      const add = (a, b) => segs.push([a, b]);
      switch (c) {
        case 1: case 14: add(L, B); break;
        case 2: case 13: add(B, R); break;
        case 3: case 12: add(L, R); break;
        case 4: case 11: add(T, R); break;
        case 5: add(L, T); add(B, R); break;
        case 6: case 9: add(T, B); break;
        case 7: case 8: add(L, T); break;
        case 10: add(T, R); add(L, B); break;
      }
    }
  }
  // join the segments end to end
  const key = (p) => `${p[0]},${p[1]}`;
  const ends = new Map();
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); (ends.get(k) ?? ends.set(k, []).get(k)).push(i); } });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i][0], segs[i][1]];
    for (let grew = true; grew;) {
      grew = false;
      const tail = pts[pts.length - 1];
      for (const j of ends.get(key(tail)) ?? []) {
        if (used[j]) continue;
        used[j] = 1;
        pts.push(key(segs[j][0]) === key(tail) ? segs[j][1] : segs[j][0]);
        grew = true;
        break;
      }
    }
    if (pts.length < 12) continue; // specks
    const simple = rdp(pts, 0.9);
    lines.push(simple.flatMap(([x, y]) => [round(x / w), round(y / w)]));
  }
  return lines;
}

/** Ramer-Douglas-Peucker simplification of a polyline. */
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay);
  let best = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    // a closed loop's ends meet, so measure from the end point itself
    const d = len < 1e-6 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
      : Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > best) { best = d; at = i; }
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, at + 1), eps).slice(0, -1), ...rdp(pts.slice(at), eps)];
}

/** Horizontal hatch lines through the mask every HATCH of the cell's width, as [x1, y1, x2, y2] in cell units. */
function hatch(m, w, h) {
  const out = [];
  const step = Math.max(2, Math.round(HATCH * w));
  for (let y = Math.floor(step / 2); y < h; y += step) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && m[y * w + x];
      if (on && run < 0) run = x;
      if (!on && run >= 0) {
        if (x - run > 2) out.push([round(run / w), round(y / w), round(x / w), round(y / w)]);
        run = -1;
      }
    }
  }
  return out;
}
