// The types of `@remotion/media-parser`: the tracks and fields `parseMedia` answers with, its options and callbacks, and
// the readers and writers around it. They have the shapes of the published package's; the ones for parts Kinetograph
// does not have (the box tree of `slowStructure`, seeking hints, M3U playlists) are as loose as they can be.

export type MediaParserLogLevel = 'trace' | 'verbose' | 'info' | 'warn' | 'error';

export type MediaParserVideoCodec = 'vp8' | 'vp9' | 'h264' | 'av1' | 'h265' | 'prores';
export type MediaParserAudioCodec =
  | 'opus'
  | 'aac'
  | 'mp3'
  | 'ac3'
  | 'vorbis'
  | 'pcm-u8'
  | 'pcm-s16'
  | 'pcm-s24'
  | 'pcm-s32'
  | 'pcm-f32'
  | 'flac'
  | 'aiff';
export type KnownAudioCodecs = 'aac' | 'mp3' | 'aiff' | 'opus' | 'pcm' | 'vorbis' | 'unknown';
export type MediaParserContainer = 'mp4' | 'webm' | 'avi' | 'transport-stream' | 'mp3' | 'aac' | 'flac' | 'm3u8' | 'wav';

export type MediaParserMatrixCoefficients = 'rgb' | 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020-ncl';
export type MediaParserTransferCharacteristics = 'bt709' | 'smpte170m' | 'iec61966-2-1' | 'linear' | 'pq' | 'hlg';
export type MediaParserPrimaries = 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020' | 'smpte432' | null;

export type MediaParserAdvancedColor = {
  transfer: MediaParserTransferCharacteristics | null;
  matrix: MediaParserMatrixCoefficients | null;
  primaries: MediaParserPrimaries | null;
  fullRange: boolean | null;
};

export type MediaParserSampleAspectRatio = { numerator: number; denominator: number };

export type MediaParserCodecData =
  | { type: 'avc-sps-pps'; data: Uint8Array }
  | { type: 'hvcc-data'; data: Uint8Array }
  | { type: 'av1c-data'; data: Uint8Array }
  | { type: 'aac-config'; data: Uint8Array }
  | { type: 'flac-description'; data: Uint8Array }
  | { type: 'ogg-identification'; data: Uint8Array }
  | { type: 'unknown-data'; data: Uint8Array };

export type MediaParserVideoTrack = {
  codec: string;
  description: Uint8Array | undefined;
  /** WebCodecs' `VideoColorSpaceInit`. */
  colorSpace: {
    primaries?: string | null;
    transfer?: string | null;
    matrix?: string | null;
    fullRange?: boolean | null;
  };
  codedWidth: number;
  codedHeight: number;
  displayAspectWidth: number;
  displayAspectHeight: number;
  type: 'video';
  trackId: number;
  codecEnum: MediaParserVideoCodec;
  codecData: MediaParserCodecData | null;
  sampleAspectRatio: MediaParserSampleAspectRatio;
  width: number;
  height: number;
  rotation: number;
  fps: number | null;
  timescale: 1000000;
  originalTimescale: number;
  advancedColor: MediaParserAdvancedColor;
  m3uStreamFormat: 'ts' | 'mp4' | null;
  startInSeconds: number;
  trackMediaTimeOffsetInTrackTimescale: number;
};

export type MediaParserAudioTrack = {
  codec: string;
  sampleRate: number;
  description: Uint8Array | undefined;
  numberOfChannels: number;
  type: 'audio';
  trackId: number;
  codecEnum: MediaParserAudioCodec;
  timescale: 1000000;
  originalTimescale: number;
  codecData: MediaParserCodecData | null;
  startInSeconds: number;
  trackMediaTimeOffsetInTrackTimescale: number;
};

export type MediaParserOtherTrack = {
  type: 'other';
  trackId: number;
  timescale: 1000000;
  originalTimescale: number;
  /** The published package puts the track's `trak` box here; there are no boxes here. */
  trakBox: null;
  startInSeconds: number;
  trackMediaTimeOffsetInTrackTimescale: number;
};

export type MediaParserTrack = MediaParserVideoTrack | MediaParserAudioTrack | MediaParserOtherTrack;

export type MediaParserDimensions = { width: number; height: number };
export type MediaParserLocation = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  horizontalAccuracy: number | null;
};

export type MediaParserKeyframe = {
  positionInBytes: number;
  sizeInBytes: number;
  presentationTimeInSeconds: number;
  decodingTimeInSeconds: number;
  trackId: number;
};

