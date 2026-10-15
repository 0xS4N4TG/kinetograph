import { describe, expect, it } from 'vitest';
import { joinClips, renderAudio, type AudioClipTimeline, type AudioPcm, type DecodeAudio } from '../src/index.js';
import { peakBetween, sine } from './helpers.js';

const RATE = 48000;
const FPS = 30;

/** Two seconds: 0.25 for the first second, 0.5 for the second. */
function twoLevels(): Float32Array {
  const a = sine(440, 0.25, 1, RATE);
  const b = sine(440, 0.5, 1, RATE);
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A stand-in for the addon's `decodeAudio` that serves `files` and records how it was called. */
function decoder(files: Record<string, AudioPcm | null>) {
  const calls: { src: string; sampleRate: number; baseDir: string | undefined }[] = [];
  const decode: DecodeAudio = (src, sampleRate, baseDir) => {
    calls.push({ src, sampleRate, baseDir });
    if (!(src in files)) throw new Error(`no such file ${src}`);
    return files[src]!;
  };
  return { decode, calls };
}

const mono = (samples: Float32Array): AudioPcm => ({ sampleRate: RATE, channels: [samples] });

function videoClip(over: Partial<AudioClipTimeline> & { frames: [number, number]; volume?: number }): AudioClipTimeline {
  const volumes = new Map<number, number>();
  for (let f = over.frames[0]; f <= over.frames[1]; f++) volumes.set(f, over.volume ?? 1);
  const { frames: _frames, volume: _volume, ...rest } = over;
  return {
    id: 'v',
    src: 'clip.mp4',
    from: over.frames[0],
    trimBefore: 0,
    trimAfter: null,
    playbackRate: 1,
    loop: false,
    muted: false,
    video: true,
    volumes,
    ...rest,
  };
}

describe('renderAudio with the sound of a <Video>', () => {
  it('decodes through the injected decoder at the mix rate, with the clip src and baseDir, and plays from the clip start', async () => {
    const { decode, calls } = decoder({ 'clip.mp4': mono(twoLevels()) });
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 149, baseDir: '/project', decodeAudio: decode,
      clips: [videoClip({ frames: [30, 89], from: 30 })],
    });
    expect(calls).toEqual([{ src: 'clip.mp4', sampleRate: RATE, baseDir: '/project' }]);
    const left = pcm.channels[0]!;
    expect(peakBetween(left, RATE, 0, 0.99)).toBe(0);
    expect(peakBetween(left, RATE, 1.1, 1.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(left, RATE, 2.1, 2.9)).toBeCloseTo(0.5, 2);
    expect(peakBetween(left, RATE, 3.05, 5)).toBe(0);
    // Mono is heard in both channels.
    expect(peakBetween(pcm.channels[1]!, RATE, 2.1, 2.9)).toBeCloseTo(0.5, 2);
  });

  it('keeps the two channels of a stereo file apart', async () => {
    const { decode } = decoder({ 'clip.mp4': { sampleRate: RATE, channels: [sine(440, 0.2, 1, RATE), sine(440, 0.6, 1, RATE)] } });
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 29, decodeAudio: decode, clips: [videoClip({ frames: [0, 29] })] });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.2, 2);
    expect(peakBetween(pcm.channels[1]!, RATE, 0.1, 0.9)).toBeCloseTo(0.6, 2);
  });

  it('skips the trimmed start and stops at trimAfter', async () => {
    const { decode } = decoder({ 'clip.mp4': mono(twoLevels()) });
    const skipped = await renderAudio({
      fps: FPS, first: 0, last: 29, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 29], trimBefore: 30 })],
    });
    expect(peakBetween(skipped.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
    const stopped = await renderAudio({
      fps: FPS, first: 0, last: 89, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 89], trimAfter: 30 })],
    });
    expect(peakBetween(stopped.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(stopped.channels[0]!, RATE, 1.05, 3)).toBe(0);
  });

  it('plays at its playbackRate', async () => {
    const { decode } = decoder({ 'clip.mp4': mono(twoLevels()) });
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 89], playbackRate: 2 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.45)).toBeCloseTo(0.25, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 0.6, 0.95)).toBeCloseTo(0.5, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 3)).toBe(0);
  });

  it('loops the trimmed part of the file', async () => {
    const { decode } = decoder({ 'clip.mp4': mono(twoLevels()) });
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 89], loop: true, trimBefore: 30, trimAfter: 45 })],
    });
    // Only the second half-second, 0.5, ever plays.
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 2.9)).toBeCloseTo(0.5, 2);
  });

  it('steps the gain to the volume of each frame', async () => {
    const { decode } = decoder({ 'clip.mp4': mono(sine(440, 0.5, 3, RATE)) });
    const volumes = new Map<number, number>();
    for (let f = 0; f < 90; f++) volumes.set(f, f < 30 ? 1 : f < 60 ? 0.5 : 0);
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 89, decodeAudio: decode,
      clips: [{ ...videoClip({ frames: [0, 0] }), volumes }],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 1.9)).toBeCloseTo(0.25, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 2.1, 2.9)).toBe(0);
  });

  it('plays only the part inside the range, at the right place in the file', async () => {
    const { decode } = decoder({ 'clip.mp4': mono(twoLevels()) });
    const pcm = await renderAudio({
      fps: FPS, first: 30, last: 59, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 59], from: 0 })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5, 2);
  });

  it('is silent, and never opens the file, when muted', async () => {
    const { decode, calls } = decoder({});
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 29], muted: true })],
    });
    expect(calls).toEqual([]);
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 1)).toBe(0);
  });

  it('plays silence for a file without sound', async () => {
    const { decode, calls } = decoder({ 'clip.mp4': null, 'empty.mp4': { sampleRate: RATE, channels: [new Float32Array(0)] } });
    const pcm = await renderAudio({
      fps: FPS, first: 0, last: 29, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 29] }), videoClip({ id: 'e', src: 'empty.mp4', frames: [0, 29] })],
    });
    expect(calls.map((c) => c.src)).toEqual(['clip.mp4', 'empty.mp4']);
    expect(pcm.channels[0]!.length).toBe(RATE);
    expect(peakBetween(pcm.channels[0]!, RATE, 0, 1)).toBe(0);
  });

  it('decodes a file once however many clips use it', async () => {
    const { decode, calls } = decoder({ 'clip.mp4': mono(sine(440, 0.25, 1, RATE)) });
    await renderAudio({
      fps: FPS, first: 0, last: 59, decodeAudio: decode,
      clips: [videoClip({ frames: [0, 29] }), videoClip({ id: 'w', frames: [30, 59], from: 30 })],
    });
    expect(calls).toHaveLength(1);
  });

  it('mixes with an <Audio> clip that is not a video', async () => {
    const { decode, calls } = decoder({ 'clip.mp4': mono(sine(440, 0.2, 1, RATE)) });
    // The <Audio> clip's file is read from disk, so a missing one is still reported as an audio file.
    await expect(
      renderAudio({
        fps: FPS, first: 0, last: 29, baseDir: '/nonexistent', decodeAudio: decode,
        clips: [videoClip({ frames: [0, 29] }), videoClip({ id: 'a', src: 'gone.wav', frames: [0, 29], video: undefined })],
      }),
    ).rejects.toThrow(/cannot read audio file .*gone\.wav/);
    expect(calls).toHaveLength(1);
  });

  it('names the video when the decoder fails', async () => {
    const { decode } = decoder({});
    await expect(
      renderAudio({ fps: FPS, first: 0, last: 9, decodeAudio: decode, clips: [videoClip({ frames: [0, 9], src: 'broken.mp4' })] }),
    ).rejects.toThrow(/cannot decode the sound of video broken\.mp4: no such file broken\.mp4/);
  });

  it('accepts an async decoder', async () => {
    const decode: DecodeAudio = async () => mono(sine(440, 0.3, 1, RATE));
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 29, decodeAudio: decode, clips: [videoClip({ frames: [0, 29] })] });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.3, 2);
  });
});

