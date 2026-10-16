// What `@remotion/webcodecs` decides about tracks before it touches a pixel or a sample: which containers and codecs
// it offers, whether a track can be copied or re-encoded, how rotating and resizing changes a size, and the default
// choice for each track. All of it is logic, and checked against the published package (test/fixtures/webcodecs.json).
//
// Whether a track can be re-encoded is the one answer that depends on the machine, and the machine here has no
// WebCodecs: the only re-encoding Kinetograph does is audio to WAV (`convertMedia`), so that is the only `true`.

import { Log } from '../media-parser/log.js';
import type {
  MediaParserAudioCodec,
  MediaParserAudioTrack,
  MediaParserContainer,
  MediaParserVideoCodec,
  MediaParserVideoTrack,
} from '../media-parser/index.js';
import { UnsupportedApiError } from '../unsupported.js';
import type {
  ConvertMediaAudioCodec,
  ConvertMediaContainer,
  ConvertMediaOnAudioTrackHandler,
  ConvertMediaOnVideoTrackHandler,
  ConvertMediaVideoCodec,
  ResizeOperation,
  VideoFrameLike,
} from './types.js';

// ---- what is on offer ----

export const availableContainers = ['webm', 'mp4', 'wav'] as const;
export const availableVideoCodecs = ['vp8', 'vp9', 'h264', 'h265'] as const;

export const getAvailableContainers = (): readonly ConvertMediaContainer[] => availableContainers;

export function getAvailableVideoCodecs({ container }: { container: ConvertMediaContainer }): ConvertMediaVideoCodec[] {
  if (container === 'mp4') return ['h264', 'h265'];
  if (container === 'webm') return ['vp8', 'vp9'];
  if (container === 'wav') return [];
  throw new Error(`Unsupported container: ${container}`);
}

export function getAvailableAudioCodecs({ container }: { container: ConvertMediaContainer }): ConvertMediaAudioCodec[] {
  if (container === 'mp4') return ['aac'];
  if (container === 'webm') return ['opus'];
  if (container === 'wav') return ['wav'];
  throw new Error(`Unsupported container: ${container}`);
}

export function getDefaultVideoCodec({ container }: { container: ConvertMediaContainer }): ConvertMediaVideoCodec | null {
  if (container === 'webm') return 'vp8';
  if (container === 'mp4') return 'h264';
  if (container === 'wav') return null;
  throw new Error(`Unhandled container: ${container}`);
}

export function getDefaultAudioCodec({ container }: { container: ConvertMediaContainer }): ConvertMediaAudioCodec {
  if (container === 'webm') return 'opus';
  if (container === 'mp4') return 'aac';
  if (container === 'wav') return 'wav';
  throw new Error(`Unhandled container: ${container}`);
}

// ---- rotation and size ----

export const normalizeVideoRotation = (rotation: number): number => ((rotation % 360) + 360) % 360;

/** The size after turning by `rotation`: a quarter turn swaps width and height. */
export function calculateNewDimensionsFromRotate({
  height,
  width,
  rotation,
}: {
  height: number;
  width: number;
  rotation: number;
}): { height: number; width: number } {
  const normalized = normalizeVideoRotation(rotation);
  const swap = normalized % 90 === 0 && normalized % 180 !== 0;
  return { height: swap ? width : height, width: swap ? height : width };
}

const evenSizes = (size: { width: number; height: number }, needsToBeMultipleOfTwo: boolean | undefined) =>
  needsToBeMultipleOfTwo
    ? { width: Math.floor(size.width / 2) * 2, height: Math.floor(size.height / 2) * 2 }
    : size;

/** The size after a `ResizeOperation` (none keeps it), rounded down to even numbers for codecs that need them. */
export function calculateNewSizeAfterResizing({
  dimensions,
  resizeOperation,
  needsToBeMultipleOfTwo,
}: {
  dimensions: { width: number; height: number };
  resizeOperation: ResizeOperation | null;
  needsToBeMultipleOfTwo?: boolean | undefined;
}): { width: number; height: number } {
  const { width, height } = dimensions;
  const of = (size: { width: number; height: number }) => evenSizes(size, needsToBeMultipleOfTwo);
  if (resizeOperation === null) return of(dimensions);
  switch (resizeOperation.mode) {
    case 'width':
      return of({ width: resizeOperation.width, height: Math.round((resizeOperation.width / width) * height) });
    case 'height':
      return of({ width: Math.round((resizeOperation.height / height) * width), height: resizeOperation.height });
    case 'max-height': {
      const newHeight = Math.min(height, resizeOperation.maxHeight);
      return of({ width: Math.round((newHeight / height) * width), height: newHeight });
    }
    case 'max-width': {
      const newWidth = Math.min(width, resizeOperation.maxWidth);
      return of({ width: newWidth, height: Math.round((newWidth / width) * height) });
    }
    case 'max-height-width': {
      const scale = Math.min(
        Math.min(width, resizeOperation.maxWidth) / width,
        Math.min(height, resizeOperation.maxHeight) / height,
      );
      return of({ width: Math.round(width * scale), height: Math.round(height * scale) });
    }
    case 'scale':
      if (resizeOperation.scale <= 0) throw new Error('Scale must be greater than 0');
      return of({ width: Math.round(width * resizeOperation.scale), height: Math.round(height * resizeOperation.scale) });
    default:
      throw new Error('Invalid resizing mode ' + String(resizeOperation));
  }
}

