// `@remotion/media-parser` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5): `parseMedia` and its errors, controller and reader/writer
// interfaces. Files are read by FFmpeg through the addon; see parse-media.ts for what that does and does not cover.

import { createAacCodecPrivate } from './aac.js';
import { Log } from './log.js';
import { fieldsNeedSamplesMap, parseMedia } from './parse-media.js';

export { setMediaParserAddon, type MediaParserAddon } from './addon.js';
export { mediaParserController } from './controller.js';
export { hasBeenAborted, IsAnImageError, IsAnUnsupportedFileTypeError, IsAPdfError, MediaParserAbortError } from './errors.js';
export { defaultSelectM3uAssociatedPlaylists, defaultSelectM3uStreamFn } from './select-m3u.js';
export { downloadAndParseMedia, parseMedia } from './parse-media.js';
export type * from './types.js';

/** The version of `@remotion/media-parser` this follows. */
export const VERSION = '4.0.536';
/** Timestamps in tracks are in microseconds. */
export const WEBCODECS_TIMESCALE = 1000000;

/** Not stable in the published package either. Only the parts that do not belong to its byte parser exist here. */
export const MediaParserInternals = {
  Log,
  createAacCodecPrivate,
  internalParseMedia: parseMedia,
  fieldsNeedSamplesMap,
};
