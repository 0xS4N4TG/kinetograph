// The Web Audio graph of a HyperFrames effects chain, and the offline pass that runs a track through it (Apache-2.0,
// heygen-com/hyperframes; packages/core/src/audio/audioFxGraph.ts for the builders, audioFxTail.ts for the tail and the
// latency, stubs/audio-fx-runtime-entry.ts for the pass). HyperFrames' render runs this graph in an OfflineAudioContext in
// Chrome; here it runs in node-web-audio-api's, which implements the same Web Audio nodes, with no browser. Changed from
// the original: built once per pass (no live update, reset or dispose), and an LFO's phase is set from the lane clock.

import { setTimeout as realSetTimeout } from 'node:timers';
import type { AudioNode, AudioParam, BiquadFilterNode, GainNode, OfflineAudioContext } from 'node-web-audio-api';
import { enabledNodes, fxDef, normalizeFxParams, type FxChain, type FxNode, type FxParamValues } from './chain.js';
import { laneMax, scheduleLanes, type Lane, type LaneTiming, type ParamTarget } from './automation.js';
import { truePeakLatencySamples, WORKLET_SOURCE } from './worklets.js';

/** The reverb's impulse, the same on every machine: decaying noise from a seeded generator, one-pole lowpassed, unit energy. */
export function reverbImpulse(sampleRate: number, size: number, damping: number): Float32Array {
  const seconds = 0.6 + Math.max(0, Math.min(1, size)) * 2.6;
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const out = new Float32Array(length);
  let seed = (Math.round(size * 1000) * 2654435761 + Math.round(damping * 1000) * 40503) >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  const cutoff = Math.max(0.001, 1 - Math.max(0, Math.min(1, damping)));
  let lp = 0;
  let energy = 0;
  for (let i = 0; i < length; i++) {
    lp += cutoff * (rand() - lp);
    const sample = lp * Math.pow(1 - i / length, 2.5);
    out[i] = sample;
    energy += sample * sample;
  }
  const norm = Math.sqrt(energy);
  if (norm > 0) for (let i = 0; i < length; i++) out[i] = out[i]! / norm;
  return out;
}

interface Built {
  input: AudioNode;
  output: AudioNode;
  automation?: Record<string, ParamTarget[]>;
}

/** `start` is the context time at which the lane clock reads 0; LFOs have phase 0 there. */
type Builder = (ctx: OfflineAudioContext, p: FxParamValues, start: number) => Built;

const n = (v: number | string | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));
const msToSec = (v: number): number => v / 1000;
const dbToLinear = (db: number): number => Math.pow(10, db / 20);
const mixTargets = (wet: AudioParam, dry: AudioParam): ParamTarget[] => [{ param: wet }, { param: dry, map: (v) => 1 - v }];
const simple = (node: AudioNode, automation?: Record<string, ParamTarget[]>): Built => ({ input: node, output: node, ...(automation ? { automation } : {}) });

