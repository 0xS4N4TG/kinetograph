// The launch film's music and sound design as a list of cues (see sound-synth.ts for the sounds).
//
// Music: 120 BPM, a beat every 15 frames. The cuts land on beats: shot 3 starts on beat 6, shot 7 on beat 22, shot 11
// on beat 60 plus 3 frames, so the grid is re-anchored at each of those three. Key: D minor, Bb under shots 4, 5 and 8,
// G minor under shot 9, D major on the end card.

import { VO_SECONDS } from './sound-vo.js';
import { BURN, FPS, START, TOTAL, VO } from './sound-timing.js';
import { DUCK, bass, bell, cue, hat, hit, kick, pad, pen, riser, rumble, shutter, sweep, tick } from './sound-synth.js';

const BEAT = 15;
const sec = (frames: number): number => frames / FPS;
const at = (shot: keyof typeof START, local: number): number => START[shot] + local;

for (const v of VO) {
  const a = sec(at(v.shot, v.at));
  DUCK.push([a, a + (VO_SECONDS[v.file] ?? 2)]);
}

// ---- pads: one chord per section, overlapping a little so they cross-fade ----
const D = { D1: 36.71, Bb1: 58.27, G1: 49, D2: 73.42, A2: 110, D3: 146.83, F3: 174.61, A3: 220, D4: 293.66, Fs3: 185 };
const chords: { from: number; to: number; hz: number[]; level: number; cutoff: [number, number] }[] = [
  { from: 0, to: START.s04, hz: [D.D2, D.A2, D.D3, D.F3], level: 0.17, cutoff: [260, 700] },
  { from: START.s04, to: START.s07, hz: [58.27, 87.31, 116.54, D.D3], level: 0.19, cutoff: [300, 800] },
  { from: START.s07, to: START.s08, hz: [D.D2, D.A2, D.D3, D.A3], level: 0.2, cutoff: [600, 1400] },
  { from: START.s08, to: START.s09, hz: [58.27, 87.31, 116.54, D.F3, 233.08], level: 0.19, cutoff: [600, 1200] },
  { from: START.s09, to: START.s10, hz: [98, D.D3, 196, 233.08], level: 0.17, cutoff: [500, 1000] },
  { from: START.s10, to: START.s11, hz: [D.D2, D.A2], level: 0.14, cutoff: [220, 420] },
  { from: START.s11, to: at('s11', 66), hz: [D.D2, D.A2, D.D3, D.F3, D.D4], level: 0.28, cutoff: [900, 1800] },
  { from: at('s11', 66), to: at('s12', 6), hz: [D.D2, D.A2, D.D3, D.F3], level: 0.17, cutoff: [500, 900] },
  { from: at('s12', 6), to: TOTAL, hz: [D.D2, D.A2, D.D3, D.Fs3, D.A3, D.D4], level: 0.22, cutoff: [1400, 2400] },
];
for (const c of chords) {
  const start = Math.max(0, c.from - 8);
  cue(start, (q) => pad(q, sec(c.to - start), c.hz, c.level, c.cutoff, c.from === 0 ? 1.8 : 0.9, c.to === TOTAL ? 1.2 : 0.9));
}

/** Frames of a beat grid anchored at `from`, every `every` beats, before `to`. */
const grid = (from: number, to: number, every = 1): number[] => {
  const out: number[] = [];
  for (let f = from; f < to; f += BEAT * every) out.push(f);
  return out;
};

// ---- shots 1 and 2: a low drone and a build into the first beat ----
cue(0, (q) => rumble(q, 1.2, 0.05, 0.9, 'open-rumble'));
cue(at('s03', -20), (q) => riser(q, sec(20) - 0.04, 0.05, false));

// ---- shot 3: the problem. The kick comes in on the cut, a shutter clicks with each flash (every 6 frames) ----
grid(START.s03, START.s04).forEach((f, i) => cue(f, (q) => kick(q, 0.5 + Math.min(0.2, i * 0.04))));
for (let f = START.s03; f < START.s04; f += 6) cue(f, (q) => shutter(q, 0.13));
for (const f of grid(START.s03 + BEAT / 2, START.s04)) cue(f, (q) => hat(q, 0.04));

// ---- shot 4: "you don't": the melt drains, the pulse drops out ----
cue(START.s04, (q) => kick(q, 0.55));
cue(at('s04', 4), (q) => sweep(q, 1.3, 5200, 160, 0.3, 0.2, 'melt', 0.9));
cue(at('s04', 30), (q) => bass(q, 58.27, 1.4, 0.34));

// ---- shot 5: "you just render it": the pad opens, a slow heartbeat, a riser into the burn ----
for (const f of grid(START.s05, BURN - 36, 2)) cue(f, (q) => kick(q, 0.42));
cue(at('s05', 52), (q) => tick(q, 0.07, 1500, 700));
cue(BURN - 28, (q) => riser(q, sec(26), 0.16));
cue(BURN - 14, (q) => rumble(q, 1.4, 0.55, 0.5, 'burn-rumble'));

// ---- shot 6: the burn, centred on the cut into shot 7 ----
cue(BURN, (q) => hit(q, 0.8));
cue(BURN, (q) => kick(q, 0.85));

