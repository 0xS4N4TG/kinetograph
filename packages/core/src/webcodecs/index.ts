// `@remotion/webcodecs` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5): media conversion, whose browser half (WebCodecs decoders and encoders,
// frames) is exported and throws `UnsupportedApiError`. What works: the lists of containers and codecs, whether a track
// can be copied or re-encoded, the default handlers, `getPartialAudioData`, and `convertMedia` to WAV.

import { mediaParserController } from '../media-parser/index.js';
import { normalizeVideoRotation, rotateAndResizeVideoFrame } from './tracks.js';
import type { WebCodecsController } from './types.js';

export { AudioUndecodableError, VideoUndecodableError } from './errors.js';
export { convertMedia, getPartialAudioData } from './convert-media.js';
export {
  canCopyAudioTrack,
  canCopyVideoTrack,
  canReencodeAudioTrack,
  canReencodeVideoTrack,
  defaultOnAudioTrackHandler,
  defaultOnVideoTrackHandler,
  getAvailableAudioCodecs,
  getAvailableContainers,
  getAvailableVideoCodecs,
  getDefaultAudioCodec,
  getDefaultVideoCodec,
  rotateAndResizeVideoFrame,
} from './tracks.js';
export {
  convertAudioData,
  createAudioDecoder,
  createAudioEncoder,
  createVideoDecoder,
  createVideoEncoder,
  extractFrames,
} from './browser.js';
export type * from './types.js';

/** A controller to `abort`, `pause` and `resume` a conversion with. */
export const webcodecsController = (): WebCodecsController => {
  const controller = mediaParserController();
  return {
    abort: controller.abort,
    pause: controller.pause,
    resume: controller.resume,
    addEventListener: controller.addEventListener,
    removeEventListener: controller.removeEventListener,
    _internals: { _mediaParserController: controller },
  };
};

/** Not stable in the published package either. */
export const WebCodecsInternals = { rotateAndResizeVideoFrame, normalizeVideoRotation };
