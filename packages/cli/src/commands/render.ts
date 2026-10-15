import { writeFileSync } from 'node:fs';
import type { RenderSummary } from '@kinetograph/native';
import { renderSource } from '../render-job.js';
import { checkFrame } from '../source.js';
import { nowMs } from '../time.js';
import {
  ENTRY,
  OUTPUT_OPTION,
  ensureParentDir,
  newRenderer,
  openFromArgs,
  requireOutput,
  type Command,
} from './types.js';

export const still: Command = {
  name: 'still',
  summary: 'Render one frame to a PNG',
  project: true,
  positionals: [ENTRY, { name: 'frame', type: 'number', description: 'Frame number, from 0' }],
  options: [OUTPUT_OPTION],
  async run(args) {
    const output = requireOutput(args);
    const source = await openFromArgs(args);
    try {
      const frame = checkFrame(args.positionals.frame as number, source.composition.durationInFrames);
      const started = nowMs();
      const { sceneJson } = await source.frame(frame);
      const png = newRenderer().still(sceneJson, frame, source.baseDir);
      ensureParentDir(output);
      writeFileSync(output, png);
      const ms = nowMs() - started;
      const { width, height } = source.composition;
      return {
        data: { output, width, height, frame, ms },
        text: `wrote ${output} (${width}x${height}, frame ${frame}, ${ms.toFixed(1)} ms)`,
      };
    } finally {
      source.dispose();
    }
  },
};

export const render: Command = {
  name: 'render',
  summary: 'Render frames to a video with audio',
  project: true,
  positionals: [ENTRY],
  options: [
    OUTPUT_OPTION,
    { name: 'range', type: 'string', description: 'Frames to render: 10..40 (10 to 39) or 10..=40 (10 to 40); default all' },
    { name: 'encoder', type: 'string', description: 'ffmpeg H.264 encoder (default h264_videotoolbox on macOS, else libx264)' },
    { name: 'draft', type: 'boolean', description: 'Half size, for a fast look' },
  ],
  async run(args, context) {
    const output = requireOutput(args);
    const source = await openFromArgs(args);
    const started = nowMs();
    const renderer = newRenderer();
    try {
      ensureParentDir(output);
      const summary = await renderSource(source, renderer, {
        output,
        range: args.options.range as string | undefined,
        encoder: args.options.encoder as string | undefined,
        draft: args.options.draft === true,
        progress: context.progress,
        onFrame(done, total) {
          if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
            context.progress(`rendering frame ${done}/${total}`);
          }
        },
      });
      return result(summary, nowMs() - started);
    } finally {
      source.dispose();
    }
  },
};

function result(summary: RenderSummary, wallMs: number) {
  return {
    data: { ...summary, wallMs },
    text:
      `wrote ${summary.output} (${summary.width}x${summary.height}, ${summary.frames} frames ` +
      `${summary.first}..=${summary.last} at ${summary.fps} fps, ${summary.encoder}, ` +
      `${summary.audio ? 'with audio' : 'no audio'}, ${summary.msPerFrame.toFixed(2)} ms/frame in the encoder, ` +
      `${wallMs.toFixed(0)} ms in all)`,
  };
}
