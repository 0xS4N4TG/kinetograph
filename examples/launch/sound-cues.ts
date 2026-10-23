// The launch film's music and sound design as a list of cues (see sound-synth.ts for the sounds).
//
// Every effect is placed on the frame of the thing it belongs to, read from the shot that draws it (the windows of
// shot 3, the cards of shot 7, the counters, the pen strokes), so the sound moves with the picture when a shot is
// retimed. The music is a pad bed per section in D minor; a beat (120 BPM, every 15 frames) runs only under the
// collage of shot 7 and the flicker of shot 11, the two places the picture cuts on a pulse.

import { VO_SECONDS } from './sound-vo.js';
import { BURN, FPS, START, TOTAL, VO } from './sound-timing.js';
import { LEN } from './common.js';
import { LOOK, RISE_AT, S02_AT, S03_AT, WINDOWS, WIN_EVERY } from './act1.js';
import { FILM_AT } from './act1-camera.js';
import { CUTS, LINES, RECEIPTS_AT } from './act2-s07.js';
import { wordSpans } from './print/captions.js';
import { RECEIPT_SOUND } from './print/receipts.js';
import { S08_HOLD } from './act2-s08.js';
import { M1_DROPS, M2_DIVE, M3_TYPE, M4_SPIRO, WHIP } from './act2-mg.js';
import { IMPACT_AT, KINETOGRAPH_S, MULT_AT, RACE, REMOTION_S } from './act2-s09.js';
import { S10_CIRCLE, S10_LAND, S10_STRIKE, S12_TAG, S12_URL } from './act3.js';
import { FADE_START, FLIP_INTERVAL } from '@/components/snap-cn/logo-flicker';
import { DUCK, bass, bell, cue, cutter, hat, hit, kick, pad, paperDrop, pen, pop, projector, riser, room, rumble, shutter, sweep, thermal, tick } from './sound-synth.js';

const BEAT = 15;
const sec = (frames: number): number => frames / FPS;
const at = (shot: keyof typeof START, local: number): number => START[shot] + local;

for (const v of VO) {
  const a = sec(at(v.shot, v.at));
  DUCK.push([a, a + (VO_SECONDS[v.file] ?? 2)]);
}

// ---- pads: one chord per section, overlapping a little so they cross-fade ----
const D = { D2: 73.42, A2: 110, D3: 146.83, F3: 174.61, A3: 220, D4: 293.66, Fs3: 185 };
const chords: { from: number; to: number; hz: number[]; level: number; cutoff: [number, number] }[] = [
  { from: 0, to: START.s04, hz: [D.D2, D.A2, D.D3, D.F3], level: 0.15, cutoff: [260, 700] },
  { from: START.s04, to: START.s07, hz: [58.27, 87.31, 116.54, D.D3], level: 0.17, cutoff: [300, 800] },
  { from: START.s07, to: START.m1, hz: [D.D2, D.A2, D.D3, D.A3], level: 0.18, cutoff: [600, 1400] },
  { from: START.m1, to: START.s08, hz: [87.31, 130.81, 174.61, 220, 261.63], level: 0.17, cutoff: [700, 1700] },
  { from: START.s08, to: START.s09, hz: [58.27, 87.31, 116.54, D.F3, 233.08], level: 0.16, cutoff: [500, 1100] },
  { from: START.s09, to: START.s10, hz: [98, D.D3, 196, 233.08], level: 0.15, cutoff: [500, 1000] },
  { from: START.s10, to: START.s11, hz: [D.D2, D.A2], level: 0.12, cutoff: [220, 420] },
  { from: START.s11, to: at('s11', FADE_START), hz: [D.D2, D.A2, D.D3, D.F3, D.D4], level: 0.24, cutoff: [900, 1800] },
  { from: at('s11', FADE_START), to: at('s12', 6), hz: [D.D2, D.A2, D.D3, D.F3], level: 0.15, cutoff: [500, 900] },
  { from: at('s12', 6), to: TOTAL, hz: [D.D2, D.A2, D.D3, D.Fs3, D.A3, D.D4], level: 0.2, cutoff: [1400, 2400] },
];
for (const c of chords) {
  const start = Math.max(0, c.from - 8);
  cue(start, (q) => pad(q, sec(c.to - start), c.hz, c.level, c.cutoff, c.from === 0 ? 0.6 : 0.9, c.to === TOTAL ? 1.2 : 0.9));
}

// ---- shot 1: each of the four looks of "how" lands with a pop ----
for (let k = 0; k < 4; k++) cue(at('s01', k * LOOK), (q) => pop(q, 0.7 - k * 0.05, 900 + k * 250));

// ---- shot 2: the redaction bar whooshes across; the ink stroke scratches under "browser?" ----
cue(at('s02', 3), (q) => sweep(q, 0.45, 300, 3800, 0.22, 0.5, 'bar-whoosh'));
cue(at('s02', S02_AT[S02_AT.length - 1]! + 4), (q) => pen(q, sec(16), 0.18, 'pen-s02'));
cue(START.s03 - 18, (q) => riser(q, sec(18) - 0.03, 0.06, false));

