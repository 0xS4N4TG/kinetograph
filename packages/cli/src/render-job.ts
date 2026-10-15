import { clampPcm, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import type { Renderer, RenderSummary } from '@kinetograph/native';
import type { AudioClipJson, SceneJson } from '@kinetograph/scene';
import { CliError } from './errors.js';
import { draftScene, halfSize } from './scenes.js';
import { frameRange, type Source } from './source.js';

export interface RenderJobOptions {
  output: string;
  /** `10..40` (10 to 39) or `10..=40`; default all frames. */
  range?: string;
  encoder?: string;
  /** Half size. */
  draft?: boolean;
  /** Called after each frame of a project is pushed to the encoder. */
  onFrame?(done: number, total: number): void;
  /** Progress for people, e.g. "mixing audio". */
  progress?(message: string): void;
  /** Checked before each frame of a project; true aborts the render with a `CANCELLED` error and no output file. */
  shouldCancel?(): boolean;
}

/**
 * Renders `source` to `options.output` with `renderer` (the `render` command, docs/AUTHORING.md §9): a `.json` scene
 * goes to the addon whole, a project is pushed frame by frame and its audio mixed at the end.
 */
export async function renderSource(
  source: Source,
  renderer: Renderer,
  options: RenderJobOptions,
): Promise<RenderSummary> {
  const { range, encoder, draft = false } = options;
  const { durationInFrames, fps, width, height } = source.composition;

  // A JSON scene goes to the addon whole: it has keyframes and no audio.
  if (source.kind === 'scene') {
    let { sceneJson } = await source.frame(0);
    if (draft) sceneJson = JSON.stringify(draftScene(JSON.parse(sceneJson) as SceneJson));
    return renderer.render(sceneJson, options.output, { range, encoder, baseDir: source.baseDir });
  }

  const [first, last] = frameRange(range, durationInFrames);
  const size = draft ? { width: halfSize(width), height: halfSize(height) } : { width, height };
  const writer = renderer.beginVideo(options.output, { width: size.width, height: size.height, fps, encoder });
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  try {
    const total = last - first + 1;
    for (let frame = first; frame <= last; frame++) {
      if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
      const out = await source.frame(frame);
      clipFrames.push({ frame, audio: out.audio });
      const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
      writer.pushFrame(sceneJson, frame, source.baseDir);
      options.onFrame?.(frame - first + 1, total);
    }
    const clips = joinClips(clipFrames);
    if (clips.length > 0 || hasOnFrame(first, last)) {
      options.progress?.('mixing audio');
      const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir }));
      return writer.finish(pcm);
    }
    return writer.finish();
  } catch (error) {
    try {
      writer.abort();
    } catch {
      // The writer may already be closed; the first error is the one to report.
    }
    throw error;
  }
}
