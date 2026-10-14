import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeAudio,
  clampPcm,
  clearOnFrame,
  onFrame,
  renderAudio,
  type AudioClipTimeline,
} from '../src/index.js';
import { peakBetween, sine, writeWav } from './helpers.js';

const RATE = 48000;
const FPS = 30;

afterEach(() => clearOnFrame());

function timeline(over: Partial<AudioClipTimeline> & { frames: [number, number]; volume?: number }): AudioClipTimeline {
  const volumes = new Map<number, number>();
  for (let f = over.frames[0]; f <= over.frames[1]; f++) volumes.set(f, over.volume ?? 1);
  const { frames: _frames, volume: _volume, ...rest } = over;
  return {
    id: 'clip',
    src: 'clip.wav',
    from: over.frames[0],
    trimBefore: 0,
    trimAfter: null,
    playbackRate: 1,
    loop: false,
    muted: false,
    volumes,
    ...rest,
  };
}

describe('renderAudio with onFrame', () => {
  it('starts a callback at its frame, sample-accurately, and the mix is stereo at the requested rate', async () => {
    onFrame(30, (ctx, t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 997;
      gain.gain.value = 0.1;
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1);
    });
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 89, clips: [] });
    expect(pcm.sampleRate).toBe(RATE);
    expect(pcm.channels).toHaveLength(2);
    expect(pcm.channels[0]!.length).toBe(3 * RATE);
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 0.99)).toBeLessThan(1e-6);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.05, 1.95)).toBeCloseTo(0.1, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 2.05, 3)).toBeLessThan(1e-6);
    expect(Array.from(pcm.channels[1]!.slice(RATE + 100, RATE + 200))).toEqual(
      Array.from(pcm.channels[0]!.slice(RATE + 100, RATE + 200)),
    );
    // Both channels carry the tone: -20 dBFS on stereo reads about -20 LUFS (a little under, since a one second tone
    // fills only a few 400 ms blocks and the blocks that overlap its ends pass the gate).
    const lufs = analyzeAudio(pcm).integratedLufs;
    expect(lufs).toBeGreaterThan(-22);
    expect(lufs).toBeLessThan(-19.9);
  });

  it('measures time from the first frame of the range and skips callbacks outside it', async () => {
    const seen: number[] = [];
    onFrame(10, () => seen.push(10));
    onFrame(30, (ctx, t) => {
      seen.push(30);
      const src = ctx.createConstantSource();
      src.offset.value = 0.5;
      src.connect(ctx.destination);
      src.start(t);
      src.stop(t + 0.5);
    });
    onFrame(200, () => seen.push(200));
    const pcm = await renderAudio({ fps: FPS, first: 15, last: 74, clips: [] });
    expect(seen).toEqual([30]);
    expect(pcm.channels[0]!.length).toBe(2 * RATE);
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 0.49)).toBe(0);
    expect(peakBetween(pcm.channels[0]!, RATE, 0.51, 0.99)).toBeCloseTo(0.5, 3);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.01, 2)).toBe(0);
  });

  it('names the frame when a callback throws', async () => {
    onFrame(5, () => {
      throw new Error('boom');
    });
    await expect(renderAudio({ fps: FPS, first: 0, last: 9, clips: [] })).rejects.toThrow(/onFrame\(5\).*boom/);
  });

  it('renders silence for nothing', async () => {
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 29, clips: [] });
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 1)).toBe(0);
  });
});

