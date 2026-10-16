// `convertMedia` and `getPartialAudioData` of `@remotion/webcodecs`, on the addon's audio decoder.
//
// The published `convertMedia` demuxes with `parseMedia`, decodes and encodes with WebCodecs, and muxes in JavaScript.
// The addon has an audio decoder (`decodeAudio`, FFmpeg) and no video decoder or encoder to hand frames to, so the
// one conversion that maps onto it is a file's sound to a WAV: `container: 'wav'`. Every other output throws
// `UnsupportedApiError`, as do `onVideoFrame` and `onAudioData`, which receive WebCodecs objects.

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { mediaParserAddon } from '../media-parser/addon.js';
import { Log } from '../media-parser/log.js';
import {
  parseMedia,
  type MediaParserAudioTrack,
  type MediaParserReaderInterface,
  type MediaParserLogLevel,
  type ParseMediaCallbacksMandatory,
  type SeekingHints,
  type SelectM3uAssociatedPlaylistsFn,
  type SelectM3uStreamFn,
  type WriterInterface,
} from '../media-parser/index.js';
import { sourcePath } from '../media-parser/readers.js';
import { UnsupportedApiError } from '../unsupported.js';
import {
  canCopyAudioTrack,
  canCopyVideoTrack,
  defaultOnAudioTrackHandler,
  defaultOnVideoTrackHandler,
  getDefaultAudioCodec,
  getDefaultVideoCodec,
} from './tracks.js';
import type {
  ConvertMediaContainer,
  ConvertMediaOnAudioData,
  ConvertMediaOnAudioTrackHandler,
  ConvertMediaOnProgress,
  ConvertMediaOnVideoFrame,
  ConvertMediaOnVideoTrackHandler,
  ConvertMediaProgress,
  ConvertMediaResult,
  GetPartialAudioDataProps,
  ResizeOperation,
  WebCodecsController,
  ConvertMediaAudioCodec,
  ConvertMediaVideoCodec,
} from './types.js';
import { bufferWriter } from './writers.js';

const PACKAGE = '@remotion/webcodecs';

/** A 16-bit PCM WAV file of planar float `channels`. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channels.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]!));
      view.setInt16(at, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      at += 2;
    }
  }
  return out;
}

export type ConvertMediaOptions<F extends Record<string, boolean | undefined>> = {
  src: import('../media-parser/index.js').ParseMediaSrc;
  container: ConvertMediaContainer;
  onVideoFrame?: ConvertMediaOnVideoFrame;
  onAudioData?: ConvertMediaOnAudioData;
  onProgress?: ConvertMediaOnProgress;
  videoCodec?: ConvertMediaVideoCodec;
  audioCodec?: ConvertMediaAudioCodec;
  controller?: WebCodecsController;
  onAudioTrack?: ConvertMediaOnAudioTrackHandler;
  onVideoTrack?: ConvertMediaOnVideoTrackHandler;
  selectM3uStream?: SelectM3uStreamFn;
  selectM3uAssociatedPlaylists?: SelectM3uAssociatedPlaylistsFn;
  expectedDurationInSeconds?: number | null;
  expectedFrameRate?: number | null;
  reader?: MediaParserReaderInterface;
  logLevel?: MediaParserLogLevel;
  writer?: WriterInterface;
  progressIntervalInMs?: number;
  rotate?: number;
  resize?: ResizeOperation;
  fields?: F;
  seekingHints?: SeekingHints | null;
} & Partial<ParseMediaCallbacksMandatory>;

/**
 * Converts the file at `src` to `container`. Only `'wav'` is available (see the top of this file): the sound of the
 * file's audio track, decoded and written as 16-bit PCM at the track's own sample rate, or at the `sampleRate` a
 * custom `onAudioTrack` handler asks for. Video tracks are dropped, as the published function does for a WAV.
 * The progress counts samples where the published one counts `AudioData` objects.
 */
