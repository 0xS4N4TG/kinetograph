import type { AudioPcm } from './render.js';

export interface AudioAnalysis {
  /** ITU-R BS.1770-4 integrated loudness, LUFS. `-Infinity` (`null` in JSON) if nothing passes the gates. */
  integratedLufs: number;
  /** Highest 4x-oversampled peak of any channel, dBTP. `-Infinity` for digital silence. */
  truePeakDb: number;
  /** Samples at or above 0.9999 in magnitude (full scale, with room for 16-bit's 32767/32768). */
  clippedSamples: number;
  /** Seconds, below -60 dBFS for at least 0.5 s. */
  silences: { start: number; end: number }[];
  scenes?: { from: number; to: number; integratedLufs: number; truePeakDb: number }[];
}

const SILENCE_LEVEL = 0.001; // -60 dBFS
const SILENCE_SECONDS = 0.5;
const CLIP_LEVEL = 0.9999;

/**
 * Loudness, true peak, clipping and silences of `pcm`. `scenes` are `[from, to]` pairs in seconds, each measured on
 * its own slice of the signal.
 */
export function analyzeAudio(pcm: AudioPcm, options?: { scenes?: [number, number][] }): AudioAnalysis {
  const analysis: AudioAnalysis = {
    integratedLufs: integratedLoudness(pcm.channels, pcm.sampleRate),
    truePeakDb: truePeakDb(pcm.channels),
    clippedSamples: countClipped(pcm.channels),
    silences: findSilences(pcm),
  };
  if (options?.scenes) {
    analysis.scenes = options.scenes.map(([from, to]) => {
      const a = Math.max(0, Math.round(from * pcm.sampleRate));
      const b = Math.max(a, Math.round(to * pcm.sampleRate));
      const slice = pcm.channels.map((channel) => channel.subarray(a, b));
      return {
        from,
        to,
        integratedLufs: integratedLoudness(slice, pcm.sampleRate),
        truePeakDb: truePeakDb(slice),
      };
    });
  }
  return analysis;
}

// ---- loudness (ITU-R BS.1770-4) ----

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages, derived for any sample rate from their analogue prototypes (the standard lists the
 * coefficients only for 48 kHz; at 48 kHz this gives those).
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: the head-related high shelf.
  const g = 3.999843853973347;
  const q1 = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const vh = 10 ** (g / 20);
  const vb = vh ** 0.4996667741545416;
  const a01 = 1 + k1 / q1 + k1 * k1;
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / q1 + k1 * k1) / a01,
    b1: (2 * (k1 * k1 - vh)) / a01,
    b2: (vh - (vb * k1) / q1 + k1 * k1) / a01,
    a1: (2 * (k1 * k1 - 1)) / a01,
    a2: (1 - k1 / q1 + k1 * k1) / a01,
  };
  // Stage 2: the RLB high-pass at about 38 Hz.
  const q2 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const a02 = 1 + k2 / q2 + k2 * k2;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / a02,
    a2: (1 - k2 / q2 + k2 * k2) / a02,
  };
  return [shelf, highPass];
}

