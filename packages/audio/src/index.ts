// @kinetograph/audio: `onFrame` synthesis, the offline mix and loudness analysis (packages/cli/skills/kinetograph/references/AUTHORING.md §8). Web Audio
// runs on node-web-audio-api's `OfflineAudioContext`, on the CPU.

export { onFrame, clearOnFrame, hasOnFrame } from './registry.js';
export type { AudioContextLike, OnFrameCallback } from './registry.js';
export { joinClips } from './clips.js';
export type { AudioClipTimeline } from './clips.js';
export { renderAudio, clampPcm } from './render.js';
export { shiftPitch } from './pitch.js';
export type { AudioPcm, DecodeAudio } from './render.js';
export { analyzeAudio, integratedLoudness, kWeighting, truePeakDb } from './analyze.js';
export type { AudioAnalysis } from './analyze.js';
