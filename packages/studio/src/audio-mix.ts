// The studio's audio: the clips the timeline sweep collected, mixed by the same `@kinetographdev/audio` code that
// `kinetograph render` uses, as a WAV the browser plays and as peaks for the timeline's waveforms. Nothing here reads
// the clock: the mix is a function of the clips.

import { clampPcm, hasOnFrame, joinClips, renderAudio, type AudioPcm } from '@kinetographdev/audio';
import { resolveSoundSource } from '@kinetographdev/core/sound-source';
import type { AudioClipJson } from '@kinetographdev/scene';
import { soundKey } from './util.js';

/** How many peaks the mix and each clip keep; a request for fewer buckets takes the loudest of the ones it covers. */
export const PEAK_BUCKETS = 4096;

/** The mixed audio of a composition, over all its frames. */
export interface AudioMix {
  /** 16-bit stereo PCM WAV of the whole composition. */
  wav: Uint8Array;
  sampleRate: number;
  seconds: number;
  /** Peaks (0..1) of the whole mix, `PEAK_BUCKETS` of them across the composition. */
  peaks: number[];
  /** Peaks of each clip alone, across the frames it plays in (first frame, then the one after its last). */
  clips: { id: string; startFrame: number; endFrame: number; peaks: number[] }[];
}

/** The loudest sample in each of `buckets` equal slices of samples `begin..end` of any channel, 0..1. */
export function peaksOf(channels: Float32Array[], begin: number, end: number, buckets: number): number[] {
  const length = Math.max(0, end - begin);
  const count = Math.max(1, Math.min(buckets, length));
  const peaks = new Array<number>(count).fill(0);
  for (let b = 0; b < count; b++) {
    const lo = begin + Math.floor((b * length) / count);
    const hi = begin + Math.max(lo - begin + 1, Math.floor(((b + 1) * length) / count));
    let peak = 0;
    for (const channel of channels) {
      for (let i = lo; i < hi && i < channel.length; i++) {
        const v = Math.abs(channel[i]!);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = Math.min(1, peak);
  }
  return peaks;
}

/** `pcm` as a 16-bit PCM WAV file. */
export function encodeWav(pcm: AudioPcm): Uint8Array {
  const channels = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, pcm.channels[c]![i]!));
      view.setInt16(at, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
      at += 2;
    }
  }
  return bytes;
}

/** The mix of the clips seen on each frame; null when the composition has no sound. */
export async function mixAudio(
  frames: { frame: number; audio: AudioClipJson[] }[],
  info: { fps: number; durationInFrames: number; baseDir: string },
): Promise<AudioMix | null> {
  const { fps, durationInFrames, baseDir } = info;
  const last = durationInFrames - 1;
  const clips = joinClips(frames);
  if (clips.length === 0 && !hasOnFrame(0, last)) return null;
  const mix = (list: typeof clips) => renderAudio({ fps, first: 0, last, clips: list, baseDir, resolveSource: resolveSoundSource });

  const pcm = clampPcm(await mix(clips));
  const length = pcm.channels[0]?.length ?? 0;
  const samplesPerFrame = pcm.sampleRate / fps;

  const byId = new Map<string, typeof clips>();
  for (const clip of clips) {
    const id = soundKey(clip);
    byId.set(id, [...(byId.get(id) ?? []), clip]);
  }
  // One clip and no synthesis: the mix is that clip.
  const lone = byId.size === 1 && !hasOnFrame(0, last);
  const out: AudioMix['clips'] = [];
  for (const [id, group] of byId) {
    let startFrame = Infinity;
    let endFrame = -Infinity;
    for (const clip of group) {
      for (const [frame, volume] of clip.volumes) {
        if (volume <= 0) continue;
        startFrame = Math.min(startFrame, frame);
        endFrame = Math.max(endFrame, frame + 1);
      }
    }
    // A clip that is muted on every frame has no sound to draw.
    if (startFrame > endFrame) continue;
    const own = lone ? pcm : clampPcm(await mix(group));
    const a = Math.min(length, Math.round(startFrame * samplesPerFrame));
    const b = Math.min(length, Math.round(endFrame * samplesPerFrame));
    out.push({ id, startFrame, endFrame, peaks: peaksOf(own.channels, a, b, PEAK_BUCKETS) });
  }
  return {
    wav: encodeWav(pcm),
    sampleRate: pcm.sampleRate,
    seconds: length / pcm.sampleRate,
    peaks: peaksOf(pcm.channels, 0, length, PEAK_BUCKETS),
    clips: out,
  };
}
