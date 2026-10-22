import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { whole } from '../args.js';
import { describeLeftOut } from '../compat-report.js';
import { EXPORT_FLAGS, parseExportFlags } from '../export-options.js';
import { FrameDrawer } from '../frame-drawer.js';
import { renderSource, type RenderResult } from '../render-job.js';
import { native } from '../native.js';
import { checkFrame, type Source } from '../source.js';
import { nowMs } from '../time.js';
import {
  DEV_REACT_OPTION,
  ENTRY,
  OUTPUT_OPTION,
  STRICT_OPTION,
  ensureParentDir,
  newRenderer,
  openFromArgs,
  requireOutput,
  setReactMode,
  type Command,
} from './types.js';

export const still: Command = {
  name: 'still',
  summary: 'Render one frame to a PNG',
  project: true,
  positionals: [ENTRY, { name: 'frame', type: 'number', description: 'Frame number, from 0' }],
  options: [OUTPUT_OPTION, STRICT_OPTION, DEV_REACT_OPTION],
  async run(args, context) {
    const output = requireOutput(args);
    const restoreReact = setReactMode(args.options['dev-react'] === true);
    let source;
    try {
      source = await openFromArgs(args);
    } finally {
      restoreReact();
    }
    const drawer = new FrameDrawer(source, { renderer: newRenderer, progress: context.progress, strict: args.options.strict === true });
    try {
      const frame = checkFrame(args.positionals.frame as number, source.composition.durationInFrames);
      const started = nowMs();
      const png = await drawer.png(frame);
      ensureParentDir(output);
      writeFileSync(output, png);
      const ms = nowMs() - started;
      const { width, height } = source.composition;
      drawer.reportLeftOut();
      return {
        data: { output, width, height, frame, ms, compat: drawer.report() },
        text: `wrote ${output} (${width}x${height}, frame ${frame}, ${ms.toFixed(1)} ms)`,
      };
    } finally {
      source.dispose();
    }
  },
};

/** Half the cores, at most 4: past that the GPU, the encoder and memory (0.5 to 1 GB a worker) are the limit, not the JS. */
export function defaultConcurrency(): number {
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
}

export const render: Command = {
  name: 'render',
  summary: 'Render frames to a video with audio',
  project: true,
  positionals: [ENTRY],
  options: [
    OUTPUT_OPTION,
    { name: 'range', type: 'string', description: 'Frames to render: 10..40 (10 to 39) or 10..=40 (10 to 40); default all' },
    { name: 'encoder', type: 'string', description: 'ffmpeg encoder name for the codec (default: h264_videotoolbox / hevc_videotoolbox / prores_videotoolbox on macOS when ffmpeg has them and they can do what is asked, else libx264, libx265, prores_ks, libvpx-vp9)' },
    { name: 'draft', type: 'boolean', description: 'Half size, for a fast look (the same as --scale 0.5)' },
    ...EXPORT_FLAGS,
    { name: 'concurrency', type: 'number', description: 'Frames drawn at once, in worker threads (default: half the cores, at most 4; 1 draws every frame in the main thread; a .json scene is drawn whole)' },
    STRICT_OPTION,
    DEV_REACT_OPTION,
  ],
  async run(args, context) {
    const output = requireOutput(args);
    const concurrency = whole('--concurrency', args.options.concurrency as number | undefined, 1, defaultConcurrency());
    const flags = parseExportFlags(args.options);
    const devReact = args.options['dev-react'] === true;
    // Refused now, before the project is bundled and run, if the options do not fit the output path or this ffmpeg.
    native().resolveExport(output, flags.export);
    // React's production build unless asked otherwise: the development one is several times slower per frame. The
    // worker threads are told too (`devReact`).
    const restoreReact = setReactMode(devReact);
    let source: Source | undefined;
    try {
      source = await openFromArgs(args);
      const started = nowMs();
      const renderer = newRenderer();
      ensureParentDir(output);
      const summary = await renderSource(source, renderer, {
        output,
        range: args.options.range as string | undefined,
        encoder: args.options.encoder as string | undefined,
        scale: flags.scale,
        export: flags.export,
        everyNthFrame: flags.everyNthFrame,
        devReact,
        strict: args.options.strict === true,
        concurrency,
        progress: context.progress,
        onFrame(done, total) {
          if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
            context.progress(`rendering frame ${done}/${total}`);
          }
        },
      });
      for (const line of describeLeftOut(summary.compat)) context.progress(line);
      return result(summary, nowMs() - started);
    } finally {
      source?.dispose();
      restoreReact();
    }
  },
};

function result(summary: RenderResult, wallMs: number) {
  const left = summary.compat.unsupportedFrames;
  const unsupported = left > 0 ? `, unsupported content left out of ${left} frame${left === 1 ? '' : 's'}` : '';
  return {
    data: { ...summary, wallMs },
    text:
      `wrote ${summary.output} (${summary.width}x${summary.height}, ${summary.frames} frames ` +
      (summary.repeated > 0 ? `(${summary.repeated} the same as the frame before, not drawn again) ` : '') +
      `${summary.first}..=${summary.last} at ${summary.fps} fps, ${summary.codec} by ${summary.encoder}, ${summary.pixelFormat}, ` +
      `${summary.audio ? 'with audio' : 'no audio'}, ${summary.msPerFrame.toFixed(2)} ms/frame in the encoder${unsupported}, ` +
      `${wallMs.toFixed(0)} ms in all)` +
      (summary.artifacts.length > 0 ? `; also wrote ${summary.artifacts.join(', ')}` : ''),
  };
}