describe('renderAudio with <Audio> clips', () => {
  // Two seconds at 48 kHz: 0.25 for the first second, 0.5 for the second.
  const twoLevels = (): Float32Array => {
    const a = sine(440, 0.25, 1, RATE);
    const b = sine(440, 0.5, 1, RATE);
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  it('starts a clip at its frame', async () => {
    const { dir } = writeWav(twoLevels(), RATE);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 149, baseDir: dir,
      clips: [timeline({ frames: [30, 89], from: 30 })],
    });
    const left = pcm.channels[0]!;
    expect(peakBetween(left, RATE, 0, 0.99)).toBe(0);
    expect(peakBetween(left, RATE, 1.1, 1.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(left, RATE, 2.1, 2.9)).toBeCloseTo(0.5, 2);
    expect(peakBetween(left, RATE, 3.05, 5)).toBe(0);
    // A mono file is heard in both channels.
    expect(peakBetween(pcm.channels[1]!, RATE, 2.1, 2.9)).toBeCloseTo(0.5, 2);
  });

  it('skips the trimmed start of the file', async () => {
    const { dir } = writeWav(twoLevels(), RATE);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, baseDir: dir,
      clips: [timeline({ frames: [0, 29], from: 0, trimBefore: 30 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
  });

  it('stops at trimAfter', async () => {
    const { dir } = writeWav(twoLevels(), RATE);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, baseDir: dir,
      clips: [timeline({ frames: [0, 89], from: 0, trimAfter: 30 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.05, 3)).toBe(0);
  });

  it('plays at its playbackRate, finishing in half the time at 2', async () => {
    const { dir } = writeWav(twoLevels(), RATE);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, baseDir: dir,
      clips: [timeline({ frames: [0, 89], from: 0, playbackRate: 2 })],
    });
    // The first half-second of output is the file's first second (0.25), the next is its second (0.5).
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.45)).toBeCloseTo(0.25, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 0.6, 0.95)).toBeCloseTo(0.5, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 3)).toBe(0);
  });

  it('loops the file, and the trimmed part of it when there is a trim', async () => {
    const half = sine(440, 0.5, 0.5, RATE);
    const { dir } = writeWav(half, RATE);
    const looped = await renderAudio({
      fps: FPS, first: 0, last: 59, baseDir: dir,
      clips: [timeline({ frames: [0, 59], from: 0, loop: true })],
    });
    expect(peakBetween(looped.channels[0]!, RATE, 1.2, 1.9)).toBeCloseTo(0.5, 2);
    const twoLevelsDir = writeWav(twoLevels(), RATE).dir;
    const trimmed = await renderAudio({
      fps: FPS, first: 0, last: 89, baseDir: twoLevelsDir,
      clips: [timeline({ frames: [0, 89], from: 0, loop: true, trimBefore: 30, trimAfter: 45 })],
    });
    // Only the second half-second, 0.5, ever plays.
    expect(peakBetween(trimmed.channels[0]!, RATE, 0.1, 2.9)).toBeCloseTo(0.5, 2);
  });

  it('steps the gain to the volume of each frame', async () => {
    const { dir } = writeWav(sine(440, 0.5, 3, RATE), RATE);
    const volumes = new Map<number, number>();
    for (let f = 0; f < 90; f++) volumes.set(f, f < 30 ? 1 : f < 60 ? 0.5 : 0);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, baseDir: dir,
      clips: [{ ...timeline({ frames: [0, 0], from: 0 }), volumes }],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 1.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 2.1, 2.9)).toBe(0);
  });

  it('plays only the part of a clip inside the range, at the right place in the file', async () => {
    const { dir } = writeWav(twoLevels(), RATE);
    // The clip started at frame 0; the range starts one second in, where the file turns to 0.5.
    const pcm = await renderAudio({
      fps: FPS, first: 30, last: 59, baseDir: dir,
      clips: [timeline({ frames: [0, 59], from: 0 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
  });

  it('mixes a clip with onFrame synthesis', async () => {
    const { dir } = writeWav(sine(440, 0.25, 1, RATE), RATE);
    onFrame(0, (ctx, t) => {
      const src = ctx.createConstantSource();
      src.offset.value = 0.25;
      src.connect(ctx.destination);
      src.start(t);
      src.stop(t + 1);
    });
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, baseDir: dir,
      clips: [timeline({ frames: [0, 29], from: 0 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeGreaterThan(0.45);
  });

  it('says which file it could not read', async () => {
    await expect(
      renderAudio({ fps: FPS, first: 0, last: 9, baseDir: '/nonexistent', clips: [timeline({ frames: [0, 9], src: 'gone.wav' })] }),
    ).rejects.toThrow(/cannot read audio file .*gone\.wav/);
  });
});

describe('clampPcm', () => {
  it('limits samples to -1..1 and leaves the rest alone', () => {
    const out = clampPcm({ sampleRate: 8000, channels: [Float32Array.of(0.5, 1.5, -2)] });
    expect(Array.from(out.channels[0]!)).toEqual([0.5, 1, -1]);
  });
});
