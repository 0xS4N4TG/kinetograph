import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';
import type { AudioClipTimeline } from './clips.js';
import { shiftPitch } from './pitch.js';
import { registeredCallbacks } from './registry.js';
import { parseFxChain, type FxChain } from './hf-fx/chain.js';
import { parseFxLanes, type Lane } from './hf-fx/automation.js';
import { chainTailSeconds, runFxChain } from './hf-fx/graph.js';

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

  const load = bufferLoader(ctx, options);
  // The clips of HyperFrames elements with effects are mixed after this context, through their chains.
  const fx = planHfFx(clips);
  for (const clip of clips) {
    if (fx.routed.has(clip)) continue;
    const buffer = await load(clip);
    if (buffer) scheduleClip(ctx, buffer, clip, { fps, first, last, timeOf });
  }

  const rendered = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(Float32Array.from(rendered.getChannelData(c)));
  if (fx.tracks.length > 0 || fx.master !== null) await mixHfFx(fx, channels, { fps, first, last, sampleRate, load });
  return { sampleRate: rendered.sampleRate, channels };
}

/** Each clip's sound as a buffer, decoded once per file (and per pitch for `toneFrequency`); null for a video without sound. */
function bufferLoader(
  ctx: OfflineAudioContext,
  options: { baseDir?: string; decodeAudio?: DecodeAudio; resolveSource?: (src: string) => string | Promise<string> },
): (clip: AudioClipTimeline) => Promise<AudioBuffer | null> {
  const decoded = new Map<string, AudioBuffer>();
  // The sound of a video file, by path; null for a file with none.
  const videoSound = new Map<string, AudioBuffer | null>();
  // `toneFrequency`: a file's sound shifted once per pitch.
  const pitched = new Map<string, AudioBuffer>();
  return async (clip) => {
    const source = clip.video || !options.resolveSource ? clip.src : await options.resolveSource(clip.src);
    const path = resolve(options.baseDir ?? process.cwd(), source);
    let buffer: AudioBuffer | null | undefined;
    if (clip.video) {
      // A muted video's file is never opened for its sound.
      if (clip.muted || clip.volumes.size === 0) return null;
      buffer = videoSound.get(path);
      if (buffer === undefined) {
        buffer = await decodeVideoSound(ctx, clip.src, options.baseDir, options.decodeAudio ?? addonDecodeAudio());
        videoSound.set(path, buffer);
      }
      if (buffer === null) return null;
    } else {
      buffer = decoded.get(path);
      if (!buffer) {
        buffer = await decode(ctx, path, options.baseDir, options.decodeAudio);
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
    return buffer;
  };
}

// ---- HyperFrames' audio effects (AUTHORING.md §6.4; hf-fx/) ----

interface FxTrack {
  fx: NonNullable<AudioClipTimeline['hfFx']>;
  clips: AudioClipTimeline[];
  chain: FxChain | null;
  lanes: Lane[];
}
interface FxGroup {
  chain: FxChain;
  lanes: Lane[];
  tracks: FxTrack[];
}
interface FxPlan {
  /** The clips that play into a chain rather than straight into the mix. */
  routed: Set<AudioClipTimeline>;
  tracks: FxTrack[];
  groups: Map<string, FxGroup>;
  master: FxChain | null;
}

/** Reads the chains and lanes. An unreadable one stops the mix, as it stops HyperFrames' render (audioMixer.ts). */
function planHfFx(clips: AudioClipTimeline[]): FxPlan {
  const plan: FxPlan = { routed: new Set(), tracks: [], groups: new Map(), master: null };
  const byTrack = new Map<string, FxTrack>();
  const read = <T>(what: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new Error(`the audio effects of ${what} cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  for (const clip of clips) {
    const fx = clip.hfFx;
    if (!fx) continue;
    if (fx.master !== null && plan.master === null) plan.master = read('the root composition (the master bus)', () => parseFxChain(fx.master!));
    if (fx.chain === null && fx.group === null) continue;
    plan.routed.add(clip);
    let track = byTrack.get(fx.track);
    if (!track) {
      const chain = fx.chain === null ? null : read(`#${fx.track}`, () => parseFxChain(fx.chain!));
      const lanes = chain !== null && fx.automation ? read(`#${fx.track}`, () => parseFxLanes(fx.automation!, chain)) : [];
      track = { fx, clips: [], chain, lanes };
      byTrack.set(fx.track, track);
      plan.tracks.push(track);
      const bus = fx.group;
      if (bus) {
        let group = plan.groups.get(bus.id);
        if (!group) {
          const groupChain = read(`group #${bus.id}`, () => parseFxChain(bus.chain));
          const groupLanes = bus.automation ? read(`group #${bus.id}`, () => parseFxLanes(bus.automation!, groupChain)) : [];
          group = { chain: groupChain, lanes: groupLanes, tracks: [] };
          plan.groups.set(bus.id, group);
        }
        group.tracks.push(track);
      }
    }
    track.clips.push(clip);
  }
  return plan;
}

/**
 * `gains` (frame → gain) as one gain per sample from frame `from`: each frame's held for the frame, the first frame's
 * before it, and after the last frame `after` until `afterUntil` seconds, then 0.
 */
function frameGains(gains: Map<number, number>, from: number, length: number, fps: number, sampleRate: number, after: number, afterUntil: number): Float32Array {
  const out = new Float32Array(length);
  if (gains.size === 0) return out;
  const frames = [...gains.keys()];
  const firstFrame = Math.min(...frames);
  const lastFrame = Math.max(...frames);
  for (let i = 0; i < length; i++) {
    const t = from / fps + i / sampleRate;
    const frame = Math.floor(t * fps + 1e-9);
    out[i] = frame > lastFrame ? (t < afterUntil ? after : 0) : (gains.get(Math.max(frame, firstFrame)) ?? 0);
  }
  return out;
}

/**
 * Plays each HyperFrames element with effects through its chain, each group with effects through its bus, and the mix
 * through the master bus, into `channels`, as HyperFrames' render does (engine/audioMixer.ts): the element's sound at
 * `pre` from its first sample, its chain with its `fx.*` lanes on the element's clock, then its `volume` (after `end`,
 * `after`, for as long as the chain's tail); a group's members summed, its chain with its lanes on composition time,
 * then its fader; and the master chain over the whole mix.
 */
async function mixHfFx(
  plan: FxPlan,
  channels: Float32Array[],
  range: { fps: number; first: number; last: number; sampleRate: number; load: (clip: AudioClipTimeline) => Promise<AudioBuffer | null> },
): Promise<void> {
  const { fps, first, last, sampleRate, load } = range;
  const total = channels[0]!.length;
  const { OfflineAudioContext } = await import('node-web-audio-api');
  const add = (into: Float32Array[], planes: Float32Array[], at: number, gain: Float32Array): void => {
    into.forEach((target, c) => {
      const plane = planes[Math.min(c, planes.length - 1)]!;
      const n = Math.min(plane.length, target.length - at);
      for (let i = 0; i < n; i++) target[at + i]! += plane[i]! * gain[i]!;
    });
  };
  const sums = new Map<FxGroup, Float32Array[]>();
  for (const group of plan.groups.values()) sums.set(group, channels.map(() => new Float32Array(total)));

  for (const track of plan.tracks) {
    const frames = track.clips.flatMap((clip) => [...clip.volumes.keys()]);
    if (frames.length === 0) continue;
    const from = Math.max(first, Math.min(...frames));
    const at = Math.round(((from - first) / fps) * sampleRate);
    const length = total - at;
    if (from > last || length <= 0) continue;
    // The element's sound alone, from its first frame in the range, at `pre`.
    const ctx = new OfflineAudioContext(channels.length, length, sampleRate);
    for (const clip of track.clips) {
      const buffer = await load(clip);
      const dry = { ...clip, volumes: new Map([...clip.volumes.keys()].map((f): [number, number] => [f, track.fx.pre])) };
      if (buffer) scheduleClip(ctx, buffer, dry, { fps, first: from, last, timeOf: (frame) => (frame - from) / fps });
    }
    const rendered = await ctx.startRendering();
    let planes: Float32Array[] = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) planes.push(Float32Array.from(rendered.getChannelData(c)));
    let tail = 0;
    if (track.chain !== null) {
      planes = await runFxChain(planes, sampleRate, track.chain, track.lanes, { scheduledAt: 0, elapsed: from / fps - track.fx.start });
      tail = chainTailSeconds(track.chain, track.lanes);
    }
    const volumes = new Map<number, number>();
    for (const clip of track.clips) for (const [f, v] of clip.volumes) volumes.set(f, v);
    const group = track.fx.group ? plan.groups.get(track.fx.group.id) : undefined;
    add(group ? sums.get(group)! : channels, planes, at, frameGains(volumes, from, length, fps, sampleRate, track.fx.after, track.fx.end + tail));
  }

  for (const group of plan.groups.values()) {
    const planes = await runFxChain(sums.get(group)!, sampleRate, group.chain, group.lanes, { scheduledAt: 0, elapsed: first / fps });
    const faders = new Map<number, number>();
    for (const track of group.tracks) for (const clip of track.clips) for (const [f, v] of clip.groupGains ?? []) faders.set(f, v);
    const lastFader = faders.size > 0 ? faders.get(Math.max(...faders.keys()))! : 0;
    add(channels, planes, 0, frameGains(faders, first, total, fps, sampleRate, lastFader, Infinity));
  }

  if (plan.master !== null) {
    const mastered = await runFxChain(channels, sampleRate, plan.master, [], { scheduledAt: 0, elapsed: first / fps });
    mastered.forEach((plane, c) => channels[c]!.set(plane));
  }
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
      const native = createRequire(base)('@kinetographdev/native') as { decodeAudio: DecodeAudio };
      addonDecoder = native.decodeAudio;
      return addonDecoder;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `The sound of a video cannot be decoded: @kinetographdev/native could not be loaded (${failures.join('; ')}). ` +
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

/**
 * An audio file as a buffer: `decodeAudioData` first, then FFmpeg (the addon's `decodeAudio`, which opens the file by
 * path) for what node-web-audio-api's decoder refuses. It reads a stream, so an MP4 or MOV whose `moov` atom comes after
 * the media data ("missing moov atom"; any ffmpeg or camera output without `-movflags +faststart`) is one of those.
 */
async function decode(
  ctx: OfflineAudioContext,
  path: string,
  baseDir: string | undefined,
  decoder: DecodeAudio | undefined,
): Promise<AudioBuffer> {
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
    let fallback: AudioBuffer | null = null;
    try {
      fallback = await decodeVideoSound(ctx, path, baseDir, decoder ?? addonDecodeAudio());
    } catch {
      // The addon could not do it either: the first error is the one to report.
    }
    if (fallback) return fallback;
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
