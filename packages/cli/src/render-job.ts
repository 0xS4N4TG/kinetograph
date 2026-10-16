import { clampPcm, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import { resolveSoundSource } from '@kinetograph/core/sound-source';
import type { Renderer, RenderSummary } from '@kinetograph/native';
import type { AudioClipJson, SceneJson } from '@kinetograph/scene';
import { LeftOutCollector, strictError, type CompatReport } from './compat-report.js';
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
  /**
   * Fail with `UNSUPPORTED_CONTENT` on the first frame that holds something the engine cannot draw (docs/COMPAT.md
   * §6.1), instead of drawing it without. Default off: the report says what was left out.
   */
  strict?: boolean;
  /** Called after each frame of a project is pushed to the encoder. */
  onFrame?(done: number, total: number): void;
  /** Progress for people, e.g. "mixing audio". */
  progress?(message: string): void;
  /** Checked before each frame of a project; true aborts the render with a `CANCELLED` error and no output file. */
  shouldCancel?(): boolean;
}

/** What a render did, beside the encoder's `RenderSummary`. */
export type RenderResult = RenderSummary & { compat: CompatReport };

/**
 * Renders `source` to `options.output` with `renderer` (the `render` command, docs/AUTHORING.md §9): a `.json` scene
 * goes to the addon whole, a project is pushed frame by frame and its audio mixed at the end.
 *
 * Every frame goes to the addon. One that holds something the engine cannot draw is drawn without it, and the summary
 * lists what was left out; with `strict` it fails the render instead.
 */
export async function renderSource(
  source: Source,
  renderer: Renderer,
  options: RenderJobOptions,
): Promise<RenderResult> {
  const { range, encoder, draft = false } = options;
  const { durationInFrames, fps, width, height } = source.composition;

  // A JSON scene goes to the addon whole: it has keyframes and no audio.
  if (source.kind === 'scene') {
    let { sceneJson } = await source.frame(0);
    if (draft) sceneJson = JSON.stringify(draftScene(JSON.parse(sceneJson) as SceneJson));
    const summary = renderer.render(sceneJson, options.output, { range, encoder, baseDir: source.baseDir });
    return { ...summary, compat: new LeftOutCollector().report() };
  }

  const [first, last] = frameRange(range, durationInFrames);
  const size = draft ? { width: halfSize(width), height: halfSize(height) } : { width, height };
  const writer = renderer.beginVideo(options.output, { width: size.width, height: size.height, fps, encoder });
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  const leftOut = new LeftOutCollector();
  try {
    const total = last - first + 1;
    for (let frame = first; frame <= last; frame++) {
      if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
      const out = await source.frame(frame);
      clipFrames.push({ frame, audio: out.audio });
      const unsupported = out.unsupported ?? [];
      if (options.strict && unsupported.length > 0) throw strictError(frame, unsupported);
      leftOut.add(frame, unsupported);
      const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
      writer.pushFrame(sceneJson, frame, source.baseDir);
      options.onFrame?.(frame - first + 1, total);
    }
    const clips = joinClips(clipFrames);
    let summary: RenderSummary;
    if (clips.length > 0 || hasOnFrame(first, last)) {
      options.progress?.('mixing audio');
      const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir, resolveSource: resolveSoundSource }));
      summary = writer.finish(pcm);
    } else {
      summary = writer.finish();
    }
    return { ...summary, compat: leftOut.report() };
  } catch (error) {
    try {
      writer.abort();
    } catch {
      // The writer may already be closed; the first error is the one to report.
    }
    throw error;
  }
}
