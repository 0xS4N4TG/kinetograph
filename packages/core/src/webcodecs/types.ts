// The types of `@remotion/webcodecs`. The browser objects it is written against (`VideoFrame`, `AudioData`, the
// decoders' and encoders' configs) are the little the API names of them; Kinetograph has none of those classes.

import type {
  MediaParserAudioTrack,
  MediaParserContainer,
  MediaParserLogLevel,
  MediaParserVideoTrack,
} from '../media-parser/index.js';

export type ConvertMediaContainer = 'webm' | 'mp4' | 'wav';
export type ConvertMediaVideoCodec = 'vp8' | 'vp9' | 'h264' | 'h265';
export type ConvertMediaAudioCodec = 'opus' | 'aac' | 'wav';

export type ResizeOperation =
  | { mode: 'width'; width: number }
  | { mode: 'height'; height: number }
  | { mode: 'max-height'; maxHeight: number }
  | { mode: 'max-width'; maxWidth: number }
  | { mode: 'max-height-width'; maxHeight: number; maxWidth: number }
  | { mode: 'scale'; scale: number };

export type VideoOperation =
  | { type: 'reencode'; videoCodec: ConvertMediaVideoCodec; rotate?: number; resize?: ResizeOperation | null }
  | { type: 'copy' }
  | { type: 'drop' }
  | { type: 'fail' };

export type AudioOperation =
  | { type: 'reencode'; bitrate: number; audioCodec: ConvertMediaAudioCodec; sampleRate: number | null }
  | { type: 'copy' }
  | { type: 'fail' }
  | { type: 'drop' };

export type ConvertMediaOnVideoTrackHandler = (options: {
  defaultVideoCodec: ConvertMediaVideoCodec | null;
  track: MediaParserVideoTrack;
  logLevel: MediaParserLogLevel;
  outputContainer: ConvertMediaContainer;
  rotate: number;
  resizeOperation: ResizeOperation | null;
  inputContainer: MediaParserContainer;
  canCopyTrack: boolean;
}) => VideoOperation | Promise<VideoOperation>;

export type ConvertMediaOnAudioTrackHandler = (options: {
  track: MediaParserAudioTrack;
  defaultAudioCodec: ConvertMediaAudioCodec | null;
  logLevel: MediaParserLogLevel;
  outputContainer: ConvertMediaContainer;
  inputContainer: MediaParserContainer;
  canCopyTrack: boolean;
}) => AudioOperation | Promise<AudioOperation>;

/** The part of a WebCodecs `VideoFrame` that sizes and times it. */
export interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly rotation?: number;
  close(): void;
}

/** The part of a WebCodecs `AudioData` that describes it. */
export interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly timestamp: number;
  readonly format: string | null;
  close(): void;
}

/** WebCodecs' `VideoDecoderConfig`, `AudioDecoderConfig` and their encoders'. */
export type CodecConfig = { codec: string; [key: string]: unknown };

export type WebCodecsController = {
  abort: (reason?: any) => void;
  pause: () => void;
  resume: () => void;
  addEventListener: import('../media-parser/index.js').MediaParserController['addEventListener'];
  removeEventListener: import('../media-parser/index.js').MediaParserController['removeEventListener'];
  /** Not public API. */
  _internals: { _mediaParserController: import('../media-parser/index.js').MediaParserController };
};

export type ConvertMediaProgress = {
  decodedVideoFrames: number;
  decodedAudioFrames: number;
  encodedVideoFrames: number;
  encodedAudioFrames: number;
  bytesWritten: number;
  millisecondsWritten: number;
  expectedOutputDurationInMs: number | null;
  overallProgress: number | null;
};

export type ConvertMediaResult = {
  save: () => Promise<Blob>;
  remove: () => Promise<void>;
  finalState: ConvertMediaProgress;
};

export type ConvertMediaOnProgress = (state: ConvertMediaProgress) => void;
export type ConvertMediaOnVideoFrame = (options: {
  frame: VideoFrameLike;
  track: MediaParserVideoTrack;
}) => Promise<VideoFrameLike> | VideoFrameLike;
export type ConvertMediaOnAudioData = (options: {
  audioData: AudioDataLike;
  track: MediaParserAudioTrack;
}) => Promise<AudioDataLike> | AudioDataLike;

type Queue = {
  inputItem: (timestamp: number) => void;
  onOutput: (timestamp: number) => void;
  waitForQueueSize: (queueSize: number) => Promise<void>;
  clearQueue: () => void;
};

export type WebCodecsVideoDecoder = {
  decode: (videoSample: object) => Promise<void>;
  close: () => void;
  flush: () => Promise<void>;
  waitForQueueToBeLessThan: (items: number) => Promise<void>;
  reset: () => void;
  checkReset: () => { wasReset: () => boolean };
  getMostRecentSampleInput: () => number | null;
};
export type WebCodecsAudioDecoder = WebCodecsVideoDecoder;

export type WebCodecsVideoEncoder = {
  encode: (videoFrame: VideoFrameLike) => void;
  waitForFinish: () => Promise<void>;
  close: () => void;
  flush: () => Promise<void>;
  ioSynchronizer: Queue;
};
export type WebCodecsAudioEncoder = {
  encode: (audioData: AudioDataLike) => void;
  waitForFinish: () => Promise<void>;
  close: () => void;
  flush: () => Promise<void>;
  ioSynchronizer: Queue;
};

export type ExtractFramesTimestampsInSecondsFn = (options: {
  track: MediaParserVideoTrack;
  container: MediaParserContainer;
  durationInSeconds: number | null;
}) => Promise<number[]> | number[];

export type ExtractFramesProps = {
  src: string;
  timestampsInSeconds: number[] | ExtractFramesTimestampsInSecondsFn;
  onFrame: (frame: VideoFrameLike) => void;
  signal?: AbortSignal;
  acknowledgeRemotionLicense?: boolean;
  logLevel?: MediaParserLogLevel;
};
export type ExtractFrames = (options: ExtractFramesProps) => Promise<void>;

export type GetPartialAudioDataProps = {
  src: string;
  fromSeconds: number;
  toSeconds: number;
  channelIndex: number;
  signal: AbortSignal;
};

export type ConvertAudioDataOptions = {
  audioData: AudioDataLike;
  newSampleRate?: number;
  format?: string | null;
};
