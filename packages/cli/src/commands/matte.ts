// `kinetograph matte <video>`: separates a video into a foreground with alpha (and, with --base, an opaque base) with
// a matting model run by the addon (the API of @remotion/video-matting, `@kinetographdev/video-matting`). The model is
// downloaded on first use. Precomputed: a render only reads the files this writes (AUTHORING.md, "Video matting").

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  canUseVideoMatting,
  downloadVideoMattingModel,
  getAvailableModels,
  isVideoMattingModelCached,
  separateVideoLayers,
  type VideoMattingModel,
} from '@kinetographdev/video-matting';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { OUTPUT_OPTION, type Command } from './types.js';

const AUDIO = ['keep', 'drop'] as const;
const QUALITY = ['very-low', 'low', 'medium', 'high', 'very-high'] as const;

const oneOf = <T extends string>(flag: string, value: unknown, allowed: readonly T[], fallback: T): T => {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new CliError('INVALID_ARG', `${flag} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
};

function layerPath(flag: string, value: string): string {
  const path = resolve(value);
  if (!/\.(webm|mov)$/i.test(path)) throw new CliError('INVALID_ARG', `${flag} must end in .webm (VP9 with alpha) or .mov (ProRes 4444), got "${value}"`);
  return path;
}

const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;
const sizeOf = (file: string): number => statSync(file).size;

export const matte: Command = {
  name: 'matte',
  summary: 'Separate a video into a foreground with alpha (and with --base an opaque base) using a matting model run natively; downloads the model on first use',
  project: false,
  positionals: [{ name: 'video', description: 'The video to matte (anything FFmpeg decodes)' }],
  options: [
    { ...OUTPUT_OPTION, description: 'The foreground file: .webm (VP9 with alpha, default) or .mov (ProRes 4444) (default <video>.foreground.webm)' },
    { name: 'base', type: 'string', description: 'Also write the opaque base layer here (.webm or .mov); by default only the foreground is written' },
    { name: 'model', type: 'string', description: 'modnet (default; people, Apache-2.0, 25.9 MB) or ben2-base (any foreground subject, MIT, experimental and heavier, 219.1 MB)' },
    { name: 'audio', type: 'string', description: 'keep (default) copies the video\'s audio into the written files; drop writes them silent' },
    { name: 'quality', type: 'string', description: 'Video quality of the outputs: very-low | low | medium | high | very-high (default very-high; higher keeps alpha edges better and makes larger files)' },
    { name: 'offline', type: 'boolean', description: 'Never download the model: it must already be cached (a missing one is an error)' },
  ],
  async run(args, context) {
    const video = resolve(String(args.positionals.video));
    if (!existsSync(video) || !statSync(video).isFile()) throw new CliError('IO', `cannot find the video "${video}"`);

    const names = getAvailableModels().map((m) => m.name);
    const model = oneOf('--model', args.options.model, names as VideoMattingModel[], 'modnet');
    const audio = oneOf('--audio', args.options.audio, AUDIO, 'keep');
    const quality = oneOf('--quality', args.options.quality, QUALITY, 'very-high');
    const stem = basename(video, extname(video));
    const output = layerPath('--output', typeof args.options.output === 'string' && args.options.output !== '' ? args.options.output : join(dirname(video), `${stem}.foreground.webm`));
    const base = typeof args.options.base === 'string' && args.options.base !== '' ? layerPath('--base', args.options.base) : undefined;
    if (output === video || base === video) throw new CliError('INVALID_ARG', 'the output would overwrite the input video');
    if (base === output) throw new CliError('INVALID_ARG', '--output and --base are the same file');
    const offline = args.options.offline === true;

    // Everything below is work: the options are all checked.
    native();
    const support = await canUseVideoMatting({ model });
    if (!support.supported) throw new CliError('MATTING_UNAVAILABLE', `video matting cannot run here (${support.reason}): ${support.detailedReason}`);

    if (!(await isVideoMattingModelCached({ model }))) {
      const info = getAvailableModels().find((m) => m.name === model)!;
      if (offline) throw new CliError('MODEL_NOT_DOWNLOADED', `the "${model}" model is not cached and --offline is set (it downloads ${megabytes(info.webGpuDownloadSize)} from huggingface.co/${info.modelId})`);
      context.progress(`downloading the ${model} model (${megabytes(info.webGpuDownloadSize)}, ${info.license}) from huggingface.co/${info.modelId}`);
      let tenth = -1;
      await downloadVideoMattingModel({
        model,
        onProgress: (p) => {
          const step = Math.floor(p.progress * 10);
          if (p.file === null && step > tenth) {
            tenth = step;
            context.progress(`  model ${step * 10}%`);
          }
        },
      });
    }

    for (const file of base === undefined ? [output] : [output, base]) mkdirSync(dirname(file), { recursive: true });
    context.progress(`matting ${video} with ${model} (${support.backend})`);
    let tenth = -1;
    const result = await separateVideoLayers({
      src: video,
      model,
      audio: audio === 'keep' ? 'both' : 'none',
      videoBitrate: quality,
      outputs: { foreground: { path: output }, base: base === undefined ? false : { path: base } },
      onProgress: (p) => {
        const step = p.progress === null ? 11 : Math.floor(p.progress * 10);
        if (step > tenth) {
          tenth = step;
          context.progress(p.progress === null ? '  finishing the files' : `  ${step * 10}% (${p.processedFrames} frames)`);
        }
      },
    });
    await result[Symbol.asyncDispose]();

    const bytes = { foreground: sizeOf(output), ...(base === undefined ? {} : { base: sizeOf(base) }) };
    const data = {
      foreground: output,
      ...(base === undefined ? {} : { base }),
      model,
      backend: result.backend,
      frames: result.processedFrames,
      width: result.width,
      height: result.height,
      durationInSeconds: result.durationInSeconds,
      audio,
      quality,
      bytes,
    };
    const lines = [
      `wrote ${output} (${megabytes(bytes.foreground)})`,
      ...(base === undefined ? [] : [`wrote ${base} (${megabytes(bytes.base!)})`]),
      `  ${result.width}x${result.height}, ${result.processedFrames} frames, ${result.durationInSeconds}s, ${model} on ${result.backend}`,
    ];
    return { data, text: lines.join('\n') };
  },
};
