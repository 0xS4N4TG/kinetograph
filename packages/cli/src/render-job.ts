import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clampPcm, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import { resolveSoundSource } from '@kinetograph/core/sound-source';
import type { ExportOptions, Renderer, RenderSummary } from '@kinetograph/native';
import type { ArtifactRecord } from '@kinetograph/core';
import type { AudioClipJson, SceneJson, Unsupported } from '@kinetograph/scene';
import { CHUNK_FRAMES, renderInParallel } from './parallel-render.js';
import { ProfileLog, now, profiling, takeAddon, takeJs, writeShared } from './profile.js';
import { LeftOutCollector, strictError, type CompatReport } from './compat-report.js';
import { CliError } from './errors.js';
import { native } from './native.js';
import { scaleScene, scaledSize } from './scenes.js';
import { frameRange, type Source } from './source.js';

export interface RenderJobOptions {
  output: string;
  /** `10..40` (10 to 39) or `10..=40`; default all frames. */
  range?: string;
  encoder?: string;
  /** Output size multiplier (default 1): the compositor draws at the scaled size, sides rounded down to even. */
  scale?: number;
  /** Half size: `scale: 0.5`. */
  draft?: boolean;
  /** Codec, quality, pixel format and audio (docs/AUTHORING.md §9). */
  export?: ExportOptions;
  /** GIF: draw every nth frame of the range (a project only). */
  everyNthFrame?: number;
  /** Run React's development build in the worker threads (the main thread is set by the caller). */
  devReact?: boolean;
  /**
   * Fail with `UNSUPPORTED_CONTENT` on the first frame that holds something the engine cannot draw (docs/COMPAT.md
   * §6.1), instead of drawing it without. Default off: the report says what was left out.
   */
  strict?: boolean;
  /**
   * Frames drawn at once (docs/AUTHORING.md §9): the composition's JS runs in this many worker threads, each with a
   * renderer of its own, and the frames are encoded in order. Default 1, which draws every frame in this thread. Only a
   * project (not a `.json` scene, which the addon draws whole) uses more.
   */
  concurrency?: number;
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
async function writeArtifacts(
  source: Source,
  renderer: Renderer,
  output: string,
  first: number,
  last: number,
  scale: number,
  records: ArtifactRecord[],
): Promise<string[]> {
  const written: string[] = [];
  const folder = dirname(output);
  for (const artifact of records) {
    if (artifact.frame < first || artifact.frame > last) continue;
    const file = join(folder, artifact.filename);
    let data: string | Uint8Array;
    if (artifact.content === 'thumbnail') {
      const out = await source.frame(artifact.frame);
      const sceneJson = scale !== 1 ? JSON.stringify(scaleScene(JSON.parse(out.sceneJson) as SceneJson, scale)) : out.sceneJson;
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
  const { range, encoder } = options;
  const scale = options.scale ?? (options.draft ? 0.5 : 1);
  const { durationInFrames, fps, width, height } = source.composition;
  const exported: ExportOptions = { ...options.export, encoder: options.export?.encoder ?? encoder };
  // Checked before anything is drawn: the codec against the path, the options against one another and this ffmpeg.
  const plan = native().resolveExport(options.output, exported);
  const step = options.everyNthFrame ?? 1;

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
    if (step !== 1) throw new CliError('INVALID_ARG', '--every-nth-frame needs a project; a .json scene is drawn whole');
    if (scale !== 1) sceneJson = JSON.stringify(scaleScene(JSON.parse(sceneJson) as SceneJson, scale));
    const summary = renderer.render(sceneJson, options.output, { range, encoder, export: exported, baseDir: source.baseDir });
    return { ...summary, compat: leftOut.report(), artifacts: [] };
  }

  source.clearArtifacts?.();
  const [first, last] = frameRange(range, durationInFrames);
  const size = scale !== 1 ? { width: scaledSize(width, scale), height: scaledSize(height, scale) } : { width, height };
  const writer = renderer.beginVideo(options.output, { width: size.width, height: size.height, fps, encoder, export: exported });
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  const leftOut = new LeftOutCollector();
  let artifactRecords: ArtifactRecord[] = [];
  try {
    // The frames drawn: first, first + step, ... (step is 1 unless a GIF asks for fewer).
    const total = Math.floor((last - first) / step) + 1;
    const frameAt = (index: number): number => first + index * step;
    const workers = Math.min(options.concurrency ?? 1, Math.ceil(total / CHUNK_FRAMES));
    const onFrame = (frame: number, audio: AudioClipJson[], unsupported: Unsupported[]): void => {
      clipFrames.push({ frame, audio });
      if (options.strict && unsupported.length > 0) throw strictError(frame, unsupported);
      leftOut.add(frame, unsupported);
    };
    const pushed = (index: number): void => options.onFrame?.(index + 1, total);
    if (workers > 1 && source.worker) {
      // The workers number the frames drawn 0..total-1; `frameAt` says which frame of the composition each is.
      artifactRecords = await renderInParallel({
        spec: source.worker,
        scale,
        convertFormat: plan.convertFormat,
        devReact: options.devReact ?? false,
        origin: first,
        step,
        workers,
        count: total,
        writer,
        onFrame: (index, audio, unsupported) => onFrame(frameAt(index), audio, unsupported),
        onPushed: pushed,
        shouldCancel: options.shouldCancel,
      });
    } else {
      const log = profiling ? new ProfileLog(true) : undefined;
      for (let index = 0; index < total; index++) {
        if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
        const frame = frameAt(index);
        const t0 = log ? now() : 0;
        const out = await source.frame(frame);
        const t1 = log ? now() : 0;
        onFrame(frame, out.audio, out.unsupported ?? []);
        const sceneJson = scale !== 1 ? JSON.stringify(scaleScene(JSON.parse(out.sceneJson) as SceneJson, scale)) : out.sceneJson;
        writer.pushFrame(sceneJson, frame, source.baseDir);
        if (log) {
          const t2 = now();
          log.add({ f: frame, t0, t1, t2, js: out.jsMs, stringify: out.stringifyMs, push: t2 - t1, ...takeJs(), ...takeAddon() });
        }
        pushed(index);
      }
      log?.flush();
      artifactRecords = source.artifacts?.() ?? [];
    }
    const clips = joinClips(clipFrames);
    let summary: RenderSummary;
    // A GIF has no sound.
    if (plan.audioCodec !== undefined && (clips.length > 0 || hasOnFrame(first, last))) {
      options.progress?.('mixing audio');
      const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir, resolveSource: resolveSoundSource }));
      summary = writer.finish(pcm);
    } else {
      summary = writer.finish();
    }
    writeShared();
    const artifacts = await writeArtifacts(source, renderer, options.output, first, last, scale, artifactRecords);
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
