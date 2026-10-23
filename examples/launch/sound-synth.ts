// Synthesis building blocks for the launch soundtrack (Web Audio through @kinetograph/audio's onFrame).
// Everything is deterministic: noise comes from `random(seed)`, never the clock.

import { random } from 'remotion';
import { onFrame } from '@kinetograph/audio';
import type { OnFrameCallback } from '@kinetograph/audio';
import { FPS } from './sound-timing.js';

export type Ctx = Parameters<OnFrameCallback>[0];

export interface Bus {
  ctx: Ctx;
  /** Music goes here: ducked under the voice, with a reverb send. */
  music: GainNode;
  /** Sound effects go here: not ducked, with a smaller reverb send. */
  sfx: GainNode;
  noise: AudioBuffer;
}
export interface Cue extends Bus { t: number }

/** Voiceover windows in seconds, [start, end], for ducking. Filled by sound-cues.ts before the first cue runs. */
export const DUCK: [number, number][] = [];
const DUCK_GAIN = 0.42;
const MASTER = 0.38;

const buses = new WeakMap<Ctx, Bus>();

function buildBus(ctx: Ctx, base: number): Bus {
  const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 3), ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = random(`n-${i}`) * 2 - 1;

  // A hall: two seconds of decaying noise, different on each ear.
  const len = Math.round(ctx.sampleRate * 2.2);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (random(`ir-${c}-${i}`) * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  // everything we synthesise goes through one limiter and a master trim, so the hits cannot clip the mix
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -16;
  limiter.knee.value = 4;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  const trim = ctx.createGain();
  trim.gain.value = MASTER;
  limiter.connect(trim).connect(ctx.destination);
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.28;
  verb.connect(wet).connect(limiter);

  const music = ctx.createGain();
  const duck = ctx.createGain();
  music.connect(duck);
  duck.connect(limiter);
  const musicSend = ctx.createGain();
  musicSend.gain.value = 0.22;
  duck.connect(musicSend).connect(verb);

  const sfx = ctx.createGain();
  sfx.connect(limiter);
  const sfxSend = ctx.createGain();
  sfxSend.gain.value = 0.07;
  sfx.connect(sfxSend).connect(verb);

  // ducking: down 0.12 s ahead of each line, back up over 0.45 s after it
  duck.gain.setValueAtTime(1, 0);
  let last = 0;
  for (const [a, b] of DUCK) {
    const s = Math.max(last, a + base - 0.12);
    const e = b + base;
    if (e <= 0) continue;
    duck.gain.setValueAtTime(1, Math.max(0, s));
    duck.gain.linearRampToValueAtTime(DUCK_GAIN, Math.max(0, s) + 0.12);
    duck.gain.setValueAtTime(DUCK_GAIN, Math.max(0.13, e));
    duck.gain.linearRampToValueAtTime(1, Math.max(0.13, e) + 0.45);
    last = e + 0.45;
  }
  return { ctx, music, sfx, noise };
}

/** Runs `fn` at the start of `frame` of the whole video. */
export function cue(frame: number, fn: (c: Cue) => void): void {
  const whole = Math.round(frame);
  onFrame(whole, (ctx, t) => {
    let bus = buses.get(ctx);
    if (!bus) {
      bus = buildBus(ctx, t - whole / FPS);
      buses.set(ctx, bus);
    }
    fn({ ...bus, t });
  });
}

const noiseSource = (c: Bus, t: number, seed: string, dur: number): AudioBufferSourceNode => {
  const src = c.ctx.createBufferSource();
  src.buffer = c.noise;
  src.start(t, random(seed) * (c.noise.duration - dur - 0.1));
  src.stop(t + dur);
  return src;
};

/** The kick: a sine that drops fast, plus a soft beater click. */
export function kick(c: Cue, vel: number, to: AudioNode = c.music): void {
  const o = c.ctx.createOscillator();
  const g = c.ctx.createGain();
  o.frequency.setValueAtTime(150, c.t);
  o.frequency.exponentialRampToValueAtTime(42, c.t + 0.13);
  g.gain.setValueAtTime(vel, c.t);
  g.gain.exponentialRampToValueAtTime(0.001, c.t + 0.42);
  o.connect(g).connect(to);
  o.start(c.t);
  o.stop(c.t + 0.45);
  const n = noiseSource(c, c.t, `kick-${c.t.toFixed(3)}`, 0.02);
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  const ng = c.ctx.createGain();
  ng.gain.setValueAtTime(vel * 0.3, c.t);
  ng.gain.exponentialRampToValueAtTime(0.001, c.t + 0.018);
  n.connect(lp).connect(ng).connect(to);
}