// ---- shot 3: a shutter on every window that lands; a low pulse under the pile ----
cue(START.s03, (q) => rumble(q, sec(LEN.s03), 0.12, 0.6, 's03-rumble'));
for (let i = 0; i < WINDOWS; i++) {
  const f = i * WIN_EVERY - 6;
  if (f >= 0 && f < LEN.s03) cue(at('s03', f + 1), (q) => shutter(q, 0.16));
}
S03_AT.slice(0, 2).forEach((f) => cue(at('s03', f), (q) => tick(q, 0.05, 1200, 700)));

// ---- shot 4: the picture melts away; "you don't" lands; ink rises for the camera ----
cue(at('s04', 3), (q) => sweep(q, 1.1, 5200, 160, 0.26, 0.25, 'melt', 0.9));
cue(at('s04', 22), (q) => bass(q, 58.27, 1.2, 0.3));
cue(at('s04', RISE_AT - 2), (q) => sweep(q, sec(LEN.s04 - RISE_AT + 4), 200, 2400, 0.2, 0.95, 'rise'));

// ---- shot 5: the camera arrives with a flare; the orbit line draws; FILM scratches on; the projector starts ----
cue(START.s05, (q) => hit(q, 0.5, 0.25));
cue(at('s05', 6), (q) => sweep(q, sec(36), 600, 2600, 0.07, 0.6, 'orbit', 1.6));
cue(at('s05', FILM_AT), (q) => pen(q, sec(14), 0.16, 'pen-film'));

// ---- shot 6: the 16mm burn over the cut: a projector running up to speed and a warm swell, no impact ----
cue(BURN - 16, (q) => projector(q, sec(LEN.s06 + 6), 0.32, 'burn-projector'));
cue(BURN - 12, (q) => rumble(q, sec(LEN.s06), 0.22, 0.45, 'burn-swell'));
cue(BURN - 10, (q) => sweep(q, sec(LEN.s06 - 4), 700, 5200, 0.1, 0.5, 'burn-air', 0.7));

// ---- shot 7: the archive film runs with a projector's clatter under it and a shutter on its cut; a pen scratches as
//      each word writes itself, a soft low thump where one breaks out; on the cut to the receipts, a hit, then the
//      printer's buzz and the cutter, a quiet room, and each receipt's fall onto the pile ----
cue(at('s07', 0), (q) => projector(q, sec(RECEIPTS_AT), 0.12, 's07-projector'));
CUTS.slice(1).forEach((c) => cue(at('s07', c.at), (q) => shutter(q, 0.1)));
wordSpans(LINES, FPS).forEach((w, i) => {
  if (w.hot) {
    cue(at('s07', w.from), (q) => bass(q, 65.41, 0.5, 0.22));
    cue(at('s07', w.from), (q) => tick(q, 0.04, 900, 500));
  } else cue(at('s07', w.from), (q) => pen(q, sec(Math.max(3, w.to - w.from)), 0.07, `pen-s07-${i}`));
});
cue(at('s07', RECEIPTS_AT), (q) => hit(q, 0.3, 0.2));
cue(at('s07', RECEIPTS_AT), (q) => room(q, sec(LEN.s07 - RECEIPTS_AT), 0.08, 's07-room'));
cue(at('s07', RECEIPTS_AT + RECEIPT_SOUND.feed[0]), (q) => thermal(q, sec(RECEIPT_SOUND.feed[1] - RECEIPT_SOUND.feed[0]), 0.14, 's07-thermal'));
cue(at('s07', RECEIPTS_AT + RECEIPT_SOUND.cut), (q) => cutter(q, 0.3, 's07-cutter'));
RECEIPT_SOUND.drops.forEach((d) => cue(at('s07', RECEIPTS_AT + d.at), (q) => paperDrop(q, sec(d.land - d.at), 0.2, `drop-${d.key}`)));

// ---- the motion-graphics run: a pulse from the 3D reveal to the cut into shot 8; each piece has its own sound ----
for (let f = at('m1', 26); f < START.s08 - 4; f += BEAT) {
  cue(f, (q) => kick(q, 0.55));
  cue(f + BEAT / 2, (q) => hat(q, 0.035));
}
cue(at('m1', 24), (q) => sweep(q, sec(40), 180, 1800, 0.16, 0.7, 'm1-reveal', 0.9));
M1_DROPS.forEach((f, i) => {
  cue(at('m1', f + 10), (q) => kick(q, 0.35, q.sfx));
  cue(at('m1', f + 10), (q) => pop(q, 0.3, 520 + i * 140));
});
cue(START.m2 - WHIP - 2, (q) => sweep(q, sec(WHIP * 2 + 4), 900, 5200, 0.34, 0.5, 'whip', 0.7));
for (let d = 0; d < 6; d++) cue(at('m2', 2 + d * 3), (q) => tick(q, 0.06, 1300 + d * 160, 800));
cue(at('m2', M2_DIVE - 2), (q) => sweep(q, sec(LEN.m2 - M2_DIVE + 2), 300, 4200, 0.26, 0.95, 'dive', 0.9));
cue(START.m3, (q) => hit(q, 0.45, 0.2));
cue(START.m3, (q) => rumble(q, sec(LEN.m3), 0.14, 0.5, 'm3-swell'));
for (let f = M3_TYPE; f < M3_TYPE + 34; f += 2) cue(at('m3', f), (q) => shutter(q, 0.03));
cue(START.m4, (q) => sweep(q, sec(12), 400, 3000, 0.2, 0.8, 'iris'));
cue(at('m4', M4_SPIRO[0]), (q) => pen(q, sec(M4_SPIRO[1] - M4_SPIRO[0]), 0.13, 'pen-spiro'));
cue(START.m5, (q) => sweep(q, sec(30), 5200, 900, 0.12, 0.15, 'm5-pull', 0.8));
[1318.5, 1760, 2637].forEach((hz, i) => cue(at('m5', 14 + i * 5), (q) => bell(q, hz, 0.05 - i * 0.01, 2.2)));

