// `render`'s export options (docs/AUTHORING.md §9): size, codec, quality, pixel format and audio, as Remotion names
// them. The flags are checked here for what they say alone; the addon (`resolveExport`) checks them against the output
// path and the ffmpeg it has.

import type { ExportOptions } from '@kinetograph/native';
import type { OptionSpec } from './args.js';
import { CliError } from './errors.js';

export const EXPORT_FLAGS: OptionSpec[] = [
  { name: 'scale', type: 'number', description: 'Output size multiplier: 0.5 renders 1080p as 540p, 2 renders it as 4K, drawn at that size (sides round down to even; default 1)' },
  { name: 'codec', type: 'string', description: 'h264 (default), h265, prores, vp9 or gif; .webm paths default to vp9 and .gif to gif' },
  { name: 'crf', type: 'number', description: 'Constant quality, lower is better (h264, h265 0..51, vp9 0..63); not with --video-bitrate' },
  { name: 'video-bitrate', type: 'string', description: 'Video bit rate, e.g. 8M or 2500k; not with --crf' },
  { name: 'pixel-format', type: 'string', description: 'yuv420p (default), yuv422p, yuv444p, or the 10-bit yuv420p10le, yuv422p10le, yuv444p10le' },
  { name: 'prores-profile', type: 'string', description: 'With --codec prores: proxy, light, standard, hq (default), 4444 or 4444-xq' },
  { name: 'audio-codec', type: 'string', description: 'aac (default for .mp4 and .mov), opus (.webm), or pcm (.mov, default for prores)' },
  { name: 'audio-bitrate', type: 'string', description: 'Audio bit rate, e.g. 320k (aac and opus)' },
  { name: 'every-nth-frame', type: 'number', description: 'gif only: draw every nth frame and play at the frame rate over n (default 1)' },
];

/** `8M` as 8,000,000 bit/s, `2500k` as 2,500,000, `128000` as itself. */
export function parseBitrate(flag: string, text: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.trim());
  const bits = m ? Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6 }[m[2]!.toLowerCase() as '' | 'k' | 'm']) : NaN;
  if (!Number.isFinite(bits) || bits < 1) {
    throw new CliError('INVALID_ARG', `${flag} must be a bit rate like 8M, 2500k or 128000, got "${text}"`);
  }
  return Math.round(bits);
}

export interface ExportFlags {
  /** 1 unless `--scale` (or `--draft`, 0.5). */
  scale: number;
  export: ExportOptions;
  everyNthFrame?: number;
}

type Options = Record<string, string | number | boolean | undefined>;

/** The export flags of a parsed command line, refused with `INVALID_ARG` when they contradict one another or are out of range. */
export function parseExportFlags(options: Options): ExportFlags {
  const draft = options.draft === true;
  let scale = options.scale as number | undefined;
  if (scale !== undefined && draft) throw new CliError('INVALID_ARG', '--draft is --scale 0.5: give one of them');
  scale ??= draft ? 0.5 : 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new CliError('INVALID_ARG', `--scale must be above 0 and at most 8, got ${scale}`);
  }
  const text = (name: string): string | undefined => options[name] as string | undefined;
  const crf = options.crf as number | undefined;
  const videoBitrate = text('video-bitrate');
  if (crf !== undefined && videoBitrate !== undefined) {
    throw new CliError('INVALID_ARG', '--crf and --video-bitrate cannot be used together: pick one');
  }
  const nth = options['every-nth-frame'] as number | undefined;
  if (nth !== undefined && (!Number.isInteger(nth) || nth < 1)) {
    throw new CliError('INVALID_ARG', `--every-nth-frame must be a whole number of at least 1, got ${nth}`);
  }
  const audioBitrate = text('audio-bitrate');
  const exported: ExportOptions = {
    codec: text('codec'),
    encoder: text('encoder'),
    crf,
    videoBitrate: videoBitrate === undefined ? undefined : parseBitrate('--video-bitrate', videoBitrate),
    pixelFormat: text('pixel-format'),
    proresProfile: text('prores-profile'),
    audioCodec: text('audio-codec'),
    audioBitrate: audioBitrate === undefined ? undefined : parseBitrate('--audio-bitrate', audioBitrate),
    everyNthFrame: nth,
  };
  return { scale, export: exported, everyNthFrame: nth };
}
