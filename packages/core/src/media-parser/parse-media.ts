// `parseMedia` of `@remotion/media-parser` over the addon: the file's container is read by FFmpeg (`probeStreams`, and
// `scanStreams` for the "slow" fields), the fields are made from that, and the answer is what the published parser
// gives for the same file: the same fields, keys and types, checked against it on a set of files (test/media-parser).
//
// What it is not: a parser that reads bytes as they come. A source is a file on disk (a URL is the "renders offline"
// error), the file is read whole, so `onParseProgress` fires once and `seekingHints` and the controller's seeking do
// nothing, and what needs the box tree or the samples (`slowStructure`, `onAudioTrack`, `onVideoTrack`, M3U) throws
// `UnsupportedApiError`.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { imageSizeOfBytes } from '@kinetograph/compat/shim';
import type { MediaStreams, StreamScan } from '@kinetograph/native';
import { UnsupportedApiError } from '../unsupported.js';
import { mediaParserAddon } from './addon.js';
import { IsAnImageError, IsAnUnsupportedFileTypeError, IsAPdfError, type ImageType } from './errors.js';
import { mediaParserController } from './controller.js';
import { Log } from './log.js';
import { nodeReadContent, sourcePath } from './readers.js';
import { containerOf, locationOf, metadataOf, streamIndexOf, tracksOf } from './tracks.js';
import type {
  DownloadAndParseMediaOptions,
  MediaParserAudioTrack,
  MediaParserContainer,
  MediaParserEmbeddedImage,
  MediaParserKeyframe,
  MediaParserTrack,
  MediaParserVideoTrack,
  Options,
  ParseMediaCallbacks,
  ParseMediaFields,
  ParseMediaOptions,
  ParseMediaResult,
} from './types.js';

const PACKAGE = '@remotion/media-parser';

const noStructure = () =>
  new UnsupportedApiError(PACKAGE, 'the slowStructure field', 'it is the box tree of the container, which FFmpeg does not give');

/** Fields that need every packet of the file read, which `fieldsNeedSamplesMap` of the published package marks. */
export const fieldsNeedSamplesMap: Record<keyof ParseMediaFields, boolean> = {
  slowDurationInSeconds: true,
  slowFps: true,
  slowKeyframes: true,
  slowNumberOfFrames: true,
  slowAudioBitrate: true,
  slowVideoBitrate: true,
  audioCodec: false,
  container: false,
  dimensions: false,
  durationInSeconds: false,
  fps: false,
  internalStats: false,
  isHdr: false,
  name: false,
  rotation: false,
  size: false,
  slowStructure: false,
  tracks: false,
  unrotatedDimensions: false,
  videoCodec: false,
  metadata: false,
  location: false,
  mimeType: false,
  keyframes: false,
  images: false,
  numberOfAudioChannels: false,
  sampleRate: false,
  m3uStreams: false,
};

// "onX" callbacks ask for the field "x" as well.
const CALLBACK_FIELDS = Object.keys(fieldsNeedSamplesMap) as (keyof ParseMediaFields)[];
const callbackName = (field: keyof ParseMediaFields) => `on${field[0]!.toUpperCase()}${field.slice(1)}` as keyof ParseMediaCallbacks;

let licenseNoteShown = false;

// ---- what a file is when it is not media ----

const IMAGE_MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', bmp: 'image/bmp', webp: 'image/webp', gif: 'image/gif' };

