// The AudioWorklet processors of HyperFrames' audio effects: compressor, limiter, gate, bitcrush, pitch shift and the
// true-peak limiter (Apache-2.0, heygen-com/hyperframes; packages/core/src/audio/audioFxWorklets.ts and
// audioFxTruePeak.ts). They run on node-web-audio-api's AudioWorklet in the offline context, the way HyperFrames' render
// runs them in Chrome's. Changed from the original: no live-edit or dispose messages (an offline render builds each node
// once), and the source is registered from a Blob URL.

const TP_OS = 4;
/** Group delay of the true-peak interpolator, in input samples. */
const TP_DELAY = 16;

/** Samples between a sample entering the true-peak limiter and leaving it (audioFxTruePeak.ts: truePeakLatencySamples). */
export function truePeakLatencySamples(lookaheadMs: number, sampleRate: number): number {
  return Math.max(1, Math.round((lookaheadMs * sampleRate) / 1000)) + TP_DELAY;
}

export const WORKLET_SOURCE = `
const dbToLin = (db) => Math.pow(10, db / 20);
const LN10_OVER_20 = Math.LN10 / 20;
const dbToLinFast = (db) => Math.exp(db * LN10_OVER_20);

class EnvBank {
  constructor(attackMs, releaseMs) {
    this.a = Math.exp(-1 / (sampleRate * Math.max(1e-5, attackMs / 1000)));
    this.r = Math.exp(-1 / (sampleRate * Math.max(1e-5, releaseMs / 1000)));
    this.values = [];
  }
  push(ch, x) {
    const prev = this.values[ch] ?? 0;
    const m = Math.abs(x);
    const c = m > prev ? this.a : this.r;
    const next = m + c * (prev - m);
    this.values[ch] = next;
    return next;
  }
}

function kneeGain(envDb, thresholdDb, ratio, kneeDb) {
  const over = envDb - thresholdDb;
  if (kneeDb > 0 && over > -kneeDb && over < kneeDb) {
    const t = (over + kneeDb) / (2 * kneeDb);
    return -((1 - 1 / ratio) * kneeDb * t * t);
  }
  return over > 0 ? -(over * (1 - 1 / ratio)) : 0;
}

class HfCompressor extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.env = new EnvBank(this.p.attack ?? 20, this.p.release ?? 250);
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const p = this.p;
    const makeup = dbToLin(p.makeup ?? 0);
    const mix = p.mix ?? 1;
    const kneeDb = 20 * Math.log10(Math.max(1.0001, p.knee ?? 2.83));
    const thresholdDb = p.threshold ?? -24;
    const ratio = p.ratio ?? 4;
    const kneeStartLin = dbToLin(thresholdDb - kneeDb);
    const dry = 1 - mix;
    for (let ch = 0; ch < i.length; ch++) {
      const inp = i[ch], out = o[ch];
      for (let n = 0; n < inp.length; n++) {
        const x = inp[n];
        const env = this.env.push(ch, x);
        if (env <= kneeStartLin) {
          out[n] = x * makeup * mix + x * dry;
          continue;
        }
        const g = dbToLinFast(kneeGain(20 * Math.log10(env), thresholdDb, ratio, kneeDb));
        out[n] = x * g * makeup * mix + x * dry;
      }
    }
    return true;
  }
}
registerProcessor("hf-compressor", HfCompressor);

class HfLimiter extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.env = new EnvBank(this.p.attack ?? 5, this.p.release ?? 50);
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const ceiling = dbToLin(this.p.limit ?? -1);
    const outGain = dbToLin(this.p.level_out ?? 0);
    for (let ch = 0; ch < i.length; ch++) {
      const inp = i[ch], out = o[ch];
      for (let n = 0; n < inp.length; n++) {
        const x = inp[n];
        const env = this.env.push(ch, x);
        out[n] = x * (env > ceiling ? ceiling / env : 1) * outGain;
      }
    }
    return true;
  }
}
registerProcessor("hf-limiter", HfLimiter);

class HfGate extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.env = new EnvBank(this.p.attack ?? 1, this.p.release ?? 100);
    this.gains = [];
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const p = this.p;
    const threshold = dbToLin(p.threshold ?? -35);
    const floor = dbToLin(p.range ?? -24);
    const ratio = p.ratio ?? 10;
    for (let ch = 0; ch < i.length; ch++) {
      const inp = i[ch], out = o[ch];
      for (let n = 0; n < inp.length; n++) {
        const x = inp[n];
        const env = this.env.push(ch, x);
        let target = 1;
        if (env < threshold) {
          const under = env > 1e-9 ? threshold / env : 1e9;
          target = Math.max(floor, 1 / Math.pow(under, ratio - 1));
          if (!isFinite(target)) target = floor;
        }
        const held = this.gains[ch] ?? 1;
        const c = target < held ? this.env.r : this.env.a;
        const smoothed = target + c * (held - target);
        this.gains[ch] = smoothed;
        out[n] = x * smoothed;
      }
    }
    return true;
  }
}
registerProcessor("hf-gate", HfGate);

class HfBitcrush extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.holds = [];
    this.held = [];
    this.start = Math.round((this.p.__hfElapsed ?? 0) * sampleRate);
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const p = this.p;
    const levels = Math.pow(2, (p.bits ?? 8) - 1);
    const step = Math.max(1, Math.round(p.samples ?? 1));
    const mix = p.mix ?? 1;
    for (let ch = 0; ch < i.length; ch++) {
      const inp = i[ch], out = o[ch];
      if (this.held[ch] === undefined) this.held[ch] = Math.round(inp[0] * levels) / levels;
      if (this.holds[ch] === undefined) this.holds[ch] = this.start % step;
      for (let n = 0; n < inp.length; n++) {
        if (this.holds[ch] === 0) this.held[ch] = Math.round(inp[n] * levels) / levels;
        out[n] = this.held[ch] * mix + inp[n] * (1 - mix);
        this.holds[ch] = (this.holds[ch] + 1) % step;
      }
    }
    return true;
  }
}
registerProcessor("hf-bitcrush", HfBitcrush);

function readTap(ring, write, delaySamples) {
  const len = ring.length;
  const pos = (write - 1 - delaySamples + len) % len;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  return ring[i0] * (1 - frac) + ring[(i0 + 1) % len] * frac;
}

class HfPitchshift extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.grain = Math.round(sampleRate * 0.1);
    this.buf = [];
    this.write = 0;
    const ratio0 = Math.pow(2, Math.max(-12, Math.min(12, this.p.semitones ?? 0)) / 12);
    const turns = (this.p.__hfElapsed ?? 0) * sampleRate * ((1 - ratio0) / this.grain);
    this.phase = turns - Math.floor(turns);
    this.filled = 0;
    this.wet = 0;
    this.wetTarget = 0;
    this.wetCoef = Math.exp(-1 / (sampleRate * 0.015));
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const p = this.p;
    const semitones = Math.max(-12, Math.min(12, p.semitones ?? 0));
    const mix = Math.max(0, Math.min(1, p.mix ?? 1));
    const grain = this.grain;
    const ringLen = grain * 2;
    const n = i[0] ? i[0].length : 0;
    for (let ch = 0; ch < i.length; ch++) if (!this.buf[ch]) this.buf[ch] = new Float32Array(ringLen);
    this.wetTarget = semitones === 0 ? 0 : mix;
    if (this.wetTarget === 0 && this.wet < 1e-4) {
      this.wet = 0;
      let w = this.write;
      for (let s = 0; s < n; s++) {
        for (let ch = 0; ch < i.length; ch++) {
          const x = i[ch][s];
          this.buf[ch][w] = x;
          o[ch][s] = x;
        }
        w = (w + 1) % ringLen;
      }
      this.write = w;
      this.filled = Math.min(grain, this.filled + n);
      return true;
    }
    const inc = (1 - Math.pow(2, semitones / 12)) / grain;
    let write = this.write, phase = this.phase, filled = this.filled, wetNow = this.wet;
    const target = this.wetTarget, coef = this.wetCoef;
    for (let s = 0; s < n; s++) {
      phase += inc;
      phase -= Math.floor(phase);
      const phaseB = (phase + 0.5) % 1;
      const gA = Math.sin(Math.PI * phase), gB = Math.sin(Math.PI * phaseB);
      const warm = filled >= grain ? 1 : filled / grain;
      wetNow = target + coef * (wetNow - target);
      const wetMix = wetNow * warm;
      for (let ch = 0; ch < i.length; ch++) {
        const ring = this.buf[ch];
        const x = i[ch][s];
        ring[write] = x;
        const wet = readTap(ring, write, phase * grain) * gA + readTap(ring, write, phaseB * grain) * gB;
        o[ch][s] = x * (1 - wetMix) + wet * wetMix;
      }
      write = (write + 1) % ringLen;
      if (filled < grain) filled++;
    }
    this.write = write;
    this.phase = phase;
    this.filled = filled;
    this.wet = wetNow;
    return true;
  }
}
registerProcessor("hf-pitchshift", HfPitchshift);

const TP_OS = ${TP_OS};
const TP_DELAY = ${TP_DELAY};
const TP_HALF = TP_OS * TP_DELAY;
const TP_BRANCH = 2 * TP_DELAY + 1;

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
}

function tpBranches() {
  const beta = 6;
  const norm = besselI0(beta);
  const branches = [];
  for (let p = 0; p < TP_OS; p++) {
    const taps = new Float64Array(TP_BRANCH);
    let sum = 0;
    for (let j = 0; j < TP_BRANCH; j++) {
      const k = p + TP_OS * j;
      if (k > 2 * TP_HALF) continue;
      const t = (k - TP_HALF) / TP_OS;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = (k - TP_HALF) / TP_HALF;
      taps[j] = sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm);
      sum += taps[j];
    }
    for (let j = 0; j < TP_BRANCH; j++) taps[j] /= sum;
    branches.push(taps);
  }
  return branches;
}

class HfTruePeak extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = o.processorOptions || {};
    this.look = Math.max(1, Math.round((this.p.lookahead ?? 3) * sampleRate / 1000));
    this.delayLen = this.look + TP_DELAY;
    this.branches = tpBranches();
    this.ceiling = Math.pow(10, (this.p.ceiling ?? -1) / 20);
    this.relCoef = 1 - Math.exp(-1 / (sampleRate * Math.max(1e-4, (this.p.release ?? 80) / 1000)));
    this.ch = [];
    this.rel = 1;
    this.dqIdx = new Int32Array(this.look + 2);
    this.dqVal = new Float64Array(this.look + 2);
    this.dqHead = 0;
    this.dqTail = 0;
    this.t = 0;
    this.avgRing = new Float64Array(this.look + 1).fill(1);
    this.avgPos = 0;
    this.avgSum = this.look + 1;
  }
  channel(c) {
    if (!this.ch[c]) this.ch[c] = { delay: new Float32Array(this.delayLen), w: 0, hist: new Float32Array(TP_BRANCH * 2), pos: 0 };
    return this.ch[c];
  }
  peak(chans, inputs, n) {
    let peak = 0;
    for (let c = 0; c < chans; c++) {
      const s = this.channel(c);
      const x = inputs[c][n];
      s.pos = (s.pos + 1) % TP_BRANCH;
      s.hist[s.pos] = x;
      s.hist[s.pos + TP_BRANCH] = x;
      const base = s.pos + TP_BRANCH;
      for (let p = 0; p < TP_OS; p++) {
        const taps = this.branches[p];
        let acc = 0;
        for (let j = 0; j < TP_BRANCH; j++) acc += taps[j] * s.hist[base - j];
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }
  windowMin(v) {
    const cap = this.dqIdx.length;
    while (this.dqTail !== this.dqHead && this.dqVal[(this.dqTail + cap - 1) % cap] >= v) this.dqTail = (this.dqTail + cap - 1) % cap;
    this.dqIdx[this.dqTail] = this.t;
    this.dqVal[this.dqTail] = v;
    this.dqTail = (this.dqTail + 1) % cap;
    while (this.dqIdx[this.dqHead] <= this.t - (this.look + 1)) this.dqHead = (this.dqHead + 1) % cap;
    this.t++;
    return this.dqVal[this.dqHead];
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const chans = i.length;
    const frames = i[0].length;
    for (let n = 0; n < frames; n++) {
      const peak = this.peak(chans, i, n);
      const m = this.windowMin(peak > this.ceiling ? this.ceiling / peak : 1);
      this.avgSum += m - this.avgRing[this.avgPos];
      this.avgRing[this.avgPos] = m;
      this.avgPos = (this.avgPos + 1) % this.avgRing.length;
      const target = Math.min(1, this.avgSum / this.avgRing.length);
      const released = this.rel + (1 - this.rel) * this.relCoef;
      this.rel = released < target ? released : target;
      if (target >= 1 && this.rel > 0.9999999) this.rel = 1;
      for (let c = 0; c < chans; c++) {
        const s = this.channel(c);
        o[c][n] = s.delay[s.w] * this.rel;
        s.delay[s.w] = i[c][n];
        s.w = (s.w + 1) % this.delayLen;
      }
    }
    return true;
  }
}
registerProcessor("hf-truepeak", HfTruePeak);

// Not HyperFrames': a WaveShaperNode with 2x or 4x oversampling as Chrome builds one, which is what HyperFrames' render
// runs its saturation through. node-web-audio-api's resampler differs (4x: 128 frames of latency against Chrome's 192),
// so the oversampled shaper is this processor. Chrome's stages, reimplemented from their behaviour: a 2x up-sampler
// that passes the input through, delayed by 64 frames, and interpolates the frames between with a 128-tap
// Blackman-windowed sinc; a 2x down-sampler that is a 256-tap Blackman-windowed half-band sinc; 4x is two of each.
// The curve is read as the Web Audio spec says (linear between its points, held at both ends).
const blackman = (x) => 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
const UP_KERNEL = (() => {
  const k = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    const s = Math.PI * (i - 64 + 0.5);
    k[i] = (s === 0 ? 1 : Math.sin(s) / s) * blackman((i + 0.5) / 128);
  }
  return k;
})();
const DOWN_KERNEL = (() => {
  const k = new Float32Array(128);
  for (let i = 1; i < 256; i += 2) {
    const s = 0.5 * Math.PI * (i - 128);
    k[(i - 1) / 2] = 0.5 * (s === 0 ? 1 : Math.sin(s) / s) * blackman(i / 256);
  }
  return k;
})();

/** x[n] in, x[n - 64] and the frame half way to x[n + 1] (64 frames late) out. */
class UpSampler {
  constructor() { this.ring = new Float32Array(128); this.pos = 0; }
  push(x, out, o) {
    const ring = this.ring;
    this.pos = (this.pos + 127) & 127;
    ring[this.pos] = x;
    let sum = 0;
    for (let j = 0; j < 128; j++) sum += UP_KERNEL[j] * ring[(this.pos + j) & 127];
    out[o] = ring[(this.pos + 64) & 127];
    out[o + 1] = sum;
  }
}

/** y[2n] and y[2n + 1] in, one frame out: the half-band filter over the odd frames before, plus half of y[2n - 128]. */
class DownSampler {
  constructor() { this.odd = new Float32Array(128); this.oddPos = 0; this.all = new Float32Array(256); this.allPos = 0; }
  push(a, b) {
    const odd = this.odd, all = this.all;
    let sum = 0;
    for (let r = 0; r < 128; r++) sum += DOWN_KERNEL[r] * odd[(this.oddPos + r) & 127];
    // all[allPos] is y[2n - 1]; y[2n - 128] is 127 frames before it.
    sum += 0.5 * all[(this.allPos + 127) & 255];
    this.allPos = (this.allPos + 255) & 255;
    all[this.allPos] = a;
    this.allPos = (this.allPos + 255) & 255;
    all[this.allPos] = b;
    this.oddPos = (this.oddPos + 127) & 127;
    odd[this.oddPos] = b;
    return sum;
  }
}

class KgWaveShaper extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.curve = o.processorOptions.curve;
    this.factor = o.processorOptions.factor;
    this.ch = [];
  }
  shape(x) {
    const curve = this.curve, last = curve.length - 1;
    const v = 0.5 * (x + 1) * last;
    if (v < 0) return curve[0];
    if (v >= last) return curve[last];
    const i = Math.floor(v), f = v - i;
    return (1 - f) * curve[i] + f * curve[i + 1];
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i.length) return true;
    const two = new Float32Array(2), four = new Float32Array(4);
    for (let c = 0; c < i.length; c++) {
      const s = this.ch[c] ??= { up: new UpSampler(), up2: new UpSampler(), down: new DownSampler(), down2: new DownSampler() };
      const inp = i[c], out = o[c];
      for (let n = 0; n < inp.length; n++) {
        s.up.push(inp[n], two, 0);
        if (this.factor === 4) {
          s.up2.push(two[0], four, 0);
          s.up2.push(two[1], four, 2);
          for (let k = 0; k < 4; k++) four[k] = this.shape(four[k]);
          two[0] = s.down2.push(four[0], four[1]);
          two[1] = s.down2.push(four[2], four[3]);
        } else {
          two[0] = this.shape(two[0]);
          two[1] = this.shape(two[1]);
        }
        out[n] = s.down.push(two[0], two[1]);
      }
    }
    return true;
  }
}
registerProcessor("kg-waveshaper", KgWaveShaper);
`;
