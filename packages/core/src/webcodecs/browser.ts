// The parts of `@remotion/webcodecs` that are thin wrappers over the browser's WebCodecs classes (`VideoDecoder`,
// `AudioEncoder`, ...) and over frames and audio data. They are exported, so a project that mentions them bundles, and
// each throws `UnsupportedApiError` when called: Kinetograph has no browser, and its addon decodes video inside the
// renderer and returns no pictures to JavaScript (docs/AUTHORING.md §7.5).

import { UnsupportedApiError } from '../unsupported.js';
import type {
  AudioDataLike,
  CodecConfig,
  ConvertAudioDataOptions,
  ExtractFrames,
  VideoFrameLike,
  WebCodecsAudioDecoder,
  WebCodecsAudioEncoder,
  WebCodecsController,
  WebCodecsVideoDecoder,
  WebCodecsVideoEncoder,
} from './types.js';
import type { ConvertMediaAudioCodec, ConvertMediaVideoCodec } from './types.js';
import type { MediaParserLogLevel } from '../media-parser/index.js';

const unsupported = (api: string, what: string) => new UnsupportedApiError('@remotion/webcodecs', `${api}()`, `${what} does not exist here`);

export async function createVideoDecoder(_options: {
  track: CodecConfig;
  onFrame: (frame: VideoFrameLike) => void | Promise<void>;
  onError: (error: Error) => void;
  controller?: WebCodecsController | undefined;
  logLevel?: MediaParserLogLevel | undefined;
}): Promise<WebCodecsVideoDecoder> {
  throw unsupported('createVideoDecoder', 'the browser\'s VideoDecoder');
}

export async function createAudioDecoder(_options: {
  track: CodecConfig;
  onFrame: (frame: AudioDataLike) => void | Promise<void>;
  onError: (error: Error) => void;
  controller?: WebCodecsController | null | undefined;
  logLevel?: MediaParserLogLevel | undefined;
}): Promise<WebCodecsAudioDecoder> {
  throw unsupported('createAudioDecoder', 'the browser\'s AudioDecoder');
}

export function createVideoEncoder(_options: {
  onChunk: (chunk: object, metadata: object | null) => Promise<void>;
  onError: (error: Error) => void;
  controller: WebCodecsController;
  config: CodecConfig;
  logLevel: MediaParserLogLevel;
  outputCodec: ConvertMediaVideoCodec;
  keyframeInterval: number;
}): WebCodecsVideoEncoder {
  throw unsupported('createVideoEncoder', 'the browser\'s VideoEncoder');
}

export function createAudioEncoder(_options: {
  onChunk: (chunk: object) => Promise<void>;
  onError: (error: Error) => void;
  codec: ConvertMediaAudioCodec;
  controller: WebCodecsController;
  config: CodecConfig;
  logLevel: MediaParserLogLevel;
  onNewAudioSampleRate: (sampleRate: number) => void;
}): WebCodecsAudioEncoder {
  throw unsupported('createAudioEncoder', 'the browser\'s AudioEncoder');
}

export function convertAudioData(_options: ConvertAudioDataOptions): AudioDataLike {
  throw unsupported('convertAudioData', 'the browser\'s AudioData class');
}

/** Frames of a video as WebCodecs `VideoFrame`s; the addon decodes pictures only inside the renderer. */
export const extractFrames: ExtractFrames = async () => {
  throw unsupported('extractFrames', 'a decoder that returns video pictures to JavaScript');
};

/** `extractFrames` in a Web Worker (the `/worker` subpath). */
export const extractFramesOnWebWorker: ExtractFrames = async () => {
  throw unsupported('extractFramesOnWebWorker', 'a decoder that returns video pictures to JavaScript');
};