function imageTypeOf(head: Uint8Array): ImageType | null {
  const ascii = (at: number, n: number) => String.fromCharCode(...head.slice(at, at + n));
  if (head[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM' && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) return 'bmp';
  return null;
}

/** The first `length` bytes of a file (fewer for a shorter one). */
function readHead(path: string, length: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buffer = new Uint8Array(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Throws the error for an image, a PDF or anything that is not a media file, if the file is one of those. */
function rejectNonMedia(path: string, size: number): void {
  const head = readHead(path, 1 << 20);
  const fileName = basename(path);
  const image = imageTypeOf(head);
  if (image) {
    throw new IsAnImageError({
      message: 'Image files are not supported',
      imageType: image,
      dimensions: imageSizeOfBytes(head),
      mimeType: null,
      sizeInBytes: size,
      fileName,
    });
  }
  if (String.fromCharCode(...head.slice(0, 5)) === '%PDF-') {
    throw new IsAPdfError({ message: 'PDF files are not supported', mimeType: null, sizeInBytes: size, fileName });
  }
}

// ---- the fields ----

const imageMimeOfCodec = (codec: string): string | null =>
  ({ mjpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[codec] ?? null;

const firstVideo = (tracks: MediaParserTrack[]) => tracks.find((t): t is MediaParserVideoTrack => t.type === 'video');
const firstAudio = (tracks: MediaParserTrack[]) => tracks.find((t): t is MediaParserAudioTrack => t.type === 'audio');

/** Packets, bytes and time spans of one track, from the scan. */
function scanOf(scans: StreamScan[], track: MediaParserTrack): StreamScan | undefined {
  const index = streamIndexOf.get(track);
  return scans.find((scan) => scan.index === index);
}

/**
 * The keyframes of the video tracks, `shift` seconds later. The published parser's slow keyframes start the file at
 * time 0, which for a transport stream is where its clock starts, so those take `-startOffset`.
 */
function keyframesOf(scans: StreamScan[], tracks: MediaParserTrack[], shiftOf: (scan: StreamScan) => number): MediaParserKeyframe[] {
  const out: MediaParserKeyframe[] = [];
  for (const track of tracks) {
    if (track.type !== 'video') continue;
    const scan = scanOf(scans, track);
    for (const k of scan?.keyframes ?? []) {
      const shift = shiftOf(scan!);
      out.push({
        trackId: track.trackId,
        positionInBytes: k.position,
        sizeInBytes: k.size,
        presentationTimeInSeconds: (k.ptsInSeconds ?? k.dtsInSeconds ?? 0) + shift,
        decodingTimeInSeconds: (k.dtsInSeconds ?? k.ptsInSeconds ?? 0) + shift,
      });
    }
  }
  return out;
}

/** How many seconds a scanned track runs: from its first picture to the end of its last. */
const spanOf = (scan: StreamScan | undefined): number | null =>
  scan && scan.startInSeconds != null && scan.endInSeconds != null ? scan.endInSeconds - scan.startInSeconds : null;

function bitrateOf(scans: StreamScan[], track: MediaParserTrack | undefined): number | null {
  if (!track) return null;
  const scan = scanOf(scans, track);
  const span = spanOf(scan);
  return scan && span ? (scan.bytes * 8) / span : null;
}

/** The last moment any track plays, counted from where the file's clock starts. */
function slowDuration(scans: StreamScan[], startOffset: number): number {
  let end = 0;
  for (const scan of scans) if (scan.endInSeconds != null) end = Math.max(end, scan.endInSeconds);
  return Math.max(0, end - startOffset);
}

interface Parsed {
  path: string;
  size: number;
  name: string;
  container: MediaParserContainer;
  streams: MediaStreams;
  tracks: MediaParserTrack[];
}

/** Where a transport stream's clock starts (the muxer sets it, usually above 0); the samples are counted from there. */
const startOffset = (streams: MediaStreams, container: MediaParserContainer): number =>
  container === 'transport-stream' ? Math.max(0, streams.startInSeconds ?? 0) : 0;

function compute(field: keyof ParseMediaFields, parsed: Parsed, scans: () => StreamScan[]): unknown {
  const { streams, tracks, container } = parsed;
  const video = firstVideo(tracks);
  const audio = firstAudio(tracks);
  switch (field) {
    case 'name':
      return parsed.name;
    case 'size':
      return parsed.size;
    case 'container':
      return container;
    case 'mimeType':
      return null;
    case 'internalStats':
      return { skippedBytes: 0, finalCursorOffset: parsed.size };
    case 'tracks':
      return tracks;
    case 'dimensions':
      return video ? { width: video.width, height: video.height } : null;
    case 'unrotatedDimensions':
      return video ? { width: video.displayAspectWidth, height: video.displayAspectHeight } : null;
    case 'rotation':
      return video ? video.rotation : 0;
    case 'isHdr':
      return tracks.some(
        (t) =>
          t.type === 'video' &&
          t.advancedColor.matrix === 'bt2020-ncl' &&
          (t.advancedColor.transfer === 'hlg' || t.advancedColor.transfer === 'pq') &&
          t.advancedColor.primaries === 'bt2020',
      );
    case 'durationInSeconds': {
      // A raw AAC stream and a transport stream do not say how long they are.
      if (container === 'aac' || container === 'transport-stream') return null;
      // An MP3's length is its frames' (what its Xing header counts), not the gapless length FFmpeg trims it to.
      if (container === 'mp3') {
        const scan = scanOf(scans(), tracks[0]!);
        if (scan?.endInSeconds != null) return scan.endInSeconds - (scan.startInSeconds ?? 0);
      }
      return streams.durationInSeconds ?? null;
    }
    case 'fps':
      return video ? video.fps : null;
    case 'videoCodec':
      return video ? video.codecEnum : null;
    case 'audioCodec':
      return audio ? audio.codecEnum : null;
    case 'sampleRate':
      return audio ? audio.sampleRate : null;
    case 'numberOfAudioChannels':
      return audio ? audio.numberOfChannels : null;
    case 'metadata':
      return metadataOf(streams, container, tracks);
    case 'location':
      return locationOf(streams);
    case 'images':
      return streams.streams.flatMap((s): MediaParserEmbeddedImage[] =>
        s.attachedPicture ? [{ description: null, mimeType: imageMimeOfCodec(s.codec), data: new Uint8Array(s.attachedPicture) }] : [],
      );
    case 'keyframes':
      // Only a container with a table of its pictures has them without reading the file. Its times are the file's own,
      // before the delay of the first picture (which FFmpeg's timestamps already take off) is.
      return container === 'mp4' ? keyframesOf(scans(), tracks, (scan) => Math.max(0, -(scan.firstDtsInSeconds ?? 0))) : null;
    case 'slowKeyframes':
      return keyframesOf(scans(), tracks, () => -startOffset(streams, container));
    case 'slowDurationInSeconds':
      return slowDuration(scans(), startOffset(streams, container));
    case 'slowNumberOfFrames':
      return video ? (scanOf(scans(), video)?.packets ?? 0) : 0;
    case 'slowFps': {
      if (!video) return 0;
      const scan = scanOf(scans(), video);
      const span = spanOf(scan);
      return scan && span ? scan.packets / span : 0;
    }
    case 'slowVideoBitrate':
      return bitrateOf(scans(), video);
    case 'slowAudioBitrate':
      return bitrateOf(scans(), audio);
    case 'm3uStreams':
      return null;
    case 'slowStructure':
      throw noStructure();
  }
}

/**
 * Reads the media file at `src` and answers with the fields asked for, in `fields` or by a callback (`onDimensions`,
 * ...), which is called with the value as well.
 */
export async function parseMedia<F extends Options<ParseMediaFields>>(options: ParseMediaOptions<F>): Promise<ParseMediaResult<F>> {
  return internalParseMedia(options, 'parseMedia()');
}

async function internalParseMedia<F extends Options<ParseMediaFields>>(options: ParseMediaOptions<F>, apiName: string): Promise<ParseMediaResult<F>> {
  if (!options) throw new Error('No options provided. See https://www.remotion.dev/media-parser for how to get started.');
  if (!options.acknowledgeRemotionLicense && !licenseNoteShown) {
    licenseNoteShown = true;
    Log.warn(
      options.logLevel ?? 'info',
      `Note: Some companies are required to obtain a license to use @remotion/media-parser. See: https://remotion.dev/license\nPass \`acknowledgeRemotionLicense: true\` to \`${apiName}\` function to make this message disappear.`,
    );
  }
  if (options.onAudioTrack || options.onVideoTrack) {
    throw new UnsupportedApiError(
      PACKAGE,
      `${options.onVideoTrack ? 'onVideoTrack' : 'onAudioTrack'}`,
      'handing the encoded samples of a track to a callback needs a demuxer that returns packets to JavaScript, which the addon does not have',
    );
  }
  const controller = options.controller;
  await controller?._internals.checkForAbortAndPause();

  const wanted = new Set<keyof ParseMediaFields>();
  for (const field of CALLBACK_FIELDS) if (options[callbackName(field)]) wanted.add(field);
  for (const [field, on] of Object.entries(options.fields ?? {})) {
    if (on) wanted.add(field as keyof ParseMediaFields);
    else wanted.delete(field as keyof ParseMediaFields);
  }
  if (wanted.has('slowStructure')) throw noStructure();

  const path = sourcePath(options.src, apiName.replace('()', ''));
  if (!existsSync(path)) throw new Error(`File does not exist: ${path}`);
  const size = statSync(path).size;
  const name = basename(path);
  rejectNonMedia(path, size);

  const addon = mediaParserAddon();
  let streams: MediaStreams;
  try {
    streams = addon.probeStreams(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_ARG') {
      throw new IsAnUnsupportedFileTypeError({ message: 'Unknown file format', mimeType: null, sizeInBytes: size, fileName: name });
    }
    throw error;
  }
  const container = containerOf(streams.format);
  if (!container) {
    throw new IsAnUnsupportedFileTypeError({ message: `Unsupported container ${streams.format}`, mimeType: null, sizeInBytes: size, fileName: name });
  }
  if (container === 'm3u8') {
    throw new UnsupportedApiError(PACKAGE, 'M3U8 playlists', 'their segments are fetched over the network, and Kinetograph renders offline');
  }
  const parsed: Parsed = { path, size, name, container, streams, tracks: tracksOf(streams, container) };

  let scanned: StreamScan[] | null = null;
  const scans = () => (scanned ??= addon.scanStreams(path));

  const result: Record<string, unknown> = {};
  for (const field of wanted) {
    await controller?._internals.checkForAbortAndPause();
    result[field] = compute(field, parsed, scans);
  }
  for (const field of wanted) {
    const callback = options[callbackName(field)] as ((value: unknown) => unknown) | null | undefined;
    if (callback) await callback(result[field]);
  }
  await options.onParseProgress?.({ bytes: size, percentage: 1, totalBytes: size });
  await controller?._internals.checkForAbortAndPause();
  return result as ParseMediaResult<F>;
}

/**
 * `parseMedia`, and the file's bytes written to `options.writer` as well. The published package writes what it has
 * read while parsing; here the file is copied whole.
 */
export async function downloadAndParseMedia<F extends Options<ParseMediaFields>>(
  options: DownloadAndParseMediaOptions<F>,
): Promise<ParseMediaResult<F>> {
  if (!options) throw new Error('No options provided. See https://www.remotion.dev/media-parser for how to get started.');
  const logLevel = options.logLevel ?? 'info';
  const content = await options.writer.createContent({ filename: 'hmm', mimeType: 'shouldnotmatter', logLevel });
  try {
    const result = await internalParseMedia(options, 'parseAndDownloadMedia()');
    const reading = await nodeReadContent({
      src: sourcePath(options.src, 'downloadAndParseMedia'),
      range: null,
      controller: options.controller ?? mediaParserController(),
      logLevel,
      prefetchCache: new Map(),
    });
    for (;;) {
      const { done, value } = await reading.reader.reader.read();
      if (done) break;
      await content.write(value);
    }
    await content.finish();
    return result;
  } catch (error) {
    const action = (await options.onError?.(error as Error)) ?? { action: 'fail' as const };
    if (action.action === 'fail') {
      await content.finish().catch(() => {});
      await content.remove();
    }
    throw error;
  }
}
