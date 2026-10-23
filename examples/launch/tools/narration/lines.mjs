#!/usr/bin/env node
// Splits the narration take's word timestamps into the script's lines, for the film (sound-timing.ts, the captions).
// The take is ONE file, played whole; nothing here cuts or moves its audio. Each line is a run of the take's words,
// kept under its old per-line key with its words timed from the line's first word, plus `take` with the whole thing.
//
//   node tools/narration/lines.mjs <asr json> <take wav name>      (from examples/launch)
//   e.g. node tools/narration/lines.mjs tools/narration/voice/asr_onetake_v3.json full_4.wav
//
// Writes tools/narration/voice/asr_narrator_final.json. Fails if the line word counts don't cover the take's words.

import { readFileSync, writeFileSync } from 'node:fs';

/** The script's lines in order and how many of the ASR's words each is (the ASR's own tokens: "1891," is one word,
 *  "drop" and "-in" are two, ".dev." is its own). */
const LINES = [
  ['02-1891', 7], // In 1891, the Kinetograph made pictures move.
  ['03-today', 12], // Until now, video from code meant a browser screenshotting every single frame.
  ['04-you-dont', 4], // Kinetograph doesn't need one.
  ['05-render', 6], // It renders straight on the GPU.
  ['07a-your', 6], // Your demo. Your launch. Your changelog.
  ['07b-write', 7], // Write it in code, and it renders.
  ['07c-text', 4], // And not just text.
  ['m1-3d', 2], // Real 3D.
  ['m2-iso', 2], // Isometric scenes.
  ['m3-shaders', 1], // Shaders.
  ['m4-canvas', 1], // Canvas.
  ['m5-glass', 6], // Even glass that bends the light.
  ['08-remotion', 9], // Already using Remotion? Kinetograph is a drop-in replacement.
  ['09-film', 7], // This whole film rendered in N seconds.
  ['10-pixels', 6], // No Chromium. No screenshots. Just pixels.
  ['12-end', 11], // Kinetograph. Motion pictures, written in code. Try it at kinetograph dot dev.
];

const [src, name] = process.argv.slice(2);
if (!src || !name) {
  console.error('usage: lines.mjs <asr json> <take wav name>');
  process.exit(2);
}
const asr = JSON.parse(readFileSync(src, 'utf8'));
const key = Object.keys(asr).find((k) => k.endsWith(`/${name}`));
if (!key) throw new Error(`no ${name} in ${src}`);
const words = asr[key].words;
const total = LINES.reduce((a, [, n]) => a + n, 0);
if (total !== words.length) throw new Error(`the lines cover ${total} words, the take has ${words.length}: ${words.map((w) => w.w).join(' ')}`);

const r3 = (v) => Math.round(v * 1000) / 1000;
const out = { take: { src: key, dur: asr[key].dur, text: asr[key].text, words } };
let i = 0;
for (const [file, n] of LINES) {
  const ws = words.slice(i, i + n);
  i += n;
  const t0 = ws[0].s;
  out[`voice/final_narrator/${file}.wav`] = {
    text: ws.map((w) => w.w).join(' '),
    /** Where the line starts in the take, in seconds. */
    at: r3(t0),
    words: ws.map((w) => ({ w: w.w, s: r3(w.s - t0), e: r3(w.e - t0) })),
  };
}
writeFileSync('tools/narration/voice/asr_narrator_final.json', JSON.stringify(out, null, 1));
console.log(`${LINES.length} lines from ${key} (${asr[key].dur} s)`);