// ---- shot 8: a tick as "from 'remotion'" lights up; a whoosh on the pull-out; the counter ticks up to 98 ----
const s08 = (orig: number): number => at('s08', orig + (S08_HOLD - 22));
cue(at('s08', 16), (q) => tick(q, 0.08, 2200, 1100));
cue(at('s08', S08_HOLD - 4), (q) => sweep(q, sec(62), 250, 3600, 0.24, 0.55, 'whoosh-pull'));
for (let o = 80; o < 112; o += 3) cue(s08(o), (q) => tick(q, 0.045, 1200 + (o - 80) * 25, 700));
cue(s08(112), (q) => hit(q, 0.4, 0.3));
cue(s08(112), (q) => bell(q, 1318.5, 0.06, 1.6));

// ---- shot 9: Kinetograph's bar stops first (a bright tick), Remotion's much later (a dull one); the multiple
//      counts up; IMPACT lands ----
const finish = (s: number): number => RACE[0] + ((RACE[1] - RACE[0]) * s) / REMOTION_S;
cue(at('s09', Math.round(finish(KINETOGRAPH_S))), (q) => tick(q, 0.14, 2600, 1300));
cue(at('s09', Math.round(finish(KINETOGRAPH_S))), (q) => bell(q, 987.77, 0.05, 1.2));
cue(at('s09', RACE[1]), (q) => tick(q, 0.1, 500, 300));
for (let f = MULT_AT; f < MULT_AT + 26; f += 3) cue(at('s09', f), (q) => tick(q, 0.045, 1500 + (f - MULT_AT) * 40, 800));
cue(at('s09', IMPACT_AT), (q) => hit(q, 0.6, 0.6));

// ---- shot 10: a pen tap as each word lands; the scratch of each strike and of the red loop; a riser into 11 ----
S10_LAND.forEach((l, i) => cue(at('s10', l), (q) => tick(q, i % 2 ? 0.05 : 0.07, 1100, 600)));
S10_STRIKE.forEach(([a, b], i) => cue(at('s10', a), (q) => pen(q, sec(b - a), 0.2, `pen-strike-${i}`)));
cue(at('s10', S10_CIRCLE[0]), (q) => pen(q, sec(S10_CIRCLE[1] - S10_CIRCLE[0]), 0.17, 'pen-loop'));
cue(START.s11 - 16, (q) => riser(q, sec(16), 0.16));

// ---- shot 11: a hit on the first frame, the beat, a click on every flip; a swell into the reveal ----
cue(START.s11, (q) => hit(q, 0.75));
for (let f = 0; f < FADE_START; f += BEAT) {
  cue(at('s11', f), (q) => kick(q, 0.9));
  cue(at('s11', f + BEAT / 2), (q) => hat(q, 0.07));
  cue(at('s11', f + BEAT / 2), (q) => bass(q, 73.42, 0.22, 0.45));
}
for (let f = FLIP_INTERVAL; f < FADE_START; f += FLIP_INTERVAL) cue(at('s11', f), (q) => shutter(q, 0.03));
cue(at('s11', FADE_START - 14), (q) => sweep(q, sec(16), 800, 7000, 0.12, 0.95, 'reveal-swell', 0.8));
cue(at('s11', FADE_START), (q) => bell(q, 880, 0.09, 3));
cue(at('s11', FADE_START), (q) => bass(q, 73.42, 1.8, 0.3));

// ---- shot 12: the final hit on the wordmark, a pop for the red dot, ticks on the tagline words and the URL ----
cue(at('s12', 6) - 12, (q) => riser(q, sec(12), 0.08, false));
cue(at('s12', 6), (q) => hit(q, 0.9));
cue(at('s12', 6), (q) => bell(q, 587.33, 0.09, 3.5));
cue(at('s12', 6), (q) => bell(q, 1174.66, 0.04, 3));
cue(at('s12', 14), (q) => pop(q, 0.35, 1000));
S12_TAG.forEach((l) => cue(at('s12', l), (q) => tick(q, 0.05, 1500, 800)));
cue(at('s12', S12_URL), (q) => tick(q, 0.06, 1800, 900));