// ---- shot 7: the beat drives: kick on every beat, bass and hats on the off-beats ----
const bassLine = [73.42, 73.42, 87.31, 73.42];
grid(START.s07, START.s08).forEach((f, i) => {
  cue(f, (q) => kick(q, 0.78));
  cue(f + BEAT / 2 + 0.5, (q) => bass(q, bassLine[i % 4]!, 0.2, 0.3));
  cue(f + BEAT / 2 + 0.5, (q) => hat(q, 0.05));
});
for (let k = 1; k < 5; k++) cue(at('s07', k * 30), (q) => tick(q, 0.09, 1700, 850)); // the word swaps
cue(at('s07', 94), (q) => sweep(q, 0.8, 300, 4200, 0.34, 0.7, 'whoosh-collapse'));
for (let i = 0; i < 20; i += 2) cue(at('s07', 124 + i), (q) => shutter(q, 0.05)); // "that render for you" types on

// ---- shot 8: drop-in: the pulse keeps going on half the weight; the pull-out whooshes; the counter ticks up ----
grid(START.s08, START.s09).forEach((f, i) => {
  cue(f, (q) => kick(q, 0.55));
  if (i % 2) cue(f + BEAT / 2, (q) => hat(q, 0.035));
});
cue(at('s08', 4), (q) => tick(q, 0.1, 2200, 1100));
cue(at('s08', 38), (q) => sweep(q, 0.9, 250, 3600, 0.3, 0.6, 'whoosh-pull'));
for (let i = 0; i < 10; i++) cue(at('s08', 70 + i * 3), (q) => tick(q, 0.06, 1200 + i * 120, 700 + i * 60));
cue(at('s08', 101), (q) => bell(q, 1318.5, 0.07, 1.6));

// ---- shot 9: the numbers: half-time pulse; the red bar stops, the counter rolls, the impact lands ----
grid(START.s09, START.s10, 2).forEach((f) => cue(f, (q) => kick(q, 0.6)));
for (const f of grid(START.s09 + BEAT, START.s10, 2)) cue(f, (q) => hat(q, 0.035));
cue(at('s09', 14), (q) => tick(q, 0.16, 2400, 1200));
for (let i = 0; i < 17; i++) cue(at('s09', 18 + i * 3), (q) => tick(q, 0.05, 1500 + i * 60, 800));
cue(at('s09', 62), (q) => hit(q, 0.6, 0.6));
cue(at('s09', 62), (q) => bell(q, 659.25, 0.07, 2));

// ---- shot 10: the pulse lets go; pen taps and scratches as the words land and strike; a riser into shot 11 ----
const LAND = [1, 5, 24, 30, 57, 62];
LAND.forEach((l, i) => cue(at('s10', l + 1), (q) => tick(q, i % 2 ? 0.07 : 0.1, 1100, 600)));
cue(at('s10', 19), (q) => pen(q, sec(11), 0.2, 'pen-1'));
cue(at('s10', 52), (q) => pen(q, sec(11), 0.2, 'pen-2'));
cue(at('s10', 71), (q) => pen(q, sec(15), 0.17, 'pen-3'));
cue(START.s11 - 28, (q) => riser(q, sec(27), 0.2));
cue(START.s11 - 22, (q) => kick(q, 0.28));
cue(START.s11 - 12, (q) => kick(q, 0.34));
cue(START.s11 - 6, (q) => kick(q, 0.4));

// ---- shot 11: the flicker: a hit on the first frame, the beat, a flutter of clicks as the pictures flip ----
cue(START.s11, (q) => hit(q, 0.85));
const flickerEnd = at('s11', 66);
grid(START.s11, flickerEnd).forEach((f) => cue(f, (q) => kick(q, 1.1)));
for (const f of grid(START.s11 + BEAT / 2, flickerEnd)) {
  cue(f, (q) => hat(q, 0.09));
  cue(f, (q) => bass(q, 73.42, 0.22, 0.55));
}
for (let f = START.s11 + 2; f < flickerEnd; f += 2) cue(f, (q) => shutter(q, 0.035));
cue(flickerEnd - 14, (q) => sweep(q, sec(16), 800, 7000, 0.14, 0.95, 'reveal-swell', 0.8));
cue(flickerEnd, (q) => bell(q, 880, 0.1, 3));
cue(flickerEnd, (q) => bass(q, 73.42, 1.8, 0.35));
cue(at('s11', 84), (q) => tick(q, 0.06, 1400, 900));

// ---- shot 12: the end card: a short silence, the final hit on the wordmark, the tagline ticks in ----
cue(at('s12', 6) - 14, (q) => riser(q, sec(12), 0.1, false));
cue(at('s12', 6), (q) => hit(q, 1));
cue(at('s12', 6), (q) => kick(q, 0.9));
cue(at('s12', 6), (q) => bell(q, 587.33, 0.1, 3.5));
cue(at('s12', 6), (q) => bell(q, 1174.66, 0.05, 3));
cue(at('s12', 13), (q) => tick(q, 0.07, 1000, 500)); // the red dot
for (const l of [38, 47, 69, 77]) cue(at('s12', l), (q) => tick(q, 0.07, 1500, 800));
cue(at('s12', 92), (q) => tick(q, 0.06, 1800, 900));
cue(at('s12', 104), (q) => tick(q, 0.04, 2400, 1400));
