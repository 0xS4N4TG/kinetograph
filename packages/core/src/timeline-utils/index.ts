// `@remotion/timeline-utils` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5): the utilities the Studio's timeline is drawn with. The audio
// waveform and the pure helpers work; the frame strip works from frames in the cache, and what needs pictures decoded
// to WebCodecs frames throws `UnsupportedApiError` (frame-strip.ts).

export type { AudioWaveformWorkerIncomingMessage, AudioWaveformWorkerOutgoingMessage } from './types.js';
export {
  TARGET_SAMPLE_RATE,
  createWaveformPeakProcessor,
  drawBars,
  emitWaveformProgress,
  getVisibleWaveformVolume,
  loadWaveformPeaks,
  sliceVisibleWaveformPeaks,
  sliceWaveformPeaks,
  subscribeToWaveformPeaks,
  type WaveformDrawRange,
  type WaveformVolume,
} from './waveform.js';
export {
  clampTimestampsToDuration,
  formatAverageAudioVolume,
  getDevicePixelAlignedCanvasLayout,
  getLoopDisplaySegments,
  getLoopDisplayWidth,
  shouldTileLoopDisplay,
  snapCanvasPositionToDevicePixel,
  type LoopDisplaySegment,
  type TimelineLoopDisplay,
} from './layout.js';
export {
  WEBCODECS_TIMESCALE,
  addFrameToCache,
  aspectRatioCache,
  calculateTimestampSlots,
  drawSlot,
  ensureSlots,
  extractFrames,
  fillFrameWhereItFits,
  fillWithCachedFrames,
  frameDatabase,
  getAspectRatioFromCache,
  getDurationOfOneFrame,
  getFrameDatabaseKeyPrefix,
  getTimestampFromFrameDatabaseKey,
  makeFrameDatabaseKey,
  renderFrameStripToCanvas,
  resizeVideoFrame,
  type ExtractFramesProps,
  type ExtractFramesTimestampsInSecondsFn,
  type FrameDatabaseKey,
  type RenderFrameStripToCanvasOptions,
} from './frame-strip.js';
