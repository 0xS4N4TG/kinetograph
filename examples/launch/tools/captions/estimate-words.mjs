#!/usr/bin/env node
// Estimated word timings for the launch narration: spreads each script line's words over the line's voiceover
// duration (sound-vo.ts VO_SECONDS) by syllable count. This is a stand-in: a speech-to-text run gives real
// word-level timestamps in the same shape, and `captions/words.json` can be replaced with them unchanged.
//
//   node tools/captions/estimate-words.mjs [--lines 02-question,03-screenshot,...] [--gap 0.15] [--lead 0.3] [--out captions/words.json]
//
// Output: { estimated: true, source, fps?, lines: [{ id, file, start, end }], words: [{ text, start, end, emphasis }] },
// every time in seconds from the start of the scene. `lines` tells the scene which voiceover file plays when.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

const LINES = opt('lines', '02-question,03-screenshot,04-you-dont,05-render,07a-your,07b-write,07c-past').split(',');
const GAP = Number(opt('gap', '0.15'));
const LEAD = Number(opt('lead', '0.3'));
const OUT = join(root, opt('out', 'captions/words.json'));

const script = JSON.parse(readFileSync(join(root, 'tools/narration/script.json'), 'utf8'));
const soundVo = readFileSync(join(root, 'sound-vo.ts'), 'utf8');
const seconds = Object.fromEntries([...soundVo.matchAll(/'([^']+)':\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));

/** Syllables of an English word: vowel groups, minus a silent final e, at least one. Numbers read digit by digit. */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return 1;
  if (/^\d+$/.test(w)) return w.length;
  let n = (w.replace(/e$/, '').replace(/(?:[^aeiouy]es|ed)$/, '').match(/[aeiouy]+/g) ?? []).length;
  if (/le$/.test(w) && !/[aeiouy]le$/.test(w)) n += 1;
  return Math.max(1, n);
}

/** Words the captions blow up and colour: the product, and the nouns the film is about. */
const EMPHASIS = new Set([
  'kinetograph', 'gpu', '3d', 'code', 'browser', 'chrome', 'remotion', 'video', 'screenshot', 'frame', 'pixels',
  'render', 'glass', 'webgl', 'canvas', 'demo', 'launch', 'changelog', 'api', 'faster', 'text',
]);
const isEmphasis = (w) => EMPHASIS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''));

const out = { estimated: true, source: 'syllable-count spread over each line of VO_SECONDS (sound-vo.ts)', lines: [], words: [] };
let t = LEAD;
for (const id of LINES) {
  const line = script.find((l) => l.id === id);
  const dur = seconds[id];
  if (!line || dur === undefined) throw new Error(`no script line or VO duration for ${id}`);
  const tokens = line.text.split(/\s+/).filter(Boolean);
  // A comma or full stop takes a short beat on top of the word's syllables.
  const weights = tokens.map((w) => syllables(w) + (/[,.?!]$/.test(w) ? 0.6 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let at = t;
  tokens.forEach((raw, i) => {
    const span = (weights[i] / total) * dur;
    // The beat after punctuation is silence, so the word itself ends a little before the next one starts.
    const spoken = /[,.?!]$/.test(raw) ? span * 0.78 : span * 0.94;
    out.words.push({
      text: raw.replace(/^["“(]+|["”)]+$/g, ''),
      start: +at.toFixed(3),
      end: +(at + spoken).toFixed(3),
      emphasis: isEmphasis(raw),
    });
    at += span;
  });
  out.lines.push({ id, file: `vo/${id}.wav`, start: +t.toFixed(3), end: +(t + dur).toFixed(3) });
  t += dur + GAP;
}
out.duration = +(t - GAP + 0.4).toFixed(3);
const row = (o) => `  ${JSON.stringify(o)}`;
const { lines, words, ...head } = out;
writeFileSync(OUT, `{\n${Object.entries(head).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n "lines": [\n${lines.map(row).join(',\n')}\n ],\n "words": [\n${words.map(row).join(',\n')}\n ]\n}\n`);
console.log(`${out.words.length} words, ${out.duration}s -> ${OUT}`);
