import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';
import type { AudioClipTimeline } from './clips.js';
import { shiftPitch } from './pitch.js';
import { registeredCallbacks } from './registry.js';

export interface AudioPcm {
  sampleRate: number;
  /** One array per channel, equal lengths, samples in -1..1. */
  channels: Float32Array[];
}

const CHANNELS = 2;

/**
 * Renders the audio of frames `first..=last` as one `OfflineAudioContext`: time 0 is the start of frame `first`. It
 * calls each `onFrame` callback registered for a frame in the range with `time = (frame - first) / fps`, and plays
 * each clip with its trim, rate and loop and a gain that steps to the clip's volume at every frame. Sound that an
 * `onFrame` callback started before `first` is not heard: only callbacks inside the range run.
 *
 * The mix is returned as the graph made it, so a loud mix can pass 1.0 (which `analyzeAudio` counts as clipping); use
 * `clampPcm` before handing it to an encoder.
 */
export async function renderAudio(options: {
  fps: number;
  first: number;
  last: number;
  sampleRate?: number;
  clips: AudioClipTimeline[];
  baseDir?: string;
  /** Decodes the sound of `video: true` clips; default: the addon's `decodeAudio` (tests pass a stub). */
  decodeAudio?: DecodeAudio;
  /** Turns an `<Audio src>` into the file to read, e.g. downloads a URL once; default: `src` as it is. */
  resolveSource?: (src: string) => string | Promise<string>;
}): Promise<AudioPcm> {
  const { fps, first, last, clips } = options;
  const sampleRate = options.sampleRate ?? 48000;
  if (!(fps > 0)) throw new RangeError(`renderAudio: fps must be above 0, got ${fps}`);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) {
    throw new RangeError(`renderAudio: need whole frames 0 <= first <= last, got ${first}..=${last}`);
  }
  const length = Math.max(1, Math.round(((last - first + 1) / fps) * sampleRate));

  // Loaded here, not at the top, so that a project's bundle (which carries this file but never renders) can be
  // imported without the native audio library being resolvable from the project.
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const ctx = new OfflineAudioContext(CHANNELS, length, sampleRate);
  const timeOf = (frame: number): number => (frame - first) / fps;

  for (const { frame, callback } of registeredCallbacks(first, last)) {
    try {
      await callback(ctx, timeOf(frame));
    } catch (error) {
      throw new Error(`onFrame(${frame}) callback threw: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  const decoded = new Map<string, AudioBuffer>();
  // The sound of a video file, by path; null for a file with none.
  const videoSound = new Map<string, AudioBuffer | null>();
  // `toneFrequency`: a file's sound shifted once per pitch.
  const pitched = new Map<string, AudioBuffer>();
  for (const clip of clips) {
    const source = clip.video || !options.resolveSource ? clip.src : await options.resolveSource(clip.src);
    const path = resolve(options.baseDir ?? process.cwd(), source);
    let buffer: AudioBuffer | null | undefined;
    if (clip.video) {
      // A muted video's file is never opened for its sound.
      if (clip.muted || clip.volumes.size === 0) continue;
      buffer = videoSound.get(path);
      if (buffer === undefined) {
        buffer = await decodeVideoSound(ctx, clip.src, options.baseDir, options.decodeAudio ?? addonDecodeAudio());
        videoSound.set(path, buffer);
      }
      if (buffer === null) continue;
    } else {
      buffer = decoded.get(path);
      if (!buffer) {
        buffer = await decode(ctx, path);
        decoded.set(path, buffer);
      }
    }
    const tone = clip.toneFrequency ?? 1;
    if (tone !== 1) {
      const key = `${clip.video ? 'video' : 'audio'}:${path}@${tone}`;
      let shifted = pitched.get(key);
      if (!shifted) {
        shifted = pitchBuffer(ctx, buffer, tone);
        pitched.set(key, shifted);
      }
      buffer = shifted;
    }
    scheduleClip(ctx, buffer, clip, { fps, first, last, timeOf });
  }

  const rendered = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(Float32Array.from(rendered.getChannelData(c)));
  return { sampleRate: rendered.sampleRate, channels };
}

/**
 * Decodes the first audio stream of a video file to `sampleRate` and its channel count (the addon's `decodeAudio`).
 * `null` when the file has none.
 */
export type DecodeAudio = (path: string, sampleRate: number, baseDir?: string) => AudioPcm | null | Promise<AudioPcm | null>;

let addonDecoder: DecodeAudio | undefined;

/**
 * The addon's `decodeAudio`, loaded when the first video with sound is mixed (a project without videos never needs the
 * addon here): from this package, then from the working directory.
 */
function addonDecodeAudio(): DecodeAudio {
  if (addonDecoder) return addonDecoder;
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      const native = createRequire(base)('@kinetograph/native') as { decodeAudio: DecodeAudio };
      addonDecoder = native.decodeAudio;
      return addonDecoder;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `The sound of a video cannot be decoded: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its decodeAudio to renderAudio().',
  );
}

async function decodeVideoSound(
  ctx: OfflineAudioContext,
  src: string,
  baseDir: string | undefined,
  decoder: DecodeAudio,
): Promise<AudioBuffer | null> {
  let pcm: AudioPcm | null;
  try {
    pcm = await decoder(src, ctx.sampleRate, baseDir);
  } catch (error) {
    throw new Error(`cannot decode the sound of video ${src}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const length = pcm?.channels[0]?.length ?? 0;
  if (pcm === null || length === 0) return null;
  const buffer = ctx.createBuffer(pcm.channels.length, length, pcm.sampleRate);
  pcm.channels.forEach((channel, index) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
  return buffer;
}

/** `buffer` with its pitch times `tone`, the same length and rate. */
function pitchBuffer(ctx: OfflineAudioContext, buffer: AudioBuffer, tone: number): AudioBuffer {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  shiftPitch(channels, tone).forEach((channel, index) => out.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
  return out;
}

async function decode(ctx: OfflineAudioContext, path: string): Promise<AudioBuffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`cannot read audio file ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (error) {
    throw new Error(`cannot decode audio file ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function scheduleClip(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  clip: AudioClipTimeline,
  range: { fps: number; first: number; last: number; timeOf: (frame: number) => number },
): void {
  const { fps, first, last, timeOf } = range;
  const rate = clip.playbackRate;
  if (clip.muted || !(rate > 0) || clip.volumes.size === 0) return;

  // The part of the file that plays, in seconds of the file. The trims are frames of the composition.
  const segStart = clip.trimBefore / fps;
  const segEnd = clip.trimAfter === null ? buffer.duration : Math.min(clip.trimAfter / fps, buffer.duration);
  if (!(segEnd > segStart)) return;

  const frames = [...clip.volumes.keys()];
  const winStart = Math.max(Math.min(...frames), first);
  const winEnd = Math.min(Math.max(...frames), last);
  if (winEnd < winStart) return;

  // Where in the file the clip is at the first frame it is heard in. A clip's own frame 0 is `from`.
  const heard = Math.max(0, winStart - clip.from) / fps;
  const travelled = heard * rate;
  const when = timeOf(winStart);
  const stopAt = timeOf(winEnd + 1);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  let end = stopAt;
  if (clip.loop) {
    // Loops the trimmed part, like Remotion's `loop` after its trims.
    const span = segEnd - segStart;
    source.loop = true;
    source.loopStart = segStart;
    source.loopEnd = segEnd;
    source.start(when, segStart + (travelled % span));
  } else {
    const offset = segStart + travelled;
    if (offset >= segEnd) return;
    source.start(when, offset);
    end = Math.min(stopAt, when + (segEnd - offset) / rate);
  }
  source.stop(end);

  // A gain that holds each frame's volume for that frame's duration. A frame the clip is missing from is silent.
  const gain = ctx.createGain();
  let previous = Number.NaN;
  for (let frame = winStart; frame <= winEnd; frame++) {
    const raw = clip.volumes.get(frame) ?? 0;
    const volume = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (volume !== previous) {
      gain.gain.setValueAtTime(volume, timeOf(frame));
      previous = volume;
    }
  }
  source.connect(gain).connect(ctx.destination);
}

/** Clamps every sample to -1..1, which is what the encoder is promised (`AudioPcm`). */
export function clampPcm(pcm: AudioPcm): AudioPcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => {
      const out = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i]!;
        out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      return out;
    }),
  };
}