describe('the sound of a <Video> from joinClips to renderAudio', () => {
  it('keeps a video clip and an <Audio> clip of the same file apart', () => {
    const base = { src: 'a.mp4', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false };
    const joined = joinClips([
      { frame: 0, audio: [{ id: 'x', ...base, video: true }, { id: 'x', ...base }] },
      { frame: 1, audio: [{ id: 'x', ...base, video: true }] },
    ]);
    expect(joined).toHaveLength(2);
    expect(joined[0]).toMatchObject({ video: true });
    expect([...joined[0]!.volumes.keys()]).toEqual([0, 1]);
    expect(joined[1]).not.toHaveProperty('video');
  });

  it('makes the clip a mix input with the frame volumes', async () => {
    const base = { id: 'v', src: 'clip.mp4', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, loop: false, video: true };
    const frames = Array.from({ length: 60 }, (_, frame) => ({
      frame,
      audio: [{ ...base, volume: frame < 30 ? 1 : 0.5, muted: frame >= 50 }],
    }));
    const { decode } = decoder({ 'clip.mp4': mono(sine(440, 0.4, 2, RATE)) });
    const pcm = await renderAudio({ fps: FPS, first: 0, last: 59, decodeAudio: decode, clips: joinClips(frames) });
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.4, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 1.6)).toBeCloseTo(0.2, 2);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.75, 2)).toBe(0);
  });
});