export async function convertMedia<F extends Record<string, boolean | undefined>>(options: ConvertMediaOptions<F>): Promise<ConvertMediaResult> {
  const { container, src, controller, logLevel = 'info' } = options;
  if (container !== 'wav') {
    throw new UnsupportedApiError(PACKAGE, `convertMedia() to ${String(container)}`, 'there are no video or audio encoders to hand frames to; only container: "wav" is available');
  }
  if (options.onVideoFrame || options.onAudioData) {
    throw new UnsupportedApiError(PACKAGE, options.onVideoFrame ? 'onVideoFrame' : 'onAudioData', 'it is handed WebCodecs objects, which do not exist here');
  }

  const parsed = await parseMedia({
    src,
    reader: options.reader,
    logLevel,
    controller: controller?._internals._mediaParserController,
    acknowledgeRemotionLicense: true,
    fields: { tracks: true, container: true, durationInSeconds: true },
  });
  const inputContainer = parsed.container;
  const audioHandler = options.onAudioTrack ?? defaultOnAudioTrackHandler;
  const videoHandler = options.onVideoTrack ?? defaultOnVideoTrackHandler;

  let sound: { track: MediaParserAudioTrack; sampleRate: number } | null = null;
  for (const track of parsed.tracks) {
    if (track.type === 'video') {
      const rotate = options.rotate ?? 0;
      const operation = await videoHandler({
        track,
        defaultVideoCodec: getDefaultVideoCodec({ container }),
        logLevel,
        outputContainer: container,
        rotate,
        resizeOperation: options.resize ?? null,
        inputContainer,
        canCopyTrack: canCopyVideoTrack({
          inputContainer,
          inputTrack: track,
          rotationToApply: rotate,
          outputContainer: container,
          outputVideoCodec: options.videoCodec ?? null,
          resizeOperation: options.resize ?? null,
        }),
      });
      if (operation.type === 'fail') throw new Error(`Video track ${track.trackId} could neither be copied nor re-encoded`);
      if (operation.type !== 'drop') {
        throw new UnsupportedApiError(PACKAGE, `${operation.type} of a video track`, 'a WAV holds no video, and no video is written');
      }
    } else if (track.type === 'audio') {
      const operation = await audioHandler({
        track,
        defaultAudioCodec: options.audioCodec ?? getDefaultAudioCodec({ container }),
        logLevel,
        outputContainer: container,
        inputContainer,
        canCopyTrack: canCopyAudioTrack({
          inputCodec: track.codecEnum,
          outputContainer: container,
          inputContainer,
          outputAudioCodec: options.audioCodec ?? null,
        }),
      });
      if (operation.type === 'fail') throw new Error(`Audio track ${track.trackId} could neither be copied nor re-encoded`);
      if (operation.type === 'copy') {
        throw new UnsupportedApiError(PACKAGE, 'copy of an audio track', 'a WAV is written from decoded samples');
      }
      if (operation.type === 'drop') continue;
      if (sound) throw new Error('A WAV file can only have one audio track');
      sound = { track, sampleRate: operation.sampleRate ?? track.sampleRate };
    }
  }
  await controller?._internals._mediaParserController._internals.checkForAbortAndPause();

  let channels: Float32Array[] = [];
  let sampleRate = sound?.sampleRate ?? 0;
  if (sound) {
    const path = sourcePath(src, 'convertMedia');
    const pcm = mediaParserAddon().decodeAudio(path, sound.sampleRate);
    if (pcm) {
      channels = pcm.channels;
      sampleRate = pcm.sampleRate;
    }
  }
  const wav = encodeWav(channels, sampleRate);
  const frames = channels[0]?.length ?? 0;
  const writer = await (options.writer ?? bufferWriter).createContent({
    filename: typeof src === 'string' ? `${basename(src).replace(/\.[^.]*$/, '')}.wav` : 'output.wav',
    mimeType: 'audio/wav',
    logLevel,
  });
  await writer.write(wav);
  await writer.finish();
  Log.verbose(logLevel, `Wrote ${wav.length} bytes of WAV`);

  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : 0;
  const finalState: ConvertMediaProgress = {
    decodedVideoFrames: 0,
    decodedAudioFrames: frames,
    encodedVideoFrames: 0,
    encodedAudioFrames: frames,
    bytesWritten: writer.getWrittenByteCount(),
    millisecondsWritten: durationMs,
    expectedOutputDurationInMs: durationMs,
    overallProgress: 1,
  };
  options.onProgress?.(finalState);
  return { save: () => writer.getBlob(), remove: () => writer.remove(), finalState };
}

/**
 * The samples of one channel of the first audio track between `fromSeconds` and `toSeconds`, at the track's own sample
 * rate. A mono track has only channel 0; a track of more than two channels is mixed down to two when it is decoded.
 */
export async function getPartialAudioData({
  src,
  fromSeconds,
  toSeconds,
  channelIndex,
  signal,
}: GetPartialAudioDataProps): Promise<Float32Array> {
  if (signal.aborted) throw new Error('Operation was aborted');
  const path = sourcePath(src, 'getPartialAudioData');
  statSync(path);
  const addon = mediaParserAddon();
  const track = addon.probeStreams(path).streams.find((stream) => stream.kind === 'audio');
  if (!track) return new Float32Array(0);
  const pcm = addon.decodeAudio(path, track.sampleRate);
  const channel = pcm ? (pcm.channels.length === 1 ? pcm.channels[0] : pcm.channels[channelIndex]) : undefined;
  if (!pcm || !channel) return new Float32Array(0);
  return channel.slice(Math.max(0, Math.floor(fromSeconds * pcm.sampleRate)), Math.max(0, Math.ceil(toSeconds * pcm.sampleRate)));
}
