import { writeFileSync } from 'node:fs';
import { clampPcm, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import type { RenderSummary } from '@kinetograph/native';
import type { AudioClipJson, SceneJson } from '@kinetograph/scene';
import { draftScene, halfSize } from '../scenes.js';
import { checkFrame, frameRange } from '../source.js';
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
    const range = args.options.range as string | undefined;
    const encoder = args.options.encoder as string | undefined;
    const draft = args.options.draft === true;
    const source = await openFromArgs(args);
    const started = nowMs();
    const renderer = newRenderer();
    try {
      ensureParentDir(output);
      const { durationInFrames, fps, width, height } = source.composition;

      // A JSON scene goes to the addon whole: it has keyframes and no audio.
      if (source.kind === 'scene') {
        let { sceneJson } = await source.frame(0);
        if (draft) sceneJson = JSON.stringify(draftScene(JSON.parse(sceneJson) as SceneJson));
        const summary = renderer.render(sceneJson, output, { range, encoder, baseDir: source.baseDir });
        return result(summary, nowMs() - started);
      }

      const [first, last] = frameRange(range, durationInFrames);
      const size = draft ? { width: halfSize(width), height: halfSize(height) } : { width, height };
      const writer = renderer.beginVideo(output, { width: size.width, height: size.height, fps, encoder });
      const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
      try {
        const total = last - first + 1;
        for (let frame = first; frame <= last; frame++) {
          const out = await source.frame(frame);
          clipFrames.push({ frame, audio: out.audio });
          const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
          writer.pushFrame(sceneJson, frame, source.baseDir);
          const done = frame - first + 1;
          if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
            context.progress(`rendering frame ${done}/${total}`);
          }
        }
        const clips = joinClips(clipFrames);
        let summary;
        if (clips.length > 0 || hasOnFrame(first, last)) {
          context.progress('mixing audio');
          const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir }));
          summary = writer.finish(pcm);
        } else {
          summary = writer.finish();
        }
        return result(summary, nowMs() - started);
      } catch (error) {
        try {
          writer.abort();
        } catch {
          // The writer may already be closed; the first error is the one to report.
        }
        throw error;
      }
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
