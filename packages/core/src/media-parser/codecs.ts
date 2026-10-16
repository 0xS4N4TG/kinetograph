// FFmpeg's codec names as `@remotion/media-parser` names them, the RFC 6381 codec strings of its tracks, and the
// private data a track carries.

import type {
  MediaParserAudioCodec,
  MediaParserCodecData,
  MediaParserContainer,
  MediaParserMatrixCoefficients,
  MediaParserPrimaries,
  MediaParserTransferCharacteristics,
  MediaParserVideoCodec,
} from './types.js';

const VIDEO: Record<string, MediaParserVideoCodec> = {
  h264: 'h264',
  hevc: 'h265',
  vp8: 'vp8',
  vp9: 'vp9',
  av1: 'av1',
  prores: 'prores',
};

const AUDIO: Record<string, MediaParserAudioCodec> = {
  aac: 'aac',
  mp3: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  ac3: 'ac3',
  flac: 'flac',
  pcm_u8: 'pcm-u8',
  pcm_s16le: 'pcm-s16',
  pcm_s24le: 'pcm-s24',
  pcm_s32le: 'pcm-s32',
  pcm_f32le: 'pcm-f32',
  pcm_s16be: 'aiff',
  pcm_s24be: 'aiff',
  pcm_s32be: 'aiff',
};

export const videoCodecOf = (ffmpegName: string): MediaParserVideoCodec | null => VIDEO[ffmpegName] ?? null;
export const audioCodecOf = (ffmpegName: string): MediaParserAudioCodec | null => AUDIO[ffmpegName] ?? null;

/** The NAL units of an Annex B byte stream, without their start codes. */
function annexBUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        // The zero that begins a four-byte start code belongs to it, not to the unit before.
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        units.push(data.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
}

/**
 * An H.264 stream's `avcC` record. The private data of an MP4 is one; a transport stream's is the SPS and PPS in Annex
 * B form, which this builds a record from (declaring 4:2:0 at 8 bits where the profile has those fields, which is what
 * the streams of a transport stream are in practice).
 */
export function avcConfigRecord(extradata: Uint8Array | undefined): Uint8Array | undefined {
  if (!extradata || extradata.length === 0 || extradata[0] === 1) return extradata;
  const units = annexBUnits(extradata);
  const sps = units.find((u) => (u[0]! & 0x1f) === 7);
  const pps = units.find((u) => (u[0]! & 0x1f) === 8);
  if (!sps || !pps || sps.length < 4) return extradata;
  const highProfile = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(sps[1]!);
  return Uint8Array.from([
    1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps,
    1, pps.length >> 8, pps.length & 0xff, ...pps,
    ...(highProfile ? [0xfd, 0xf8, 0xf8, 0] : []),
  ]);
}

const hex = (n: number, digits = 2) => n.toString(16).padStart(digits, '0');

/** The codec string of an H.264 stream: profile, constraint flags and level, from its `avcC` record or its header. */
function avcString(extradata: Uint8Array | undefined, profile: number | null, level: number | null): string {
  if (extradata && extradata.length >= 4 && extradata[0] === 1) {
    return `avc1.${hex(extradata[1]!)}${hex(extradata[2]!)}${hex(extradata[3]!)}`;
  }
  return `avc1.${hex((profile ?? 0) & 0xff)}00${hex((level ?? 0) & 0xff)}`;
}

/** The codec string of an H.265 stream from its `hvcC` record: `hvc1.<space+profile>.<compat>.<tier+level>.<constraints>`. */
function hevcString(extradata: Uint8Array | undefined, profile: number | null, level: number | null): string {
  if (!extradata || extradata.length < 13) return `hvc1.${profile ?? 1}.6.L${level ?? 93}.B0`;
  const space = ['', 'A', 'B', 'C'][extradata[1]! >> 6]!;
  const tier = extradata[1]! & 0x20 ? 'H' : 'L';
  const profileIdc = extradata[1]! & 0x1f;
  // The compatibility flags, bit-reversed, as hex without leading zeros.
  let compatibility = 0;
  const flags = ((extradata[2]! << 24) | (extradata[3]! << 16) | (extradata[4]! << 8) | extradata[5]!) >>> 0;
  for (let bit = 0; bit < 32; bit++) if (flags & (1 << bit)) compatibility |= 1 << (31 - bit);
  const constraints = [...extradata.slice(6, 12)];
  while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
  return `hvc1.${space}${profileIdc}.${(compatibility >>> 0).toString(16)}.${tier}${extradata[12]}.${constraints
    .map((byte) => byte.toString(16).toUpperCase())
    .join('.')}`;
}