/** One cycle of the waveform in a looping one-second buffer, so `playbackRate` is the rate in Hz (audioFxGraph.ts: lfoSource). */
function lfo(ctx: OfflineAudioContext, wave: 'sine' | 'triangle', speed: number, start: number) {
  const length = Math.max(1, Math.round(ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const cycle = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const phase = i / length;
    cycle[i] = wave === 'sine' ? Math.sin(2 * Math.PI * phase) : 4 * Math.abs(((phase + 0.75) % 1) - 0.5) - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = speed;
  // The phase at context time 0 is that of lane time `-start`.
  const offset = ((((-start * speed) % 1) + 1) % 1) * (length / ctx.sampleRate);
  src.start(0, offset);
  return src;
}

const USES_Q = new Set(['peaking', 'highpass', 'lowpass']);

const gainStage: Builder = (ctx, p) => {
  const g = ctx.createGain();
  g.gain.value = dbToLinear(n(p.gain));
  return simple(g, { gain: [{ param: g.gain, map: dbToLinear }] });
};

function biquad(type: 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass', useGain: boolean): Builder {
  return (ctx, p) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = n(p.frequency);
    if (p.q !== undefined) f.Q.value = n(p.q);
    if (useGain) f.gain.value = n(p.gain);
    return simple(f, {
      frequency: [{ param: f.frequency }],
      ...(USES_Q.has(type) ? { q: [{ param: f.Q }] } : {}),
      ...(useGain ? { gain: [{ param: f.gain }] } : {}),
    });
  };
}

/** A one-pole high- or low-pass from raw coefficients (Web Audio's biquad is always two-pole); nothing on it is automatable. */
function onePole(kind: 'highpass' | 'lowpass'): Builder {
  return (ctx, p) => {
    const k = Math.tan((Math.PI * n(p.frequency)) / ctx.sampleRate);
    const node =
      kind === 'highpass'
        ? ctx.createIIRFilter([1 / (1 + k), -1 / (1 + k)], [1, (k - 1) / (k + 1)])
        : ctx.createIIRFilter([k / (1 + k), k / (1 + k)], [1, (k - 1) / (k + 1)]);
    return simple(node);
  };
}

function worklet(processor: string): Builder {
  return (ctx, p, start) => {
    // `__hfElapsed` is the lane time at context time 0: the bitcrush hold and the pitch-shift sweep run from the clip's start.
    const node = new (worklets().AudioWorkletNode)(ctx, processor, { processorOptions: { ...p, __hfElapsed: -start } });
    return simple(node as unknown as AudioNode);
  };
}

/** asoftclip's shapes (audioFxGraph.ts: CURVES). */
const CURVES: Record<string, (x: number) => number> = {
  tanh: Math.tanh,
  atan: (x) => (2 / Math.PI) * Math.atan((Math.PI / 2) * x),
  cubic: (x) => (Math.abs(x) >= 1 ? Math.sign(x) : x - x ** 3 / 3),
  exp: (x) => Math.sign(x) * (1 - Math.exp(-Math.abs(x))),
  alg: (x) => x / Math.sqrt(1 + x * x),
  quintic: (x) => (Math.abs(x) >= 1 ? Math.sign(x) : x - x ** 5 / 5),
  sin: (x) => (Math.abs(x) >= 1 ? Math.sign(x) : Math.sin((Math.PI / 2) * x)),
  erf: (x) => Math.tanh(1.20211 * x),
  hard: (x) => Math.max(-1, Math.min(1, x)),
};

/** 2x or 4x when the saturation oversamples, which runs the `kg-waveshaper` processor (worklets.ts) rather than a WaveShaperNode. */
const oversampling = (p: FxParamValues): number => (n(p.oversample) >= 4 ? 4 : n(p.oversample) >= 2 ? 2 : 1);

const waveshaper: Builder = (ctx, p) => {
  const pre = ctx.createGain();
  const post = ctx.createGain();
  const shape = CURVES[String(p.type)] ?? Math.tanh;
  const threshold = Math.pow(10, n(p.threshold) / 20);
  const SIZE = 8192;
  const curve = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const x = (i / (SIZE - 1)) * 2 - 1;
    curve[i] = shape(x / Math.max(1e-6, threshold)) * threshold;
  }
  const factor = oversampling(p);
  if (factor === 1) {
    const ws = ctx.createWaveShaper();
    ws.curve = curve;
    pre.connect(ws).connect(post);
  } else {
    const ws = new (worklets().AudioWorkletNode)(ctx, 'kg-waveshaper', { processorOptions: { curve, factor } }) as unknown as AudioNode;
    pre.connect(ws).connect(post);
  }
  post.gain.value = dbToLinear(n(p.output));
  return { input: pre, output: post, automation: { output: [{ param: post.gain, map: dbToLinear }] } };
};

function wetDry(ctx: OfflineAudioContext): { input: GainNode; out: GainNode; wet: GainNode; dry: GainNode } {
  return { input: ctx.createGain(), out: ctx.createGain(), wet: ctx.createGain(), dry: ctx.createGain() };
}

