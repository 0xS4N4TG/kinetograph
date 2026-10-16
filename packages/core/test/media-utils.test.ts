// The small `@remotion/media-utils` functions and the waveform ones, against values recorded from the published
// package (fixtures/media-utils.json). The audio is the same synthetic two-channel signal in the recording script.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  audioBufferToDataUrl,
  createSmoothSvgPath,
  getAudioDuration,
  getAudioDurationInSeconds,
  getImageDimensions,
  getWaveformPortion,
  setAudioDecoder,
  visualizeAudioWaveform,
  type MediaUtilsAudioData,
} from '../src/media-utils.js';
import { fixture } from './helpers.js';

const data = fixture('media-utils.json');

function recordedAudio(): MediaUtilsAudioData {
  const { sampleRate, length } = data.audio;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / sampleRate) * (0.2 + 0.8 * (i / length));
    right[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / sampleRate + 1) * (1 - 0.5 * (i / length));
  }
  return { channelWaveforms: [left, right], sampleRate, durationInSeconds: length / sampleRate, numberOfChannels: 2, resultId: 'test-audio', isRemote: false };
}

/** The recording went through JSON, which turns -0 into 0. */
const asRecorded = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The recording keeps a NaN option as a string. */
const revive = (options: Record<string, unknown>) => Object.fromEntries(Object.entries(options).map(([k, v]) => [k, v === 'NaN' ? NaN : v]));

describe('getWaveformPortion', () => {
  it('matches the published package on every recorded window, channel, range and normalisation, and its errors', () => {
    const audioData = recordedAudio();
    expect(data.getWaveformPortion.length).toBeGreaterThan(20);
    for (const c of data.getWaveformPortion) {
      const label = JSON.stringify(c.options);
      const run = () => getWaveformPortion({ audioData, ...revive(c.options) } as never);
      if (c.output.error) expect(run, label).toThrow(c.output.error);
      else expect(asRecorded(run()), label).toEqual(c.output);
    }
  });
});

describe('visualizeAudioWaveform', () => {
  it('matches the published package on every recorded frame and window, and its errors', () => {
    const audioData = recordedAudio();
    expect(data.visualizeAudioWaveform.length).toBeGreaterThan(10);
    for (const c of data.visualizeAudioWaveform) {
      const label = JSON.stringify(c.options);
      const run = () => visualizeAudioWaveform({ audioData, ...c.options });
      if (c.output.error) expect(run, label).toThrow(c.output.error);
      else expect(asRecorded(run()), label).toEqual(c.output);
    }
  });
});

describe('createSmoothSvgPath', () => {
  it('matches the published package, digit for digit', () => {
    for (const c of data.createSmoothSvgPath) expect(createSmoothSvgPath({ points: c.points }), JSON.stringify(c.points)).toBe(c.output);
  });
});

describe('audioBufferToDataUrl', () => {
  it('matches the published package: mono, stereo interleaved, other channel counts under their own header', () => {
    for (const c of data.audioBufferToDataUrl) {
      const buffer = {
        numberOfChannels: c.channels.length,
        sampleRate: c.sampleRate,
        getChannelData: (i: number) => Float32Array.from(c.channels[i]),
      };
      expect(audioBufferToDataUrl(buffer), c.name).toBe(c.output);
    }
  });
});

describe('getImageDimensions', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // 3 x 2 pixels, in the header of a PNG (nothing past the header is read)
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);

  it('reads a project file and a data URL', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kg-image-'));
    const path = join(dir, 'a.png');
    writeFileSync(path, png);
    await expect(getImageDimensions(path)).resolves.toEqual({ width: 3, height: 2 });
    await expect(getImageDimensions(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)).resolves.toEqual({ width: 3, height: 2 });
    await expect(getImageDimensions(`data:image/svg+xml,${encodeURIComponent('<svg width="40" height="30"></svg>')}`)).resolves.toEqual({ width: 40, height: 30 });
  });

  it('refuses a remote URL, a missing file and something that is not an image', async () => {
    await expect(getImageDimensions('https://example.com/a.png')).rejects.toThrow(/remote URLs are not available/);
    await expect(getImageDimensions('/no/such/dir/a.png')).rejects.toThrow();
    dir = mkdtempSync(join(tmpdir(), 'kg-image-'));
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'not an image');
    await expect(getImageDimensions(path)).rejects.toThrow(/Cannot read the size/);
  });
});

describe('getAudioDuration', () => {
  afterEach(() => setAudioDecoder(null));

  it('is getAudioDurationInSeconds under its old name', async () => {
    expect(getAudioDuration).toBe(getAudioDurationInSeconds);
    setAudioDecoder((_path, sampleRate) => ({ sampleRate, channels: [new Float32Array(sampleRate * 2)] }));
    await expect(getAudioDuration('a.wav')).resolves.toBe(2);
  });
});
