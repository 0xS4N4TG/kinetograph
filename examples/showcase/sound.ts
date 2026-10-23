// Sound design, synthesised with the Web Audio API through `onFrame` (the
// voiceover itself is <Audio> in index.tsx). Everything is quiet: ticks where a
// scene lands, key clicks while text types, a whoosh on the whip and a riser
// into the outro. Noise comes from `random(seed)`, so the mix is the same on
// every render.

import { random } from 'remotion';
import { onFrame } from '@kinetographdev/audio';
import type { OnFrameCallback } from '@kinetographdev/audio';
import { FPS, T, fr } from './common.js';
import { WHIP_AT } from './shots-c.js';

type Ctx = Parameters<OnFrameCallback>[0];

function noiseBuffer(ctx: Ctx, seconds: number, seed: string): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = random(`${seed}-${i}`) * 2 - 1;
  return buffer;
}

/** A short pitched blip: a UI tick. */
function tick(ctx: Ctx, t: number, volume = 0.16, from = 1800, to = 900): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + 0.05);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.08);
}

/** A key click: a few milliseconds of high-passed noise. */
function click(ctx: Ctx, t: number, volume: number, seed: string): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, 0.025, seed);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2600;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.022);
  source.connect(hp).connect(gain).connect(ctx.destination);
  source.start(t);
}

/** Noise through a band-pass that sweeps `from` to `to` Hz while it swells and fades. */
function sweep(ctx: Ctx, t: number, seconds: number, from: number, to: number, peak: number, peakAt: number, seed: string): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, seconds, seed);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.2;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + seconds * 0.85);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + seconds * peakAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  source.connect(band).connect(gain).connect(ctx.destination);
  source.start(t);
}

/** A soft two-note chime. */
function chime(ctx: Ctx, t: number, volume: number): void {
  for (const [hz, delay] of [[659.25, 0], [987.77, 0.07]] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(volume, t + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 1.2);
  }
}

/** The frame (of the whole video) where `local` frames into the shot starting at `shotStart` seconds falls. */
const at = (shotStart: number, local: number): number => fr(shotStart) + local;

// ---- ticks where things land ----
const landings = [
  at(T.s1, 4), // first word
  at(T.s2, 4), // the brackets
  at(T.s2, 17),
  at(T.s2, 33),
  at(T.s2, 52), // the cut to Kinetograph
  at(T.s2, 67), // the pictures inside it
  at(T.s3, 0), // the code card
  at(T.s5, 20),
  at(T.s5, 36),
  at(T.s5, 52),
  at(T.s5, 68),
  at(T.s6, 4),
  at(T.s6, 22),
  at(T.s6, 42),
  at(T.s7, 0),
  at(T.s7, 36),
  at(T.s7, 68),
  at(T.s10, 52),
];
for (const frame of landings) onFrame(frame, (ctx, t) => tick(ctx, t));
// the speed slide: a tick as each bar finishes
onFrame(at(T.s9, 16 + Math.round(1.9 * FPS * 0.31)), (ctx, t) => tick(ctx, t, 0.2, 2200, 1100));
onFrame(at(T.s9, 16 + Math.round(1.9 * FPS)), (ctx, t) => tick(ctx, t, 0.12, 1500, 800));

// ---- key clicks while text types ----
const typing: [number, number, number][] = [
  [at(T.s3, 10), 36, 2], // the code card: 2.3 characters a frame, a click every 2 frames
  [at(T.s4, 12), 36, 2], // `kinetograph render`
  [at(T.s4, 108), 34, 2], // `blur, blends, grain, light`
];
for (const [start, count, step] of typing) {
  for (let i = 0; i < count; i += step) {
    const frame = start + i;
    onFrame(frame, (ctx, t) => click(ctx, t, 0.07 + 0.03 * random(`vol-${frame}`), `click-${frame}`));
  }
}

// ---- the whip, and a riser into the outro ----
onFrame(at(T.s7, WHIP_AT - 4), (ctx, t) => sweep(ctx, t, 0.95, 300, 4200, 0.45, 0.7, 'whoosh'));
onFrame(fr(T.s10) - fr(1.3), (ctx, t) => sweep(ctx, t, 1.3, 500, 5200, 0.12, 0.92, 'riser'));
onFrame(fr(T.s10) + 2, (ctx, t) => chime(ctx, t, 0.07));