const delayFeedback: Builder = (ctx, p) => {
  const { input, out, wet, dry } = wetDry(ctx);
  // HyperFrames' graph is one DelayNode with its output fed back through a gain. Chrome reads a DelayNode in a cycle a
  // render quantum late and does not hold its time to a quantum, so the first repeat comes at the delay time and each
  // later one 128 frames after that (measured against HyperFrames' render, 2 ms to 180 ms). node-web-audio-api holds a
  // delay in a cycle to at least a quantum and adds none, so the same echoes are built as a delay for the first repeat
  // and a delay of the time plus 128 frames in the loop: echoes = delay(input) + feedback * loop(echoes).
  const quantum = 128 / ctx.sampleRate;
  const dl = ctx.createDelay(5);
  const loop = ctx.createDelay(5 + quantum);
  const echoes = ctx.createGain();
  const fb = ctx.createGain();
  input.connect(dl).connect(echoes);
  echoes.connect(fb).connect(loop).connect(echoes);
  echoes.connect(wet).connect(out);
  input.connect(dry).connect(out);
  dl.delayTime.value = Math.min(5, n(p.time) / 1000);
  loop.delayTime.value = Math.min(5, n(p.time) / 1000) + quantum;
  fb.gain.value = n(p.feedback);
  wet.gain.value = n(p.mix);
  dry.gain.value = 1 - n(p.mix);
  return {
    input,
    output: out,
    automation: {
      time: [
        { param: dl.delayTime, map: (v) => Math.min(5, msToSec(v)) },
        { param: loop.delayTime, map: (v) => Math.min(5, msToSec(v)) + quantum },
      ],
      feedback: [{ param: fb.gain }],
      mix: mixTargets(wet.gain, dry.gain),
    },
  };
};

const chorus: Builder = (ctx, p, start) => {
  const { input, out, wet, dry } = wetDry(ctx);
  const dl = ctx.createDelay(0.5);
  const mod = lfo(ctx, 'sine', n(p.speed), start);
  const depth = ctx.createGain();
  mod.connect(depth).connect(dl.delayTime);
  input.connect(dl).connect(wet).connect(out);
  input.connect(dry).connect(out);
  dl.delayTime.value = n(p.delay) / 1000;
  depth.gain.value = n(p.depth) / 1000;
  wet.gain.value = n(p.mix);
  dry.gain.value = 1 - n(p.mix);
  return {
    input,
    output: out,
    automation: {
      delay: [{ param: dl.delayTime, map: msToSec }],
      depth: [{ param: depth.gain, map: msToSec }],
      speed: [{ param: mod.playbackRate }],
      mix: mixTargets(wet.gain, dry.gain),
    },
  };
};

const phaser: Builder = (ctx, p, start) => {
  const { input, out, wet, dry } = wetDry(ctx);
  const inTrim = ctx.createGain();
  const outTrim = ctx.createGain();
  const mod = lfo(ctx, String(p.type) === '1' ? 'sine' : 'triangle', n(p.speed), start);
  const depth = ctx.createGain();
  input.connect(inTrim);
  let node: AudioNode = inTrim;
  const centre = 1000 / Math.max(0.1, n(p.delay));
  for (let i = 0; i < 6; i++) {
    const ap: BiquadFilterNode = ctx.createBiquadFilter();
    ap.type = 'allpass';
    ap.Q.value = 0.7071;
    ap.frequency.value = centre;
    depth.connect(ap.frequency);
    node.connect(ap);
    node = ap;
  }
  mod.connect(depth);
  node.connect(wet).connect(outTrim);
  inTrim.connect(dry).connect(outTrim);
  outTrim.connect(out);
  depth.gain.value = centre * n(p.decay);
  inTrim.gain.value = n(p.in_gain);
  outTrim.gain.value = n(p.out_gain);
  wet.gain.value = 1;
  dry.gain.value = 1;
  return {
    input,
    output: out,
    automation: { speed: [{ param: mod.playbackRate }], in_gain: [{ param: inTrim.gain }], out_gain: [{ param: outTrim.gain }] },
  };
};

const convolver: Builder = (ctx, p) => {
  const { input, out, wet, dry } = wetDry(ctx);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  const ir = reverbImpulse(ctx.sampleRate, n(p.size), n(p.damping));
  const buffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
  buffer.getChannelData(0).set(ir);
  conv.buffer = buffer;
  input.connect(conv).connect(wet).connect(out);
  input.connect(dry).connect(out);
  wet.gain.value = n(p.wet);
  dry.gain.value = n(p.dry);
  return { input, output: out, automation: { wet: [{ param: wet.gain }], dry: [{ param: dry.gain }] } };
};