/** A hi-hat: high-passed noise, very short. */
export function hat(c: Cue, vel: number): void {
  const n = noiseSource(c, c.t, `hat-${c.t.toFixed(3)}`, 0.06);
  const hp = c.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel, c.t);
  g.gain.exponentialRampToValueAtTime(0.0005, c.t + 0.045);
  n.connect(hp).connect(g).connect(c.music);
}

/** A bass note: a triangle through a low-pass, short and round. */
export function bass(c: Cue, hz: number, dur: number, vel: number): void {
  const o = c.ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = hz;
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(420, c.t);
  lp.frequency.exponentialRampToValueAtTime(140, c.t + dur);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.exponentialRampToValueAtTime(vel, c.t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0005, c.t + dur);
  o.connect(lp).connect(g).connect(c.music);
  o.start(c.t);
  o.stop(c.t + dur + 0.02);
}

/** A sustained chord: detuned saws under a slow low-pass, with a sine on the low notes; fades in and out. */
export function pad(c: Cue, seconds: number, hzs: number[], level: number, cutoff: [number, number], attack = 1.1, release = 1.4): void {
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(cutoff[0], c.t);
  lp.frequency.linearRampToValueAtTime(cutoff[1], c.t + seconds);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.linearRampToValueAtTime(level, c.t + attack);
  g.gain.setValueAtTime(level, c.t + seconds - release + attack * 0);
  g.gain.linearRampToValueAtTime(0.0001, c.t + seconds + release);
  lp.connect(g).connect(c.music);
  hzs.forEach((hz, i) => {
    const per = level / hzs.length;
    for (const det of [-7, 7]) {
      const o = c.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.detune.value = det + (i % 2 ? 2 : -2);
      const og = c.ctx.createGain();
      og.gain.value = per * 0.5;
      o.connect(og).connect(lp);
      o.start(c.t);
      o.stop(c.t + seconds + release + 0.05);
    }
    if (hz < 120) {
      const s = c.ctx.createOscillator();
      s.frequency.value = hz;
      const sg = c.ctx.createGain();
      sg.gain.value = per * 1.4;
      s.connect(sg).connect(lp);
      s.start(c.t);
      s.stop(c.t + seconds + release + 0.05);
    }
  });
}

/** A UI tick: a short pitched blip. */
export function tick(c: Cue, vel = 0.12, from = 1900, to = 950): void {
  const o = c.ctx.createOscillator();
  const g = c.ctx.createGain();
  o.frequency.setValueAtTime(from, c.t);
  o.frequency.exponentialRampToValueAtTime(to, c.t + 0.05);
  g.gain.setValueAtTime(vel, c.t);
  g.gain.exponentialRampToValueAtTime(0.001, c.t + 0.07);
  o.connect(g).connect(c.sfx);
  o.start(c.t);
  o.stop(c.t + 0.08);
}

/** A camera shutter: a dry click and a low knock. */
export function shutter(c: Cue, vel: number): void {
  const n = noiseSource(c, c.t, `sh-${c.t.toFixed(3)}`, 0.05);
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200;
  bp.Q.value = 0.9;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel, c.t);
  g.gain.exponentialRampToValueAtTime(0.0005, c.t + 0.03);
  n.connect(bp).connect(g).connect(c.sfx);
  const o = c.ctx.createOscillator();
  o.frequency.setValueAtTime(220, c.t);
  o.frequency.exponentialRampToValueAtTime(90, c.t + 0.04);
  const og = c.ctx.createGain();
  og.gain.setValueAtTime(vel * 0.7, c.t);
  og.gain.exponentialRampToValueAtTime(0.0005, c.t + 0.05);
  o.connect(og).connect(c.sfx);
  o.start(c.t);
  o.stop(c.t + 0.06);
}

/** Noise through a band-pass sweeping `from` to `to` Hz while it swells to `peak` at `peakAt` (0 to 1) and fades. */
export function sweep(c: Cue, seconds: number, from: number, to: number, peak: number, peakAt: number, seed: string, q = 1.2): void {
  const n = noiseSource(c, c.t, seed, seconds);
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(from, c.t);
  bp.frequency.exponentialRampToValueAtTime(to, c.t + seconds * 0.9);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.exponentialRampToValueAtTime(peak, c.t + seconds * peakAt);
  g.gain.exponentialRampToValueAtTime(0.0001, c.t + seconds);
  n.connect(bp).connect(g).connect(c.sfx);
}

/** A riser: a sweep plus a rising tone, cut off hard at the end so the hit lands in the gap. */
export function riser(c: Cue, seconds: number, peak: number, tone = true): void {
  sweep(c, seconds, 400, 9000, peak, 0.98, `riser-${c.t.toFixed(3)}`, 0.8);
  if (!tone) return;
  const o = c.ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(110, c.t);
  o.frequency.exponentialRampToValueAtTime(880, c.t + seconds);
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(300, c.t);
  lp.frequency.exponentialRampToValueAtTime(3000, c.t + seconds);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.exponentialRampToValueAtTime(peak * 0.3, c.t + seconds * 0.98);
  g.gain.linearRampToValueAtTime(0, c.t + seconds);
  o.connect(lp).connect(g).connect(c.sfx);
  o.start(c.t);
  o.stop(c.t + seconds + 0.02);
}

