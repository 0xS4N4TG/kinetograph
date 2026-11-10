// @kinetographdev/video-matting: the API of `@remotion/video-matting`, for Node, run natively by the addon (ONNX
// Runtime). `import ... from '@remotion/video-matting'` in a project resolves here (packages/cli/src/bundle.ts).

export { getAvailableModels, videoMattingCacheDir } from './models.js';
export type { AvailableModel, VideoMattingModel } from './models.js';
export { downloadVideoMattingModel, isVideoMattingModelCached, removeVideoMattingModel } from './cache.js';
export type { DownloadProgress, DownloadVideoMattingModelOptions, ModelOptions } from './cache.js';
export { canUseVideoMatting, disposeVideoMattingModel, loadVideoMattingModel } from './loading.js';
export type { CanUseVideoMattingResult, LoadProgress, LoadVideoMattingModelOptions, LoadedVideoMattingModel, VideoMattingUnsupportedReason } from './loading.js';
export { separateVideoLayers } from './layers.js';
export type {
  SeparateVideoLayersOptions,
  SeparateVideoLayersProgress,
  SeparateVideoLayersResult,
  StreamTargetChunk,
  VideoBitrate,
  VideoLayerOutput,
  VideoLayerOutputOptions,
} from './layers.js';
export { VideoMattingError } from './errors.js';