export function calculateNewDimensionsFromRotateAndScale({
  width,
  height,
  rotation,
  resizeOperation,
  needsToBeMultipleOfTwo,
}: {
  width: number;
  height: number;
  rotation: number;
  resizeOperation: ResizeOperation | null;
  needsToBeMultipleOfTwo?: boolean | undefined;
}): { width: number; height: number } {
  return calculateNewSizeAfterResizing({
    dimensions: calculateNewDimensionsFromRotate({ height, width, rotation }),
    resizeOperation,
    needsToBeMultipleOfTwo,
  });
}

/**
 * `frame` turned by `rotation` (a multiple of 90 degrees) and resized. A frame that would come out as it is, is
 * returned as it is; drawing a new one needs `OffscreenCanvas` and a `VideoFrame` class to wrap the result in.
 */
export function rotateAndResizeVideoFrame({
  frame,
  rotation,
  needsToBeMultipleOfTwo = false,
  resizeOperation,
}: {
  frame: VideoFrameLike;
  rotation: number;
  resizeOperation: ResizeOperation | null;
  needsToBeMultipleOfTwo?: boolean | undefined;
}): VideoFrameLike {
  const normalized = normalizeVideoRotation(rotation);
  const mustProcess = 'rotation' in frame && frame.rotation !== 0;
  if (normalized === 0 && resizeOperation === null && !mustProcess) return frame;
  if (normalized % 90 !== 0) throw new Error('Only 90 degree rotations are supported');
  const size = calculateNewDimensionsFromRotateAndScale({
    height: frame.displayHeight,
    width: frame.displayWidth,
    rotation,
    needsToBeMultipleOfTwo,
    resizeOperation,
  });
  if (normalized === 0 && size.height === frame.displayHeight && size.width === frame.displayWidth && !mustProcess) {
    return frame;
  }
  throw new UnsupportedApiError(
    '@remotion/webcodecs',
    'rotateAndResizeVideoFrame() for a frame that changes',
    'there is no VideoFrame class to build the new frame with',
  );
}

// ---- copying a track as it is ----

const isSameVideoCodec = (input: MediaParserVideoCodec, output: ConvertMediaVideoCodec): boolean => {
  if (output === 'h264' || output === 'h265' || output === 'vp8' || output === 'vp9') return input === output;
  throw new Error(`Unsupported output codec: ${String(output)}`);
};

const isSameAudioCodec = (input: MediaParserAudioCodec, output: ConvertMediaAudioCodec): boolean => {
  if (output === 'aac' || output === 'opus') return input === output;
  if (output === 'wav') return input === 'pcm-f32' || input === 'pcm-s16' || input === 'pcm-s24' || input === 'pcm-s32' || input === 'pcm-u8';
  throw new Error(`Unsupported output codec: ${String(output)}`);
};

export function canCopyAudioTrack({
  inputCodec,
  outputContainer,
  inputContainer,
  outputAudioCodec,
}: {
  inputCodec: MediaParserAudioCodec;
  outputContainer: ConvertMediaContainer;
  inputContainer: MediaParserContainer;
  outputAudioCodec: ConvertMediaAudioCodec | null;
}): boolean {
  if (outputAudioCodec && !isSameAudioCodec(inputCodec, outputAudioCodec)) return false;
  if (outputContainer === 'webm') return inputCodec === 'opus';
  if (outputContainer === 'mp4') {
    return inputCodec === 'aac' && (inputContainer === 'mp4' || inputContainer === 'avi' || inputContainer === 'm3u8');
  }
  if (outputContainer === 'wav') return false;
  throw new Error(`Unhandled container: ${String(outputContainer)}`);
}