const BUILDERS: Record<string, Builder> = {
  'gain-node': gainStage,
  'biquad-peaking': biquad('peaking', true),
  'biquad-lowshelf': biquad('lowshelf', true),
  'biquad-highshelf': biquad('highshelf', true),
  'biquad-highpass': biquad('highpass', false),
  'biquad-lowpass': biquad('lowpass', false),
  'worklet-compressor': worklet('hf-compressor'),
  'worklet-limiter': worklet('hf-limiter'),
  'worklet-truepeak': worklet('hf-truepeak'),
  'worklet-gate': worklet('hf-gate'),
  'worklet-bitcrush': worklet('hf-bitcrush'),
  'worklet-pitchshift': worklet('hf-pitchshift'),
  waveshaper,
  'delay-feedback': delayFeedback,
  'chorus-lfo': chorus,
  'allpass-phaser': phaser,
  convolver,
};

function buildNode(ctx: OfflineAudioContext, node: FxNode, start: number): Built {
  const def = fxDef(node.type)!;
  const p = normalizeFxParams(node.type, node.params);
  if ((node.type === 'highpass' || node.type === 'lowpass') && String(p.poles) === '1') return onePole(node.type)(ctx, p, start);
  return BUILDERS[def.web]!(ctx, p, start);
}

/**
 * The chain in series. A preset's consecutive nodes are wrapped in a wet/dry blend set by its `presetAmount`, which an
 * `fx.preset.<id>` lane drives (audioFxGraph.ts: buildFxChain, presetRuns).
 */
function buildChain(ctx: OfflineAudioContext, chain: FxChain, start: number) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodes: { id?: string; automation?: Record<string, ParamTarget[]> }[] = [];
  const presets: Record<string, ParamTarget[]> = {};
  const runs: { preset?: string; amount: number; nodes: FxNode[] }[] = [];
  for (const node of enabledNodes(chain)) {
    const last = runs[runs.length - 1];
    if (last && last.preset === node.fromPreset) last.nodes.push(node);
    else runs.push({ ...(node.fromPreset ? { preset: node.fromPreset } : {}), amount: node.presetAmount ?? 1, nodes: [node] });
  }
  let tail: AudioNode = input;
  for (const run of runs) {
    let wrap: { wet: GainNode; join: GainNode } | null = null;
    if (run.preset) {
      const entry = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const join = ctx.createGain();
      wet.gain.value = run.amount;
      dry.gain.value = 1 - run.amount;
      tail.connect(entry);
      entry.connect(dry).connect(join);
      (presets[run.preset] ??= []).push(...mixTargets(wet.gain, dry.gain));
      wrap = { wet, join };
      tail = entry;
    }
    for (const node of run.nodes) {
      const built = buildNode(ctx, node, start);
      tail.connect(built.input);
      tail = built.output;
      nodes.push({ ...(node.id ? { id: node.id } : {}), ...(built.automation ? { automation: built.automation } : {}) });
    }
    if (wrap) {
      tail.connect(wrap.wet).connect(wrap.join);
      tail = wrap.join;
    }
  }
  tail.connect(output);
  return { input, output, nodes, presets };
}

// ---- tail and latency (audioFxTail.ts) ----

/** The longest an effect tail is let through after its clip, in seconds. */
export const MAX_TAIL_SECONDS = 5;

/** How long the chain rings after its input stops: reverb, delay, chorus and pitch shift tails summed, at most 5 s. */
export function chainTailSeconds(chain: FxChain, lanes: readonly Lane[]): number {
  const knob = (node: FxNode, key: string): number => {
    const own = Number(normalizeFxParams(node.type, node.params)[key] ?? 0);
    const lane = node.id ? laneMax(lanes, `fx.${node.id}.${key}`) : null;
    return lane ?? (Number.isFinite(own) ? own : 0);
  };
  let total = 0;
  for (const node of chain.nodes) {
    if (!node.enabled) continue;
    if (node.type === 'reverb') total += knob(node, 'wet') > 0 ? 0.6 + Math.max(0, Math.min(1, knob(node, 'size'))) * 2.6 : 0;
    else if (node.type === 'delay' && knob(node, 'mix') > 0) {
      const gap = Math.min(5, knob(node, 'time') / 1000);
      const fb = Math.max(0, Math.min(0.999, knob(node, 'feedback')));
      total += gap <= 0 ? 0 : fb <= 0 ? gap : Math.ceil(Math.log(0.001) / Math.log(fb)) * gap;
    } else if (node.type === 'chorus') total += knob(node, 'mix') > 0 ? knob(node, 'delay') / 1000 : 0;
    else if (node.type === 'pitchshift') total += knob(node, 'mix') > 0 ? 0.2 : 0;
  }
  return Math.min(MAX_TAIL_SECONDS, total);
}

