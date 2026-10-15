import { describe, expect, it } from 'vitest';
import { shiftPitch } from '../src/pitch.js';

const RATE = 48000;

function sine(hz: number, seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
}

/** The frequency of a steady tone from its upward zero crossings, away from the edges. */
function frequency(samples: Float32Array): number {
  const from = Math.floor(samples.length * 0.2);
  const to = Math.floor(samples.length * 0.8);
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  return ((crossings - 1) * RATE) / (last - first);
}

describe('shiftPitch', () => {
  it.each([2, 1.5, 0.5])('multiplies the pitch by %s and keeps the length', (ratio) => {
    const input = sine(440, 1);
    const [out] = shiftPitch([input], ratio);
    expect(out!.length).toBe(input.length);
    expect(frequency(out!) / 440).toBeCloseTo(ratio, 1);
  });

  it('returns the input for 1, is the same on every call, and rejects a ratio outside 0.01..2', () => {
    const input = [sine(300, 0.5), sine(300, 0.5)];
    expect(shiftPitch(input, 1)).toBe(input);
    expect(shiftPitch(input, 1.25)).toEqual(shiftPitch(input, 1.25));
    expect(() => shiftPitch(input, 3)).toThrow(/between 0.01 and 2/);
  });
});