/** A low swell of noise under 150 Hz: a rumble. Rises to `peak` at `peakAt`, then falls. */
export function rumble(c: Cue, seconds: number, peak: number, peakAt: number, seed: string): void {
  const n = noiseSource(c, c.t, seed, Math.min(seconds, 2.8));
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 150;
  lp.Q.value = 1.4;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.exponentialRampToValueAtTime(peak, c.t + seconds * peakAt);
  g.gain.exponentialRampToValueAtTime(0.0001, c.t + seconds);
  n.connect(lp).connect(g).connect(c.sfx);
}

/** An impact: a sub drop, a noise crash that closes down, and a low thump. */
export function hit(c: Cue, vel: number, crash = 1): void {
  const o = c.ctx.createOscillator();
  o.frequency.setValueAtTime(95, c.t);
  o.frequency.exponentialRampToValueAtTime(34, c.t + 0.5);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel, c.t);
  g.gain.exponentialRampToValueAtTime(0.001, c.t + 1.7);
  o.connect(g).connect(c.sfx);
  o.start(c.t);
  o.stop(c.t + 1.75);
  const n = noiseSource(c, c.t, `hit-${c.t.toFixed(3)}`, 1.6);
  const lp = c.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(9000, c.t);
  lp.frequency.exponentialRampToValueAtTime(160, c.t + 1.3);
  const ng = c.ctx.createGain();
  ng.gain.setValueAtTime(vel * 0.55 * crash, c.t);
  ng.gain.exponentialRampToValueAtTime(0.0005, c.t + 1.5);
  n.connect(lp).connect(ng).connect(c.sfx);
}

/** A soft two-partial bell. */
export function bell(c: Cue, hz: number, vel: number, seconds = 2.4): void {
  for (const [mult, v] of [[1, 1], [2.76, 0.35], [5.4, 0.12]] as const) {
    const o = c.ctx.createOscillator();
    o.frequency.value = hz * mult;
    const g = c.ctx.createGain();
    g.gain.setValueAtTime(0.0001, c.t);
    g.gain.exponentialRampToValueAtTime(vel * v, c.t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0003, c.t + seconds / mult);
    o.connect(g).connect(c.sfx);
    o.start(c.t);
    o.stop(c.t + seconds / mult + 0.05);
  }
}

/** The scratch of a pen over `seconds`: band-passed noise whose level flutters with the hand. */
export function pen(c: Cue, seconds: number, vel: number, seed: string): void {
  const n = noiseSource(c, c.t, seed, seconds);
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3400;
  bp.Q.value = 0.7;
  const g = c.ctx.createGain();
  const steps = Math.max(8, Math.round(seconds * 60));
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const env = Math.sin((Math.PI * i) / (steps - 1));
    curve[i] = vel * env * (0.35 + 0.65 * random(`${seed}-f${i}`));
  }
  g.gain.setValueCurveAtTime(curve, c.t, seconds);
  n.connect(bp).connect(g).connect(c.sfx);
}

/** A film projector running: noise chopped at the 24 fps gate, band-passed to the clatter, swelling in and out. */
export function projector(c: Cue, seconds: number, vel: number, seed: string): void {
  const n = noiseSource(c, c.t, seed, seconds);
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1700;
  bp.Q.value = 1.1;
  const g = c.ctx.createGain();
  const steps = Math.max(8, Math.round(seconds * 24 * 4));
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const env = Math.sin((Math.PI * i) / (steps - 1));
    const gate = i % 4 === 0 ? 1 : i % 4 === 1 ? 0.35 : 0.08;
    curve[i] = vel * env * gate * (0.7 + 0.3 * random(`${seed}-g${i}`));
  }
  g.gain.setValueCurveAtTime(curve, c.t, seconds);
  n.connect(bp).connect(g).connect(c.sfx);
}

/** A short burst of band-passed noise: the building block of the mechanical sounds below. */
function burst(c: Cue, t: number, seconds: number, hz: number, q: number, vel: number, seed: string, to: AudioNode = c.sfx): void {
  const n = noiseSource(c, t, seed, seconds + 0.01);
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = hz;
  bp.Q.value = q;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + seconds);
  n.connect(bp).connect(g).connect(to);
}

/** A thermal receipt printer running for `seconds`: its stepper's buzz (a narrow pulse train near 900 steps a second,
 *  rung through the plastic housing's resonances), roughened by noise, spinning up and down at the ends, with the
 *  paper's hiss over it. */