/** Samples the lookahead limiters delay the chain by; the pass trims them so the track stays aligned with its source. */
export function chainLatencySamples(chain: FxChain, sampleRate: number): number {
  return enabledNodes(chain)
    .filter((node) => node.type === 'truepeak')
    .reduce((sum, node) => sum + truePeakLatencySamples(Number(normalizeFxParams(node.type, node.params).lookahead), sampleRate), 0);
}

// ---- the pass ----

type WebAudio = typeof import('node-web-audio-api');
let webAudio: WebAudio | undefined;
const worklets = (): WebAudio => webAudio!;
let workletUrl: string | undefined;

/**
 * node-web-audio-api waits for a worklet's processors with the global `setTimeout`, which a render replaces with the
 * frame clock's (packages/core/src/determinism.ts) and which then never fires. While any pass is rendering, the global
 * is the real one; the first pass in puts it there and the last one out puts back what it found, however the passes
 * overlap.
 */
let realTimerUsers = 0;
let replacedTimer: typeof setTimeout | undefined;

function useRealTimer(): () => void {
  const g = globalThis as { setTimeout: typeof setTimeout };
  if (realTimerUsers++ === 0) {
    replacedTimer = g.setTimeout;
    g.setTimeout = realSetTimeout;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--realTimerUsers === 0) {
      g.setTimeout = replacedTimer!;
      replacedTimer = undefined;
    }
  };
}

/**
 * Runs `planes` (one per channel, equal lengths) through `chain` with its effect `lanes`, in an OfflineAudioContext of
 * their length. `timing` places the lane clock: at context time `scheduledAt` the lanes are at `elapsed` seconds. The
 * output has the input's length and channels; a true-peak limiter's delay is trimmed (stubs/audio-fx-runtime-entry.ts).
 * The pass takes `planes`: once they are in the context the array is emptied, so a long mix holds no second copy.
 */
export async function runFxChain(
  planes: Float32Array[],
  sampleRate: number,
  chain: FxChain,
  lanes: readonly Lane[],
  timing: LaneTiming,
): Promise<Float32Array[]> {
  const frames = planes[0]?.length ?? 0;
  if (frames === 0 || enabledNodes(chain).length === 0) return planes;
  webAudio ??= await import('node-web-audio-api');
  const latency = chainLatencySamples(chain, sampleRate);
  const total = frames + latency;
  const ctx = new webAudio.OfflineAudioContext(planes.length, total, sampleRate);
  const needsWorklets = (node: FxNode): boolean =>
    fxDef(node.type)!.web.startsWith('worklet-') || (node.type === 'saturate' && oversampling(normalizeFxParams(node.type, node.params)) > 1);
  if (enabledNodes(chain).some(needsWorklets)) {
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
  }
  const buffer = ctx.createBuffer(planes.length, total, sampleRate);
  const channels = planes.length;
  planes.forEach((plane, c) => buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, c));
  planes.length = 0;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // The LFOs and the worklets' own clocks: lane time 0 is at context time `scheduledAt - elapsed`.
  const fx = buildChain(ctx, chain, timing.scheduledAt - timing.elapsed);
  scheduleLanes(lanes, chain, fx.nodes, fx.presets, timing);
  source.connect(fx.input);
  fx.output.connect(ctx.destination);
  source.start(0);
  const release = useRealTimer();
  let rendered: Awaited<ReturnType<typeof ctx.startRendering>>;
  try {
    rendered = await ctx.startRendering();
  } finally {
    release();
  }
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const data = rendered.getChannelData(c);
    out.push(latency === 0 ? data : data.subarray(latency, latency + frames));
  }
  return out;
}
