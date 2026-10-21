import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
export type RenderResult = RenderSummary & {
  compat: CompatReport;
  /** The `<Artifact>` files written beside the video, as the names they have in its folder. */
  artifacts: string[];
};

/**
 * Writes the `<Artifact>` files that frames `first..=last` asked for into the folder of `output`: text and bytes as they
 * are, a thumbnail as the PNG of the frame it was rendered in.
 */
async function writeArtifacts(source: Source, renderer: Renderer, output: string, first: number, last: number, draft: boolean): Promise<string[]> {
  const written: string[] = [];
  const folder = dirname(output);
  for (const artifact of source.artifacts?.() ?? []) {
    if (artifact.frame < first || artifact.frame > last) continue;
    const file = join(folder, artifact.filename);
    let data: string | Uint8Array;
    if (artifact.content === 'thumbnail') {
      const out = await source.frame(artifact.frame);
      const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
      data = renderer.still(sceneJson, artifact.frame, source.baseDir);
    } else {
      data = artifact.content;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    written.push(artifact.filename);
  }
  return written;
}

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

  // A JSON scene goes to the addon whole: it has keyframes and no audio. What it holds that the engine cannot draw
  // (the glTF features a model uses that are not read) is the same on every frame.
  if (source.kind === 'scene') {
    let { sceneJson, unsupported = [] } = await source.frame(0);
    const leftOut = new LeftOutCollector();
    if (unsupported.length > 0) {
      const [first, last] = frameRange(range, durationInFrames);
      if (options.strict) throw strictError(first, unsupported);
      for (let frame = first; frame <= last; frame++) leftOut.add(frame, unsupported);
    }
    if (draft) sceneJson = JSON.stringify(draftScene(JSON.parse(sceneJson) as SceneJson));
    const summary = renderer.render(sceneJson, options.output, { range, encoder, baseDir: source.baseDir });
    return { ...summary, compat: leftOut.report(), artifacts: [] };
  }

  source.clearArtifacts?.();
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
    const artifacts = await writeArtifacts(source, renderer, options.output, first, last, draft);
    return { ...summary, compat: leftOut.report(), artifacts };
  } catch (error) {
    try {
      writer.abort();
    } catch {
      // The writer may already be closed; the first error is the one to report.
    }
    throw error;
  }
}