export type MediaParserMetadataEntry = { key: string; value: string | number; trackId: number | null };
export type MediaParserEmbeddedImage = { description: string | null; mimeType: string | null; data: Uint8Array };
export type InternalStats = { skippedBytes: number; finalCursorOffset: number };

export type M3uAssociatedPlaylist = {
  groupId: string;
  language: string | null;
  name: string | null;
  autoselect: boolean;
  default: boolean;
  channels: number | null;
  src: string;
  id: number;
  isAudio: boolean;
};
export type M3uStream = {
  src: string;
  bandwidthInBitsPerSec: number | null;
  averageBandwidthInBitsPerSec: number | null;
  dimensions: MediaParserDimensions | null;
  codecs: string[] | null;
  id: number;
  associatedPlaylists: M3uAssociatedPlaylist[];
};
export type M3uPlaylistContext = { mp4HeaderSegment: unknown; isLastChunkInPlaylist: boolean };

/** The box tree of the published parser. Not built here: asking for `slowStructure` throws. */
export type MediaParserStructureUnstable = { type: string; boxes?: unknown[] };

/** The published package's `SamplePosition`: where a sample of an MP4 is and when it plays. */
export type SamplePosition = {
  offset: number;
  size: number;
  isKeyframe: boolean;
  decodingTimestamp: number;
  timestamp: number;
  duration: number;
  chunk: number;
  bigEndian: boolean;
  chunkSize: number | null;
};

// ---- fields and results ----

export type ParseMediaFields = {
  dimensions: boolean;
  durationInSeconds: boolean;
  slowDurationInSeconds: boolean;
  slowStructure: boolean;
  fps: boolean;
  slowFps: boolean;
  videoCodec: boolean;
  audioCodec: boolean;
  tracks: boolean;
  rotation: boolean;
  unrotatedDimensions: boolean;
  internalStats: boolean;
  size: boolean;
  name: boolean;
  container: boolean;
  isHdr: boolean;
  metadata: boolean;
  location: boolean;
  mimeType: boolean;
  keyframes: boolean;
  slowKeyframes: boolean;
  slowNumberOfFrames: boolean;
  slowVideoBitrate: boolean;
  slowAudioBitrate: boolean;
  images: boolean;
  sampleRate: boolean;
  numberOfAudioChannels: boolean;
  m3uStreams: boolean;
};

export type Options<Fields extends ParseMediaFields> = Partial<{ [K in keyof ParseMediaFields]: Fields[K] }>;
export type AllOptions<Fields extends ParseMediaFields> = { [K in keyof ParseMediaFields]: Fields[K] };

export interface ParseMediaData {
  dimensions: MediaParserDimensions | null;
  durationInSeconds: number | null;
  slowDurationInSeconds: number;
  slowFps: number;
  slowStructure: MediaParserStructureUnstable;
  fps: number | null;
  videoCodec: MediaParserVideoCodec | null;
  audioCodec: MediaParserAudioCodec | null;
  tracks: MediaParserTrack[];
  rotation: number | null;
  unrotatedDimensions: MediaParserDimensions | null;
  isHdr: boolean;
  internalStats: InternalStats;
  size: number | null;
  name: string;
  metadata: MediaParserMetadataEntry[];
  location: MediaParserLocation | null;
  container: MediaParserContainer;
  mimeType: string | null;
  keyframes: MediaParserKeyframe[] | null;
  slowKeyframes: MediaParserKeyframe[];
  slowNumberOfFrames: number;
  images: MediaParserEmbeddedImage[];
  sampleRate: number | null;
  numberOfAudioChannels: number | null;
  slowVideoBitrate: number | null;
  slowAudioBitrate: number | null;
  m3uStreams: M3uStream[] | null;
}

export type ParseMediaResult<T extends Partial<ParseMediaFields>> = {} extends T
  ? Record<never, never>
  : { [K in keyof T]: T[K] extends true ? (K extends keyof ParseMediaData ? ParseMediaData[K] : never) : never };

type Callback<T> = null | ((value: T) => unknown | Promise<unknown>);