/** BS.1770 channel weights: L, R and C 1.0, the surrounds 1.41, the LFE of a 5.1 layout not counted. */
function channelWeights(count: number): number[] {
  if (count === 4) return [1, 1, 1.41, 1.41];
  if (count === 5) return [1, 1, 1, 1.41, 1.41];
  if (count === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return new Array<number>(count).fill(1);
}

/**
 * Integrated loudness: mean square of the K-weighted signal in 400 ms blocks every 100 ms, an absolute gate at
 * -70 LUFS, then a relative gate 10 LU below the mean of what passed. A signal shorter than one block is measured as
 * one block, so a short effect still reads.
 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return -Infinity;
  const hop = Math.max(1, Math.round(0.1 * sampleRate));
  const hops = Math.floor(length / hop);
  const weights = channelWeights(channels.length);
  const [shelf, highPass] = kWeighting(sampleRate);

  // Sum of squares of the K-weighted signal per 100 ms hop (and the remainder past the last full hop), per channel.
  const hopSums: Float64Array[] = [];
  for (const channel of channels) {
    const sums = new Float64Array(hops + 1);
    let s1 = 0, s2 = 0, h1 = 0, h2 = 0; // x[n-1], x[n-2] of the shelf; of the high-pass
    let y1 = 0, y2 = 0, z1 = 0, z2 = 0; // y[n-1], y[n-2] of the shelf; of the high-pass
    for (let i = 0; i < length; i++) {
      const x = channel[i]!;
      const y = shelf.b0 * x + shelf.b1 * s1 + shelf.b2 * s2 - shelf.a1 * y1 - shelf.a2 * y2;
      s2 = s1;
      s1 = x;
      y2 = y1;
      y1 = y;
      const z = highPass.b0 * y + highPass.b1 * h1 + highPass.b2 * h2 - highPass.a1 * z1 - highPass.a2 * z2;
      h2 = h1;
      h1 = y;
      z2 = z1;
      z1 = z;
      sums[Math.min(Math.floor(i / hop), hops)]! += z * z;
    }
    hopSums.push(sums);
  }

  const energy = (from: number, hopCount: number, samples: number): number => {
    let total = 0;
    for (let c = 0; c < channels.length; c++) {
      let sum = 0;
      for (let h = from; h < from + hopCount; h++) sum += hopSums[c]![h]!;
      total += weights[c]! * (sum / samples);
    }
    return total;
  };

  const blocks: number[] = []; // mean square per block, weighted and summed over channels
  if (hops >= 4) {
    for (let j = 0; j + 4 <= hops; j++) blocks.push(energy(j, 4, 4 * hop));
  } else {
    // Shorter than 400 ms: the whole signal, remainder included, is the one block.
    blocks.push(energy(0, hops + 1, length));
  }

  const toLufs = (z: number): number => -0.691 + 10 * Math.log10(z);
  const aboveAbsolute = blocks.filter((z) => z > 0 && toLufs(z) > -70);
  if (aboveAbsolute.length === 0) return -Infinity;
  const relativeGate = toLufs(mean(aboveAbsolute)) - 10;
  const gated = aboveAbsolute.filter((z) => toLufs(z) > relativeGate);
  if (gated.length === 0) return -Infinity;
  return toLufs(mean(gated));
}

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ---- true peak (BS.1770-4 annex 2: 4x oversampling) ----

const OVERSAMPLE = 4;
const REACH = 16; // input samples each side of the point being interpolated

/** Zeroth-order modified Bessel function, for the Kaiser window. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Windowed-sinc weights for the three points between two input samples (a quarter, half and three quarters of the way),
 * for the input samples `k - REACH + 1 ..= k + REACH`. A Kaiser window (beta 9) over +-REACH samples, each phase
 * scaled to sum to 1 so a constant signal reads exactly.
 */
function interpolationWeights(): Float64Array[] {
  const beta = 9;
  const norm = bessel0(beta);
  const phases: Float64Array[] = [];
  for (let p = 1; p < OVERSAMPLE; p++) {
    const w = new Float64Array(2 * REACH);
    let sum = 0;
    for (let m = 0; m < 2 * REACH; m++) {
      const x = m - REACH + 1 - p / OVERSAMPLE; // input sample (k + m - REACH + 1) relative to the point
      const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
      const t = x / REACH;
      const window = Math.abs(t) < 1 ? bessel0(beta * Math.sqrt(1 - t * t)) / norm : 0;
      w[m] = sinc * window;
      sum += w[m]!;
    }
    for (let m = 0; m < w.length; m++) w[m]! /= sum;
    phases.push(w);
  }
  return phases;
}

const WEIGHTS = interpolationWeights();

/** The highest absolute value of the signal or of its 4x-oversampled reconstruction, over every channel. */
export function truePeakLinear(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    const n = channel.length;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(channel[i]!);
      if (a > peak) peak = a;
    }
    // Only between samples that have a whole filter's worth of signal on both sides. Padding the ends with zeros
    // would make the filter ring on a cut edge and read a peak that is not in the signal; the samples within REACH
    // of an end are still counted as they are, above.
    for (let k = REACH - 1; k + REACH < n; k++) {
      const base = k - REACH + 1;
      for (const w of WEIGHTS) {
        let acc = 0;
        for (let m = 0; m < 2 * REACH; m++) acc += w[m]! * channel[base + m]!;
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

export function truePeakDb(channels: Float32Array[]): number {
  const peak = truePeakLinear(channels);
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

// ---- clipping and silence ----

function countClipped(channels: Float32Array[]): number {
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) if (Math.abs(channel[i]!) >= CLIP_LEVEL) count++;
  }
  return count;
}

function findSilences(pcm: AudioPcm): { start: number; end: number }[] {
  const length = pcm.channels[0]?.length ?? 0;
  const minLength = Math.ceil(SILENCE_SECONDS * pcm.sampleRate);
  const silences: { start: number; end: number }[] = [];
  let runStart = -1;
  const close = (end: number): void => {
    if (runStart >= 0 && end - runStart >= minLength) {
      silences.push({ start: runStart / pcm.sampleRate, end: end / pcm.sampleRate });
    }
    runStart = -1;
  };
  for (let i = 0; i < length; i++) {
    let quiet = true;
    for (const channel of pcm.channels) {
      if (Math.abs(channel[i]!) >= SILENCE_LEVEL) {
        quiet = false;
        break;
      }
    }
    if (quiet) {
      if (runStart < 0) runStart = i;
    } else {
      close(i);
    }
  }
  close(length);
  return silences;
}
