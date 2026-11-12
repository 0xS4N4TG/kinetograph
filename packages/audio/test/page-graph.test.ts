// What a page did with its AudioContext, replayed into the mix: a node made at a frame sounds from that frame, a
// parameter call lands at its time, and two renders give the same samples.

import { describe, expect, it } from 'vitest';
import type { PageAudioOp } from '@kinetographdev/scene';
import { renderAudio } from '../src/index.js';
import { peakBetween } from './helpers.js';

const RATE = 48000;
const FPS = 30;

/** A 997 Hz oscillator through a gain, made at frame 30 (1 s) and silenced at frame 60 (2 s). */
const calls: PageAudioOp[] = [
  { seq: 0, t: 1, op: 'new', id: 'n1', kind: 'oscillator' },
  { seq: 1, t: 1, op: 'param', id: 'n1', name: 'frequency', method: 'setValueAtTime', args: [997, 1] },
  { seq: 2, t: 1, op: 'new', id: 'n2', kind: 'gain' },
  { seq: 3, t: 1, op: 'connect', id: 'n1', to: 'n2' },
  { seq: 4, t: 1, op: 'connect', id: 'n2', to: 'dest' },
  { seq: 5, t: 1, op: 'call', id: 'n1', method: 'start', args: [1] },
  { seq: 6, t: 2, op: 'param', id: 'n2', name: 'gain', method: 'setValueAtTime', args: [0, 2] },
];

describe('renderAudio with a page graph', () => {
  it('plays the calls on the clock: silent before frame 30, a tone until frame 60, silent after', async () => {
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 89, clips: [], pageAudio: calls });
    expect(pcm.channels[0]!.length).toBe(3 * RATE);
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 0.99)).toBe(0);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.05, 1.95)).toBeGreaterThan(0.9);
    expect(peakBetween(pcm.channels[0]!, RATE, 2.05, 2.95)).toBe(0);
  });

  it('is the same samples in two renders and whatever order the calls arrive in (they are numbered)', async () => {
    const a = await renderAudio({ fps: FPS, first: 0, last: 89, clips: [], pageAudio: calls });
    const b = await renderAudio({ fps: FPS, first: 0, last: 89, clips: [], pageAudio: [...calls].reverse() });
    expect(Buffer.from(b.channels[0]!.buffer).equals(Buffer.from(a.channels[0]!.buffer))).toBe(true);
    expect(Buffer.from(b.channels[1]!.buffer).equals(Buffer.from(a.channels[1]!.buffer))).toBe(true);
  });
});