export function thermal(c: Cue, seconds: number, vel: number, seed: string): void {
  const end = c.t + seconds;
  const step = c.ctx.createOscillator();
  step.type = 'sawtooth';
  step.frequency.setValueAtTime(320, c.t);
  step.frequency.exponentialRampToValueAtTime(910, c.t + 0.06);
  step.frequency.setValueAtTime(910, end - 0.07);
  step.frequency.exponentialRampToValueAtTime(380, end);
  // a sawtooth through a steep high-pass is a train of clicks, one per step; its level wobbles fast with noise (grit)
  const hp = c.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1400;
  hp.Q.value = 0.7;
  const steps = Math.max(8, Math.round(seconds * 120));
  const grit = new Float32Array(steps);
  for (let i = 0; i < steps; i++) grit[i] = 0.75 + 0.5 * random(`${seed}-g${i}`);
  const wob = c.ctx.createGain();
  wob.gain.setValueCurveAtTime(grit, c.t, seconds);
  const env = c.ctx.createGain();
  env.gain.setValueAtTime(0.0001, c.t);
  env.gain.exponentialRampToValueAtTime(vel, c.t + 0.04);
  env.gain.setValueAtTime(vel, end - 0.05);
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  step.connect(hp).connect(wob).connect(env);
  // the housing: three resonances, the middle one strongest
  for (const [hz, q, lvl] of [[2350, 6, 0.9], [4100, 8, 1.2], [6600, 5, 0.5]] as const) {
    const bp = c.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz;
    bp.Q.value = q;
    const g = c.ctx.createGain();
    g.gain.value = lvl;
    env.connect(bp).connect(g).connect(c.sfx);
  }
  step.start(c.t);
  step.stop(end + 0.02);
  // the paper sliding out over the head
  const n = noiseSource(c, c.t, `${seed}-paper`, seconds);
  const php = c.ctx.createBiquadFilter();
  php.type = 'highpass';
  php.frequency.value = 5200;
  const pg = c.ctx.createGain();
  pg.gain.setValueAtTime(0.0001, c.t);
  pg.gain.exponentialRampToValueAtTime(vel * 0.25, c.t + 0.08);
  pg.gain.setValueAtTime(vel * 0.25, end - 0.05);
  pg.gain.exponentialRampToValueAtTime(0.0001, end);
  n.connect(php).connect(pg).connect(c.sfx);
}

/** The auto-cutter: a sharp click as the blade fires, a duller clack as it returns, and a faint ring of metal. */
export function cutter(c: Cue, vel: number, seed: string): void {
  burst(c, c.t, 0.012, 3600, 1.4, vel, `${seed}-a`);
  burst(c, c.t + 0.004, 0.03, 900, 1.1, vel * 0.6, `${seed}-b`);
  burst(c, c.t + 0.055, 0.025, 1500, 1.2, vel * 0.55, `${seed}-c`);
  const o = c.ctx.createOscillator();
  o.frequency.value = 3170;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel * 0.06, c.t);
  g.gain.exponentialRampToValueAtTime(0.0003, c.t + 0.09);
  o.connect(g).connect(c.sfx);
  o.start(c.t);
  o.stop(c.t + 0.1);
}

/** A slip of paper falling onto a pile: the air past it, then a soft slap and a small thud as it lands `fall`
 *  seconds later. */
export function paperDrop(c: Cue, fall: number, vel: number, seed: string): void {
  sweep(c, Math.max(0.12, fall), 2400, 700, vel * 0.35, 0.8, `${seed}-air`, 0.7);
  const t = c.t + fall;
  burst(c, t, 0.05, 2200, 0.6, vel, `${seed}-slap`);
  burst(c, t + 0.008, 0.11, 700, 0.8, vel * 0.5, `${seed}-body`);
  const o = c.ctx.createOscillator();
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(vel * 0.4, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
  o.connect(g).connect(c.sfx);
  o.start(t);
  o.stop(t + 0.13);
}

/** A quiet room: low, slow noise, for under a still scene. */
export function room(c: Cue, seconds: number, vel: number, seed: string): void {
  rumble(c, seconds, vel, 0.3, seed);
  const n = noiseSource(c, c.t, `${seed}-air`, Math.min(seconds, 2.8));
  const bp = c.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 450;
  bp.Q.value = 0.5;
  const g = c.ctx.createGain();
  g.gain.setValueAtTime(0.0001, c.t);
  g.gain.linearRampToValueAtTime(vel * 0.35, c.t + 0.3);
  g.gain.linearRampToValueAtTime(0.0001, c.t + seconds);
  n.connect(bp).connect(g).connect(c.sfx);
}

/** A soft pop for something landing on screen: a short low thump and a pitched tick. */
export function pop(c: Cue, vel: number, hz = 1300): void {
  kick(c, vel * 0.6, c.sfx);
  tick(c, vel * 0.5, hz, hz * 0.5);
}