export function canCopyVideoTrack({
  outputContainer,
  rotationToApply,
  inputContainer,
  resizeOperation,
  inputTrack,
  outputVideoCodec,
}: {
  inputContainer: MediaParserContainer;
  inputTrack: MediaParserVideoTrack;
  rotationToApply: number;
  outputContainer: ConvertMediaContainer;
  outputVideoCodec: ConvertMediaVideoCodec | null;
  resizeOperation: ResizeOperation | null;
}): boolean {
  if (normalizeVideoRotation(inputTrack.rotation) !== normalizeVideoRotation(rotationToApply)) return false;
  if (outputVideoCodec && !isSameVideoCodec(inputTrack.codecEnum, outputVideoCodec)) return false;
  const size = calculateNewDimensionsFromRotateAndScale({
    height: inputTrack.height,
    resizeOperation,
    rotation: rotationToApply,
    width: inputTrack.width,
    needsToBeMultipleOfTwo: inputTrack.codecEnum === 'h264',
  });
  if (size.height !== inputTrack.height || size.width !== inputTrack.width) return false;
  if (outputContainer === 'webm') return inputTrack.codecEnum === 'vp8' || inputTrack.codecEnum === 'vp9';
  if (outputContainer === 'mp4') {
    return (
      (inputTrack.codecEnum === 'h264' || inputTrack.codecEnum === 'h265') &&
      (inputContainer === 'mp4' || inputContainer === 'avi' || (inputContainer === 'm3u8' && inputTrack.m3uStreamFormat === 'mp4'))
    );
  }
  if (outputContainer === 'wav') return false;
  throw new Error(`Unhandled codec: ${String(outputContainer)}`);
}

// ---- re-encoding a track ----

/** Only WAV: `convertMedia` decodes a track's sound with the addon and writes it as PCM. */
export async function canReencodeAudioTrack({
  audioCodec,
}: {
  track: MediaParserAudioTrack;
  audioCodec: ConvertMediaAudioCodec;
  bitrate: number;
  sampleRate: number | null;
}): Promise<boolean> {
  return audioCodec === 'wav';
}

/** Never: there are no video encoders and decoders to hand pictures through. */
export async function canReencodeVideoTrack(_options: {
  videoCodec: ConvertMediaVideoCodec;
  track: MediaParserVideoTrack;
  resizeOperation: ResizeOperation | null;
  rotate: number | null;
}): Promise<boolean> {
  return false;
}

// ---- the choice for each track ----

const DEFAULT_BITRATE = 128000;

export const defaultOnAudioTrackHandler: ConvertMediaOnAudioTrackHandler = async ({
  track,
  defaultAudioCodec,
  logLevel,
  canCopyTrack,
}) => {
  if (canCopyTrack) {
    Log.verbose(logLevel, `Track ${track.trackId} (audio): Can copy track, therefore copying`);
    return { type: 'copy' };
  }
  // A container that has no sound (a GIF's) has no default codec.
  if (defaultAudioCodec === null) {
    Log.verbose(logLevel, `Track ${track.trackId} (audio): Container does not support audio, dropping audio`);
    return { type: 'drop' };
  }
  if (await canReencodeAudioTrack({ audioCodec: defaultAudioCodec, track, bitrate: DEFAULT_BITRATE, sampleRate: null })) {
    Log.verbose(logLevel, `Track ${track.trackId} (audio): Cannot copy, but re-encode, therefore re-encoding`);
    return { type: 'reencode', bitrate: DEFAULT_BITRATE, audioCodec: defaultAudioCodec, sampleRate: null };
  }
  Log.verbose(logLevel, `Track ${track.trackId} (audio): Can neither re-encode nor copy, failing render`);
  return { type: 'fail' };
};

export const defaultOnVideoTrackHandler: ConvertMediaOnVideoTrackHandler = async ({
  track,
  defaultVideoCodec,
  logLevel,
  rotate,
  canCopyTrack,
  resizeOperation,
}) => {
  if (canCopyTrack) {
    Log.verbose(logLevel, `Track ${track.trackId} (video): Can copy, therefore copying`);
    return { type: 'copy' };
  }
  if (defaultVideoCodec === null) {
    Log.verbose(logLevel, `Track ${track.trackId} (video): Is audio container, therefore dropping video`);
    return { type: 'drop' };
  }
  if (await canReencodeVideoTrack({ videoCodec: defaultVideoCodec, track, resizeOperation, rotate })) {
    Log.verbose(logLevel, `Track ${track.trackId} (video): Cannot copy, but re-enconde, therefore re-encoding`);
    // Re-encoding removes the rotation by default.
    return { type: 'reencode', videoCodec: defaultVideoCodec, rotate: undefined, resize: resizeOperation };
  }
  Log.verbose(logLevel, `Track ${track.trackId} (video): Can neither copy nor re-encode, therefore failing`);
  return { type: 'fail' };
};