/** The codec string of an AV1 stream from its `av1C` record. */
function av1String(extradata: Uint8Array | undefined, profile: number | null, bitDepth: number | null): string {
  if (extradata && extradata.length >= 4 && extradata[0]! & 0x80) {
    const seqProfile = extradata[1]! >> 5;
    const level = extradata[1]! & 0x1f;
    const tier = extradata[2]! & 0x80 ? 'H' : 'M';
    const depth = extradata[2]! & 0x40 ? (extradata[2]! & 0x20 ? 12 : 10) : 8;
    return `av01.${seqProfile}.${hex(level)}${tier}.${hex(depth)}`;
  }
  return `av01.${profile ?? 0}.04M.${hex(bitDepth ?? 8)}`;
}

/** The audio object type in the first five bits of an AAC `AudioSpecificConfig`. */
export const aacObjectType = (config: Uint8Array | undefined): number | null => (config && config.length > 0 ? config[0]! >> 3 : null);

export function videoCodecString(
  codec: MediaParserVideoCodec,
  parts: { extradata: Uint8Array | undefined; profile: number | null; level: number | null; bitDepth: number | null; tag: string | null },
): string {
  switch (codec) {
    case 'h264':
      return avcString(parts.extradata, parts.profile, parts.level);
    case 'h265':
      return hevcString(parts.extradata, parts.profile, parts.level);
    case 'av1':
      return av1String(parts.extradata, parts.profile, parts.bitDepth);
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return `vp09.${hex(parts.profile ?? 0)}.${parts.level !== null && parts.level > 0 ? hex(parts.level) : '10'}.${hex(parts.bitDepth ?? 8)}`;
    case 'prores':
      return parts.tag ?? 'prores';
  }
}

/** `mp4a.40.2` for AAC (an MP4 pads the object type to two digits), and the bare name for the rest. */
export function audioCodecString(codec: MediaParserAudioCodec, extradata: Uint8Array | undefined, container: MediaParserContainer): string {
  if (codec === 'aac') {
    const objectType = aacObjectType(extradata) ?? 2;
    return `mp4a.40.${container === 'mp4' ? String(objectType).padStart(2, '0') : objectType}`;
  }
  if (codec === 'ac3') return 'ac-3';
  return codec;
}

/** The private data of a track, typed by what it holds. */
export function codecDataOf(
  codec: MediaParserVideoCodec | MediaParserAudioCodec,
  extradata: Uint8Array | undefined,
): MediaParserCodecData | null {
  if (!extradata || extradata.length === 0) return null;
  switch (codec) {
    case 'h264':
      return { type: 'avc-sps-pps', data: extradata };
    case 'h265':
      return { type: 'hvcc-data', data: extradata };
    case 'av1':
      return { type: 'av1c-data', data: extradata };
    case 'aac':
      return { type: 'aac-config', data: extradata };
    case 'flac':
      return { type: 'flac-description', data: extradata };
    case 'opus':
      return { type: 'ogg-identification', data: extradata };
    default:
      return { type: 'unknown-data', data: extradata };
  }
}

/** Codecs whose private data a decoder is configured with, which the published tracks call `description`. */
export const hasDescription = (codec: MediaParserVideoCodec | MediaParserAudioCodec): boolean =>
  codec === 'h264' || codec === 'h265' || codec === 'av1' || codec === 'aac' || codec === 'flac';

// ---- colour: FFmpeg's H.273 numbers as the published names ----

export const primariesOf = (n: number): MediaParserPrimaries =>
  ({ 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' } as Record<number, MediaParserPrimaries>)[n] ?? null;

export const transferOf = (n: number): MediaParserTransferCharacteristics | null =>
  (
    {
      1: 'bt709',
      6: 'smpte170m',
      8: 'linear',
      13: 'iec61966-2-1',
      16: 'pq',
      18: 'hlg',
    } as Record<number, MediaParserTransferCharacteristics>
  )[n] ?? null;

export const matrixOf = (n: number): MediaParserMatrixCoefficients | null =>
  ({ 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' } as Record<number, MediaParserMatrixCoefficients>)[n] ?? null;

/** FFmpeg's `AVColorRange`: 1 limited, 2 full, 0 not said. */
export const fullRangeOf = (n: number): boolean | null => (n === 2 ? true : n === 1 ? false : null);