export type ParseMediaCallbacksMandatory = {
  onDimensions: Callback<MediaParserDimensions | null>;
  onDurationInSeconds: Callback<number | null>;
  onSlowDurationInSeconds: Callback<number>;
  onSlowFps: Callback<number>;
  onSlowStructure: Callback<MediaParserStructureUnstable>;
  onFps: Callback<number | null>;
  onVideoCodec: Callback<MediaParserVideoCodec | null>;
  onAudioCodec: Callback<MediaParserAudioCodec | null>;
  onTracks: Callback<MediaParserTrack[]>;
  onRotation: Callback<number | null>;
  onUnrotatedDimensions: Callback<MediaParserDimensions | null>;
  onInternalStats: Callback<InternalStats>;
  onSize: Callback<number | null>;
  onName: Callback<string>;
  onContainer: Callback<MediaParserContainer>;
  onIsHdr: Callback<boolean>;
  onMetadata: Callback<MediaParserMetadataEntry[]>;
  onLocation: Callback<MediaParserLocation | null>;
  onMimeType: Callback<string | null>;
  onKeyframes: Callback<MediaParserKeyframe[] | null>;
  onSlowKeyframes: Callback<MediaParserKeyframe[]>;
  onSlowNumberOfFrames: Callback<number>;
  onImages: Callback<MediaParserEmbeddedImage[]>;
  onSampleRate: Callback<number | null>;
  onNumberOfAudioChannels: Callback<number | null>;
  onSlowVideoBitrate: Callback<number | null>;
  onSlowAudioBitrate: Callback<number | null>;
  onM3uStreams: Callback<M3uStream[] | null>;
};
export type ParseMediaCallbacks = Partial<ParseMediaCallbacksMandatory>;

// ---- samples: parseMedia can hand the encoded samples of a track to a callback in the published package ----

export type MediaParserAudioSample = {
  data: Uint8Array;
  timestamp: number;
  duration: number | undefined;
  type: 'key' | 'delta';
  decodingTimestamp: number;
  offset: number;
};
export type MediaParserVideoSample = {
  data: Uint8Array;
  timestamp: number;
  type: 'key' | 'delta';
  duration: number | undefined;
  decodingTimestamp: number;
  offset: number;
  avc?:
    | { type: 'keyframe'; poc: number | null }
    | { type: 'delta-frame'; isBidirectionalFrame: boolean; poc: number | null };
};
type OnTrackDoneCallback = () => void | Promise<void>;
export type MediaParserOnAudioSample = (
  sample: MediaParserAudioSample,
) => void | Promise<OnTrackDoneCallback | void> | OnTrackDoneCallback;
export type MediaParserOnVideoSample = (
  sample: MediaParserVideoSample,
) => void | Promise<OnTrackDoneCallback | void> | OnTrackDoneCallback;
export type MediaParserOnAudioTrackParams = { track: MediaParserAudioTrack; container: MediaParserContainer };
export type MediaParserOnVideoTrackParams = { track: MediaParserVideoTrack; container: MediaParserContainer };
export type MediaParserOnAudioTrack = (
  options: MediaParserOnAudioTrackParams,
) => MediaParserOnAudioSample | Promise<MediaParserOnAudioSample | null> | null;
export type MediaParserOnVideoTrack = (
  options: MediaParserOnVideoTrackParams,
) => MediaParserOnVideoSample | Promise<MediaParserOnVideoSample | null> | null;

// ---- readers and writers ----

export type ParseMediaSrc = string | Blob | URL;
export type ParseMediaRange = [number, number] | number | null;

export type Reader = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: () => Promise<void>;
};

type ReadResult = {
  reader: Reader;
  contentLength: number | null;
  contentType: string | null;
  name: string;
  supportsContentRange: boolean;
  needsContentRange: boolean;
};

export type MediaParserReaderInterface = {
  read: (options: {
    src: ParseMediaSrc;
    range: ParseMediaRange;
    controller: MediaParserController;
    logLevel: MediaParserLogLevel;
    prefetchCache: Map<string, unknown>;
  }) => Promise<ReadResult>;
  readWholeAsText: (src: ParseMediaSrc) => Promise<string>;
  createAdjacentFileSource: (relativePath: string, src: ParseMediaSrc) => string;
  preload: (options: {
    src: ParseMediaSrc;
    range: ParseMediaRange;
    logLevel: MediaParserLogLevel;
    prefetchCache: Map<string, unknown>;
  }) => void;
};

