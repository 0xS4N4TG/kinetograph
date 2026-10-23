// The tracks, metadata and location of `parseMedia`, made from what the addon's `probeStreams` reads from a container.

import type { MediaStreams, StreamDetails } from '@kinetographdev/native';
import { createAacCodecPrivate } from './aac.js';
import {
  audioCodecOf,
  avcConfigRecord,
  audioCodecString,
  codecDataOf,
  fullRangeOf,
  hasDescription,
  matrixOf,
  primariesOf,
  transferOf,
  videoCodecOf,
  videoCodecString,
} from './codecs.js';
import type {
  MediaParserAdvancedColor,
  MediaParserAudioTrack,
  MediaParserContainer,
  MediaParserLocation,
  MediaParserMetadataEntry,
  MediaParserOtherTrack,
  MediaParserTrack,
  MediaParserVideoTrack,
} from './types.js';

const containerByFormat: Record<string, MediaParserContainer> = {
  mov: 'mp4',
  mp4: 'mp4',
  matroska: 'webm',
  webm: 'webm',
  avi: 'avi',
  mpegts: 'transport-stream',
  mp3: 'mp3',
  aac: 'aac',
  flac: 'flac',
  wav: 'wav',
  hls: 'm3u8',
  applehttp: 'm3u8',
};

/** The container FFmpeg's format name (`mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`) stands for, if it is one parseMedia names. */
export function containerOf(format: string): MediaParserContainer | null {
  for (const name of format.split(',')) {
    const container = containerByFormat[name];
    if (container) return container;
  }
  return null;
}

const bytesOf = (data: Uint8Array | null | undefined): Uint8Array | undefined => (data ? new Uint8Array(data) : undefined);

/** A turn of a whole number of degrees is that number; `rotation` comes from a matrix and carries rounding noise. */
const cleanRotation = (degrees: number): number => {
  const rounded = Math.round(degrees);
  return Math.abs(degrees - rounded) < 1e-3 ? rounded % 360 : degrees;
};

function videoTrackOf(s: StreamDetails, trackId: number, container: MediaParserContainer, originalTimescale: number): MediaParserVideoTrack | null {
  const codec = videoCodecOf(s.codec);
  if (!codec) return null;
  const extradata = codec === 'h264' ? avcConfigRecord(bytesOf(s.extradata)) : bytesOf(s.extradata);
  const rotation = cleanRotation(s.rotation);
  const squarePixels = s.sampleAspectRatioNumerator <= 0 || s.sampleAspectRatioDenominator <= 0;
  const sampleAspectRatio = squarePixels
    ? { numerator: 1, denominator: 1 }
    : { numerator: s.sampleAspectRatioNumerator, denominator: s.sampleAspectRatioDenominator };
  // The size a player shows the picture at, before it is turned: the coded width stretched by the pixel shape.
  const displayAspectWidth = Math.round((s.width * sampleAspectRatio.numerator) / sampleAspectRatio.denominator);
  const turned = rotation === 90 || rotation === 270;
  const advancedColor: MediaParserAdvancedColor = {
    transfer: transferOf(s.colorTransfer),
    matrix: matrixOf(s.colorSpace),
    primaries: primariesOf(s.colorPrimaries),
    fullRange: fullRangeOf(s.colorRange),
  };
  return {
    type: 'video',
    trackId,
    codec: videoCodecString(codec, {
      extradata,
      profile: s.profile ?? null,
      level: s.level ?? null,
      bitDepth: s.bitDepth ?? null,
      tag: s.codecTag ?? null,
    }),
    codecEnum: codec,
    description: hasDescription(codec) && container !== 'transport-stream' ? extradata : undefined,
    codecData: codecDataOf(codec, extradata),
    colorSpace: { ...advancedColor },
    advancedColor,
    codedWidth: s.width,
    codedHeight: s.height,
    displayAspectWidth,
    displayAspectHeight: s.height,
    width: turned ? s.height : displayAspectWidth,
    height: turned ? displayAspectWidth : s.height,
    sampleAspectRatio,
    rotation,
    // Only containers that store a frame rate (MP4's sample table, AVI's stream header) have one to give; the rest
    // are measured with `slowFps`.
    fps: container === 'mp4' || container === 'avi' ? (s.frameRate ?? null) : null,
    timescale: 1000000,
    originalTimescale,
    m3uStreamFormat: null,
    startInSeconds: 0,
    trackMediaTimeOffsetInTrackTimescale: 0,
  };
}

function audioTrackOf(s: StreamDetails, trackId: number, container: MediaParserContainer, originalTimescale: number): MediaParserAudioTrack | null {
  const codec = audioCodecOf(s.codec);
  if (!codec) return null;
  // A raw or transport-stream AAC has its config in the headers of its frames, which FFmpeg reports as a profile
  // (the object type minus one), a rate and a channel count.
  const extradata = bytesOf(s.extradata) ?? (codec === 'aac' ? aacConfigFromHeader(s) : undefined);
  return {
    type: 'audio',
    trackId,
    codec: audioCodecString(codec, extradata, container),
    codecEnum: codec,
    description: hasDescription(codec) ? extradata : undefined,
    codecData: codecDataOf(codec, extradata),
    sampleRate: s.sampleRate,
    numberOfChannels: s.channels,
    timescale: 1000000,
    originalTimescale,
    startInSeconds: 0,
    trackMediaTimeOffsetInTrackTimescale: 0,
  };
}

