// `@remotion/lottie`'s getLottieMetadata, `@remotion/gif`'s preloadGif and `@remotion/media`'s extra names.

import { afterEach, describe, expect, it } from 'vitest';
import type { MediaInfo } from '@kinetograph/native';
import { Audio, Video } from '@kinetograph/react';
import { preloadGif } from '../src/gif.js';
import { getLottieMetadata, type LottieAnimationData } from '../src/lottie.js';
import { experimental_Audio, experimental_Video, getTargetSampleRate, Audio as MediaAudio, Video as MediaVideo } from '../src/media.js';
import { AUDIO_DATA_SAMPLE_RATE, setMediaProbe } from '../src/media-utils.js';
import { fixture } from './helpers.js';

describe('getLottieMetadata', () => {
  it('matches the published package, including the null for a file that lacks a field or has it as 0', () => {
    const { cases } = fixture('lottie-metadata.json');
    expect(cases.length).toBeGreaterThan(8);
    for (const c of cases) expect(getLottieMetadata(c.input as LottieAnimationData), JSON.stringify(c.input)).toEqual(c.output);
  });
});

describe('preloadGif', () => {
  const gif: MediaInfo = { kind: 'gif', width: 4, height: 4, durationInSeconds: 1, frames: 10, hasAudio: false };
  afterEach(() => setMediaProbe(null));

  it('resolves for a GIF the probe reads', async () => {
    const calls: string[] = [];
    setMediaProbe((path) => {
      calls.push(path);
      return gif;
    });
    const loading = preloadGif('/p/a.gif');
    await expect(loading.waitUntilDone()).resolves.toBeUndefined();
    expect(() => loading.free()).not.toThrow();
    expect(calls).toEqual(['/p/a.gif']);
  });

  it('rejects, when asked, for a file that is not a GIF or cannot be read, and does not throw before', async () => {
    setMediaProbe((path) => {
      if (path === '/p/clip.mp4') return { ...gif, kind: 'video' };
      throw new Error(`IO: no such file ${path}`);
    });
    const notGif = preloadGif('/p/clip.mp4');
    const missing = preloadGif('/p/missing.gif');
    await expect(notGif.waitUntilDone()).rejects.toThrow(/not a GIF/);
    await expect(missing.waitUntilDone()).rejects.toThrow(/no such file/);
  });

  it('rejects a remote URL', async () => {
    await expect(preloadGif('https://example.com/a.gif').waitUntilDone()).rejects.toThrow(/remote files are not supported/);
  });
});

describe('@kinetograph/core/media', () => {
  it('keeps the experimental names, which are the same components', () => {
    expect(experimental_Audio).toBe(Audio);
    expect(experimental_Video).toBe(Video);
    expect(MediaAudio).toBe(Audio);
    expect(MediaVideo).toBe(Video);
  });

  it('getTargetSampleRate is the rate audio is mixed and decoded at', () => {
    expect(getTargetSampleRate()).toBe(48000);
    expect(getTargetSampleRate()).toBe(AUDIO_DATA_SAMPLE_RATE);
  });
});
