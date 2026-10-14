// @kinetograph/audio: `onFrame` synthesis, the offline mix and loudness
// analysis (docs/AUTHORING.md §8).
//
// Orchestrator scaffolding: names and signatures are the contract. Stream 5
// (`feat/cli-audio-mcp`) implements them on `node-web-audio-api` and types
// `ctx` as its `OfflineAudioContext`.

import type { AudioClipJson } from '@kinetograph/scene';

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name} (@kinetograph/audio, stream 5)`);
}

/** A Web Audio `OfflineAudioContext` (node-web-audio-api's). */
export type AudioContextLike = unknown;
export type OnFrameCallback = (ctx: AudioContextLike, time: number) => void;

/** Registers synthesis to start at `frame` (absolute). Call at module level. */
export function onFrame(frame: number, callback: OnFrameCallback): void {
  notImplemented(`onFrame(${frame}, ${callback.name})`);
}

export function clearOnFrame(): void {
  notImplemented('clearOnFrame');
}

export interface AudioPcm {
  sampleRate: number;
  /** One array per channel, equal lengths, samples in -1..1. */
  channels: Float32Array[];
}

export interface AudioClipTimeline extends Omit<AudioClipJson, 'volume'> {
  /** frame → volume */
  volumes: Map<number, number>;
}

export function joinClips(frames: { frame: number; audio: AudioClipJson[] }[]): AudioClipTimeline[] {
  return notImplemented(`joinClips(${frames.length} frames)`);
}

export function renderAudio(options: {
  fps: number;
  first: number;
  last: number;
  sampleRate?: number;
  clips: AudioClipTimeline[];
  baseDir?: string;
}): Promise<AudioPcm> {
  return notImplemented(`renderAudio(${options.first}..=${options.last})`);
}

export interface AudioAnalysis {
  integratedLufs: number;
  truePeakDb: number;
  clippedSamples: number;
  /** Seconds, below -60 dBFS for at least 0.5 s. */
  silences: { start: number; end: number }[];
  scenes?: { from: number; to: number; integratedLufs: number; truePeakDb: number }[];
}

export function analyzeAudio(
  pcm: AudioPcm,
  options?: { scenes?: [number, number][] },
): AudioAnalysis {
  return notImplemented(`analyzeAudio(${pcm.channels.length} channels, ${JSON.stringify(options)})`);
}