function aacConfigFromHeader(s: StreamDetails): Uint8Array | undefined {
  try {
    return createAacCodecPrivate({ audioObjectType: (s.profile ?? 1) + 1, sampleRate: s.sampleRate, channelConfiguration: s.channels, codecPrivate: null });
  } catch {
    return undefined;
  }
}

/** The index of the stream a track was made from: ids are not unique in every container. */
export const streamIndexOf = new WeakMap<MediaParserTrack, number>();

/** A cover picture is not a track. */
const isCoverPicture = (s: StreamDetails) => s.attachedPicture != null;

/**
 * The tracks of a container: video and audio tracks FFmpeg names a codec of that `parseMedia` knows, and an `other`
 * track for every other stream. The timescale is the container's own for MP4, AVI and transport streams, whose
 * samples are counted in it, and microseconds for the rest.
 */
export function tracksOf(streams: MediaStreams, container: MediaParserContainer): MediaParserTrack[] {
  const tracks: MediaParserTrack[] = [];
  for (const s of streams.streams) {
    if (isCoverPicture(s)) continue;
    const keepsOwnTimescale = container === 'mp4' || container === 'avi' || container === 'transport-stream';
    const originalTimescale = keepsOwnTimescale && s.timeBaseDenominator > 0 ? s.timeBaseDenominator : 1_000_000;
    // Matroska numbers its tracks from 1 in the order they are listed, which FFmpeg does not report as an id.
    const trackId = container === 'webm' ? s.index + 1 : s.id;
    const track =
      s.kind === 'video'
        ? videoTrackOf(s, trackId, container, originalTimescale)
        : s.kind === 'audio'
          ? audioTrackOf(s, trackId, container, originalTimescale)
          : null;
    const made =
      track ??
        ({
          type: 'other',
          trackId,
          timescale: 1000000,
          originalTimescale,
          trakBox: null,
          startInSeconds: 0,
          trackMediaTimeOffsetInTrackTimescale: 0,
        } satisfies MediaParserOtherTrack);
    streamIndexOf.set(made, s.index);
    tracks.push(made);
  }
  return tracks;
}

// ---- metadata ----

/** Entries FFmpeg adds that no file stores as a tag of its own. */
const NOT_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'handler_name', 'vendor_id']);

// FFmpeg gives every container's tags the same names; the published parser keeps the names the file uses. These are the
// ones of MP3's ID3 frames and WAV's RIFF INFO chunks that FFmpeg renames. Others come as FFmpeg spells them.
const ID3_FRAMES: Record<string, string> = {
  title: 'TIT2', artist: 'TPE1', album: 'TALB', album_artist: 'TPE2', encoder: 'TSSE', genre: 'TCON', track: 'TRCK',
  disc: 'TPOS', composer: 'TCOM', copyright: 'TCOP', publisher: 'TPUB', language: 'TLAN', date: 'TDRC',
};
const RIFF_INFO: Record<string, string> = {
  title: 'INAM', artist: 'IART', album: 'IPRD', encoder: 'ISFT', comment: 'ICMT', genre: 'IGNR', date: 'ICRD', copyright: 'ICOP',
  track: 'IPRT', language: 'ILNG',
};

/**
 * The tags of the container and, where the file keeps them per track, of each track. An MP4's are its movie's only.
 * Matroska's names are lower-cased, and MP3 and WAV tags go by the ID3 frame or the RIFF chunk they come from.
 */
export function metadataOf(streams: MediaStreams, container: MediaParserContainer, tracks: MediaParserTrack[]): MediaParserMetadataEntry[] {
  const entries: MediaParserMetadataEntry[] = [];
  for (const tag of streams.tags) {
    if (NOT_TAGS.has(tag.key) || (tag.key === 'language' && tag.value === 'und')) continue;
    const stream = tag.stream ?? null;
    if (stream !== null && (container === 'mp4' || container === 'mp3' || container === 'wav' || container === 'flac')) continue;
    const track = stream === null ? null : tracks.find((t) => streamIndexOf.get(t) === stream);
    if (stream !== null && !track) continue;
    const key =
      container === 'webm' ? tag.key.toLowerCase() : container === 'mp3' ? (ID3_FRAMES[tag.key] ?? tag.key) : container === 'wav' ? (RIFF_INFO[tag.key] ?? tag.key) : tag.key;
    entries.push({ trackId: track ? track.trackId : null, key, value: tag.value });
  }
  return entries;
}

/**
 * A place from an ISO 6709 string (`+37.7749-122.4194+016.000/`), which is how QuickTime files store one: latitude,
 * longitude and optionally altitude, each with a sign.
 */
export function parseLocation(location: string): { latitude: number; longitude: number; altitude: number | null } | null {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(location.trim());
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]), altitude: match[3] === undefined ? null : Number(match[3]) };
}

export function locationOf(streams: MediaStreams): MediaParserLocation | null {
  const tag = (key: string) => streams.tags.find((t) => t.stream == null && t.key === key)?.value;
  const parsed = parseLocation(tag('com.apple.quicktime.location.ISO6709') ?? tag('location') ?? tag('location-eng') ?? '');
  if (!parsed) return null;
  const accuracy = tag('com.apple.quicktime.location.accuracy.horizontal');
  return { ...parsed, horizontalAccuracy: accuracy !== undefined && Number.isFinite(Number(accuracy)) ? Number(accuracy) : null };
}
