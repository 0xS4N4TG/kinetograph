import { describe, expect, it } from 'vitest';
import { analyzeAudio, kWeighting, truePeakDb } from '../src/index.js';

function sine(freq: number, amplitude: number, seconds: number, sampleRate = 48000, phase = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate) + phase);
  return out;
}
const db = (x: number): number => 10 ** (x / 20);

describe('K-weighting', () => {
  it('matches the coefficients BS.1770-4 gives for 48 kHz', () => {
    const [shelf, highPass] = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 6);
  });
});

describe('integrated loudness', () => {
  it('reads a 997 Hz sine at -20 dBFS as -23 LUFS on one channel', () => {
    const tone = sine(997, db(-20), 5);
    const mono = analyzeAudio({ sampleRate: 48000, channels: [tone] });
    expect(mono.integratedLufs).toBeCloseTo(-23.01, 1);
    const oneOfTwo = analyzeAudio({ sampleRate: 48000, channels: [tone, new Float32Array(tone.length)] });
    expect(oneOfTwo.integratedLufs).toBeCloseTo(-23.01, 1);
  });

  it('reads the same sine on both channels of a stereo file as -20 LUFS', () => {
    const tone = sine(997, db(-20), 5);
    const stereo = analyzeAudio({ sampleRate: 48000, channels: [tone, tone] });
    expect(stereo.integratedLufs).toBeCloseTo(-20.0, 1);
  });

  it('is the same at 44.1 kHz', () => {
    const tone = sine(997, db(-20), 5, 44100);
    const stereo = analyzeAudio({ sampleRate: 44100, channels: [tone, tone] });
    expect(stereo.integratedLufs).toBeCloseTo(-20.0, 1);
  });

  it('weights the surround channels of a 5.1 layout by 1.41 and leaves the LFE out', () => {
    const tone = sine(997, db(-20), 5);
    const silent = new Float32Array(tone.length);
    // Only the LFE (index 3) carries sound: not counted.
    expect(analyzeAudio({ sampleRate: 48000, channels: [silent, silent, silent, tone, silent, silent] }).integratedLufs)
      .toBe(-Infinity);
    // Only Ls (index 4): 1.41 times the power, 10*log10(1.41) = +1.49 LU over a front channel.
    const ls = analyzeAudio({ sampleRate: 48000, channels: [silent, silent, silent, silent, tone, silent] });
    expect(ls.integratedLufs).toBeCloseTo(-23.01 + 1.49, 1);
  });

  it('gates out blocks 10 LU below the rest', () => {
    const loud = sine(997, db(-20), 4);
    const quiet = sine(997, db(-45), 4); // 25 LU lower
    const joined = new Float32Array(loud.length + quiet.length);
    joined.set(loud);
    joined.set(quiet, loud.length);
    const result = analyzeAudio({ sampleRate: 48000, channels: [joined, joined] });
    // Without the gate the quiet half would pull this down to about -26. The few blocks that straddle the change
    // are loud enough to pass the gate, so it is a little under -20.
    expect(result.integratedLufs).toBeGreaterThan(-20.4);
    expect(result.integratedLufs).toBeLessThan(-19.9);
  });

  it('gates out everything below -70 LUFS', () => {
    const faint = sine(997, db(-80), 3);
    expect(analyzeAudio({ sampleRate: 48000, channels: [faint, faint] }).integratedLufs).toBe(-Infinity);
  });

  it('measures a signal shorter than one block as one block', () => {
    const tone = sine(997, db(-20), 0.25);
    const result = analyzeAudio({ sampleRate: 48000, channels: [tone, tone] });
    // The high-pass has not settled in 250 ms, so allow a little more.
    expect(result.integratedLufs).toBeGreaterThan(-20.6);
    expect(result.integratedLufs).toBeLessThan(-19.6);
  });

  it('measures each scene on its own slice', () => {
    const loud = sine(997, db(-20), 3);
    const quiet = sine(997, db(-30), 3);
    const joined = new Float32Array(loud.length + quiet.length);
    joined.set(loud);
    joined.set(quiet, loud.length);
    const result = analyzeAudio({ sampleRate: 48000, channels: [joined, joined] }, { scenes: [[0, 3], [3, 6]] });
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes![0]!.integratedLufs).toBeCloseTo(-20.0, 1);
    expect(result.scenes![1]!.integratedLufs).toBeCloseTo(-30.0, 1);
    expect(result.scenes![1]!.from).toBe(3);
  });
});

describe('true peak', () => {
  it('finds the peak between samples: a sine at a quarter of the sample rate, 45 degrees off', () => {
    // Every sample is +-0.7071, the waveform peaks at 1.0 between them.
    const tone = sine(12000, 1, 0.1, 48000, Math.PI / 4);
    let samplePeak = 0;
    for (const v of tone) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-3.01, 1);
    expect(truePeakDb([tone])).toBeCloseTo(0, 1);
  });

  it('reads an ordinary sine at its amplitude', () => {
    const tone = sine(997, 0.5, 1);
    expect(analyzeAudio({ sampleRate: 48000, channels: [tone] }).truePeakDb).toBeCloseTo(-6.02, 1);
  });

  it('takes the highest channel and is -Infinity for digital silence', () => {
    const quiet = sine(997, 0.1, 0.2);
    const loud = sine(997, 0.5, 0.2);
    expect(truePeakDb([quiet, loud])).toBeCloseTo(-6.02, 1);
    expect(truePeakDb([new Float32Array(1000)])).toBe(-Infinity);
  });

  it('reads a signal shorter than the filter as its sample peak', () => {
    expect(truePeakDb([Float32Array.of(0.5, -0.5, 0.25)])).toBeCloseTo(-6.02, 2);
  });

  it('does not ring on a signal cut off in the middle of a tone', () => {
    const tone = sine(3000, 1, 0.1, 48000, 1.1).slice(1000, 3000);
    expect(truePeakDb([tone])).toBeLessThan(0.05);
  });
});

describe('clipping and silence', () => {
  it('counts samples at full scale in every channel', () => {
    const a = Float32Array.of(0, 1, -1, 0.5, 1.2);
    const b = Float32Array.of(0, 0, 0.99999, 0.9, -1);
    expect(analyzeAudio({ sampleRate: 48000, channels: [a, b] }).clippedSamples).toBe(5);
  });

  it('reports silences of at least half a second, and not shorter ones', () => {
    const rate = 8000;
    const parts = [sine(440, 0.5, 1, rate), new Float32Array(rate), sine(440, 0.5, 1, rate), new Float32Array(rate * 0.3), sine(440, 0.5, 0.5, rate), new Float32Array(rate)];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    const { silences } = analyzeAudio({ sampleRate: rate, channels: [joined] });
    expect(silences).toHaveLength(2);
    expect(silences[0]!.start).toBeCloseTo(1, 2);
    expect(silences[0]!.end).toBeCloseTo(2, 2);
    expect(silences[1]!.start).toBeCloseTo(total / rate - 1, 2);
    expect(silences[1]!.end).toBeCloseTo(total / rate, 5);
  });
});
