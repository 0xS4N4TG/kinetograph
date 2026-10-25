import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderAudio, type AudioClipTimeline, type AudioPcm, type DecodeAudio } from '../src/index.js';
import { peakBetween, sine } from './helpers.js';

const RATE = 48000;
const FPS = 30;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function clip(src: string): AudioClipTimeline {
  const volumes = new Map<number, number>();
  for (let f = 0; f < 30; f++) volumes.set(f, 1);
  return { id: 'a', src, from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, loop: false, muted: false, volumes };
}

/** A stand-in for the addon's `decodeAudio` (FFmpeg, by path) that gives half-scale sine and records its calls. */
function ffmpeg() {
  const calls: string[] = [];
  const decode: DecodeAudio = (src): AudioPcm => {
    calls.push(src);
    return { sampleRate: RATE, channels: [sine(440, 0.5, 1, RATE)] };
  };
  return { decode, calls };
}

describe('an audio clip that is an MP4', () => {
  it('with the moov atom at the end is decoded by FFmpeg, since node-web-audio-api needs it first', async () => {
    const { decode, calls } = ffmpeg();
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, baseDir: fixtures, decodeAudio: decode,
      clips: [clip('tone-moov-end.mp4')],
    });
    expect(calls).toEqual([join(fixtures, 'tone-moov-end.mp4')]);
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 1);
  });

  it('with faststart is decoded by node-web-audio-api as before', async () => {
    const { decode, calls } = ffmpeg();
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, baseDir: fixtures, decodeAudio: decode,
      clips: [clip('tone-faststart.mp4')],
    });
    expect(calls).toEqual([]);
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeGreaterThan(0.03);
  });

  it('that no decoder can read reports the first error', async () => {
    const fail: DecodeAudio = () => {
      throw new Error('ffmpeg says no');
    };
    await expect(
      renderAudio({ fps: FPS, first: 0, last: 29, baseDir: fixtures, decodeAudio: fail, clips: [clip('tone-moov-end.mp4')] }),
    ).rejects.toThrow(/cannot decode audio file .*moov/);
  });
});