export type Writer = {
  write: (arr: Uint8Array) => Promise<void>;
  finish: () => Promise<void>;
  getWrittenByteCount: () => number;
  updateDataAt: (position: number, data: Uint8Array) => Promise<void>;
  remove: () => Promise<void>;
  getBlob: () => Promise<Blob>;
};
export type CreateContent = (options: {
  filename: string;
  mimeType: string;
  logLevel: MediaParserLogLevel;
}) => Promise<Writer>;
export type WriterInterface = { createContent: CreateContent };

// ---- the controller ----

type EventMap = {
  pause: undefined;
  resume: undefined;
  abort: { reason?: unknown };
  seek: { seek: number };
};
export type MediaParserEventTypes = keyof EventMap;
export type CallbackListener<T extends MediaParserEventTypes> = (data: { detail: EventMap[T] }) => void;

export type MediaParserController = {
  abort: (reason?: any) => void;
  pause: () => void;
  resume: () => void;
  seek: (timeInSeconds: number) => void;
  simulateSeek: (seekInSeconds: number) => Promise<unknown>;
  addEventListener: <Q extends MediaParserEventTypes>(name: Q, callback: CallbackListener<Q>) => void;
  removeEventListener: <Q extends MediaParserEventTypes>(name: Q, callback: CallbackListener<Q>) => void;
  getSeekingHints: () => Promise<SeekingHints | null>;
  /** Not public API. */
  _internals: {
    signal: AbortSignal;
    checkForAbortAndPause: () => Promise<void>;
    markAsReadyToEmitEvents: () => void;
  };
};

/** The published package's hints for seeking without parsing again; Kinetograph never makes them. */
export type SeekingHints = { type: string };

// ---- options ----

export type ContinueAfterError = { action: 'fail' } | { action: 'download' };
export type ParseMediaOnError = (error: Error) => ContinueAfterError | Promise<ContinueAfterError>;
export type ParseMediaProgress = { bytes: number; percentage: number | null; totalBytes: number | null };
export type ParseMediaOnProgress = (progress: ParseMediaProgress) => void | Promise<void>;

export type SelectM3uStreamFn = (options: { streams: M3uStream[] }) => number | Promise<number>;
export type SelectM3uAssociatedPlaylistsFn = (options: {
  associatedPlaylists: M3uAssociatedPlaylist[];
}) => M3uAssociatedPlaylist[] | Promise<M3uAssociatedPlaylist[]>;

export type ParseMediaMandatoryOptions = { src: ParseMediaSrc };

export type SerializeableOptionalParseMediaParams<F extends Options<ParseMediaFields>> = {
  logLevel: MediaParserLogLevel;
  progressIntervalInMs: number | null;
  fields: F | null;
  acknowledgeRemotionLicense: boolean;
  m3uPlaylistContext: M3uPlaylistContext | null;
  makeSamplesStartAtZero: boolean;
  seekingHints: SeekingHints | null;
};

type OptionalParseMediaParams<F extends Options<ParseMediaFields>> = SerializeableOptionalParseMediaParams<F> & {
  controller: MediaParserController | undefined;
  onParseProgress: ParseMediaOnProgress | null;
  selectM3uStream: SelectM3uStreamFn;
  selectM3uAssociatedPlaylists: SelectM3uAssociatedPlaylistsFn;
};

type ParseMediaSampleCallbacks = {
  onAudioTrack: MediaParserOnAudioTrack | null;
  onVideoTrack: MediaParserOnVideoTrack | null;
};

export type ParseMediaOnWorkerOptions<F extends Options<ParseMediaFields>> = ParseMediaMandatoryOptions &
  Partial<OptionalParseMediaParams<F>> &
  Partial<ParseMediaCallbacks> &
  Partial<ParseMediaSampleCallbacks>;
export type ParseMediaOptions<F extends Options<ParseMediaFields>> = ParseMediaOnWorkerOptions<F> & {
  reader?: MediaParserReaderInterface;
};
export type DownloadAndParseMediaOptions<F extends Options<ParseMediaFields>> = ParseMediaOptions<F> & {
  writer: WriterInterface;
  onError?: ParseMediaOnError;
};

export type ParseMedia = <F extends Options<ParseMediaFields>>(options: ParseMediaOptions<F>) => Promise<ParseMediaResult<F>>;
export type ParseMediaOnWorker = <F extends Options<ParseMediaFields>>(
  options: ParseMediaOnWorkerOptions<F>,
) => Promise<ParseMediaResult<F>>;
export type DownloadAndParseMedia = <F extends Options<ParseMediaFields>>(
  options: DownloadAndParseMediaOptions<F>,
) => Promise<ParseMediaResult<F>>;
