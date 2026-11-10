import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clampPcm, hasAudibleClip, hasOnFrame, joinClips, renderAudio } from '@kinetographdev/audio';
import { resolveSoundSource } from '@kinetographdev/core/sound-source';
import type { ExportOptions, Renderer, RenderSummary } from '@kinetographdev/native';
import type { ArtifactRecord } from '@kinetographdev/core';
import type { AudioClipJson, SceneJson, Unsupported } from '@kinetographdev/scene';
import { CHUNK_FRAMES, renderInParallel } from './parallel-render.js';
import { ProfileLog, now, profiling, stage, takeAddon, takeJs, writeShared } from './profile.js';
import { LeftOutCollector, strictError, type CompatReport } from './compat-report.js';
import { CliError } from './errors.js';
import { usesGpuYuv } from './gpu-yuv.js';
import { encodeFrame, sequenceFileName, type ImageFormat } from './image-sequence.js';
import { native } from './native.js';
import { scaleScene, scaledSize } from './scenes.js';
import { frameRange, type Source } from './source.js';
import { nowMs } from './time.js';

export interface RenderJobOptions {
  /** The video file; with `sequence`, the folder the image files go in. */
  output: string;
  /** `10..40` (10 to 39) or `10..=40`; default all frames. */
  range?: string;
  encoder?: string;
  /** Output size multiplier (default 1): the compositor draws at the scaled size, sides rounded down to even. */
  scale?: number;
  /** Half size: `scale: 0.5`. */
  draft?: boolean;
  /**
   * Write one image file per frame into `output`, named `<stem>-<frame>.<format>`, instead of a video. No audio is
   * written; the video options (`export`, `encoder`, `everyNthFrame`) must be left out.
   */
  sequence?: { format: ImageFormat; stem: string };
  /** Codec, quality, pixel format and audio (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §9). */
  export?: ExportOptions;
  /** GIF: draw every nth frame of the range (a project only). */
  everyNthFrame?: number;
  /** Run React's development build in the worker threads (the main thread is set by the caller). */
  devReact?: boolean;
  /** `--preferred-effect-backend`, told to the worker threads (the main thread is set by the caller). */
  preferredEffectBackend?: string;
  /**
   * Fail with `UNSUPPORTED_CONTENT` on the first frame that holds something the engine cannot draw (kinetograph site, /docs/compat/), instead of drawing it without. Default off: the report says what was left out.
   */
  strict?: boolean;
  /**
   * Frames drawn at once (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §9): the composition's JS runs in this many worker threads, each with a
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
  /** The `<Artifact>` files written beside the video (beside the sequence's folder), as the names they have in it. */
  artifacts: string[];
  /** `--sequence` only: what the render did not do, e.g. that audio is not written (also on stderr, which `--json` silences). */
  warnings?: string[];
};

/**
 * Writes the `<Artifact>` files that frames `first..=last` asked for into `folder`: text and bytes as they are, a
 * thumbnail as the PNG of the frame it was rendered in.
 */
async function writeArtifacts(
  source: Source,
  renderer: Renderer,
  folder: string,
  first: number,
  last: number,
  scale: number,
  records: ArtifactRecord[],
): Promise<string[]> {
  const written: string[] = [];
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
 * `render --sequence`: frames `range` of `source` as one image file each in the folder `options.output`, a project's
 * and a `.json` scene's alike. The workers of `concurrency` draw projects, as for a video, and the files are written in
 * frame order, so they are the same whichever count draws them. What the frames left out is decided per frame, as for a
 * video. No audio is written; a warning says so when the frames have any.
 */
async function renderSequence(
  source: Source,
  renderer: Renderer,
  options: RenderJobOptions & { sequence: NonNullable<RenderJobOptions['sequence']> },
): Promise<RenderResult> {
  const { format, stem } = options.sequence;
  const folder = options.output;
  const scale = options.scale ?? (options.draft ? 0.5 : 1);
  const { durationInFrames, fps, width, height } = source.composition;
  const [first, last] = frameRange(options.range, durationInFrames);
  const total = last - first + 1;
  const size = scale !== 1 ? { width: scaledSize(width, scale), height: scaledSize(height, scale) } : { width, height };
  const started = nowMs();
  mkdirSync(folder, { recursive: true });
  source.clearArtifacts?.();
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  const leftOut = new LeftOutCollector();
  let artifactRecords: ArtifactRecord[] = [];
  const onFrame = (frame: number, audio: AudioClipJson[], unsupported: Unsupported[]): void => {
    clipFrames.push({ frame, audio });
    if (options.strict && unsupported.length > 0) throw strictError(frame, unsupported);
    leftOut.add(frame, unsupported);
  };
  const write = (frame: number, bytes: Uint8Array): void => {
    writeFileSync(join(folder, sequenceFileName(stem, frame, durationInFrames - 1, format)), bytes);
  };
  const pushed = (index: number): void => options.onFrame?.(index + 1, total);
  const workers = Math.min(options.concurrency ?? 1, Math.ceil(total / CHUNK_FRAMES));
  if (workers > 1 && source.worker) {
    artifactRecords = await renderInParallel({
      spec: source.worker,
      scale,
      convertFormat: '',
      sequence: format,
      devReact: options.devReact ?? false,
      preferredEffectBackend: options.preferredEffectBackend,
      origin: first,
      step: 1,
      workers,
      count: total,
      push: (index, data) => write(first + index, data),
      onFrame: (index, audio, unsupported) => onFrame(first + index, audio, unsupported),
      onPushed: pushed,
      shouldCancel: options.shouldCancel,
    });
  } else {
    for (let index = 0; index < total; index++) {
      if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
      const frame = first + index;
      const out = await source.frame(frame);
      onFrame(frame, out.audio, out.unsupported ?? []);
      const sceneJson = scale !== 1 ? JSON.stringify(scaleScene(JSON.parse(out.sceneJson) as SceneJson, scale)) : out.sceneJson;
      write(frame, encodeFrame(renderer, format, sceneJson, frame, source.baseDir));
      pushed(index);
    }
    artifactRecords = source.artifacts?.() ?? [];
  }
  const warnings: string[] = [];
  if (hasAudibleClip(joinClips(clipFrames)) || hasOnFrame(first, last)) {
    warnings.push('audio is not written: --sequence writes images only (render without it for a video with sound)');
  }
  for (const warning of warnings) options.progress?.(warning);
  // Beside the folder, as a video's are beside the video: a `*.png` of the folder holds frames only.
  const artifacts = await writeArtifacts(source, renderer, dirname(folder), first, last, scale, artifactRecords);
  const ms = nowMs() - started;
  return {
    output: folder,
    encoder: format,
    codec: format,
    pixelFormat: format === 'png' ? 'rgba' : 'rgb',
    ...size,
    fps,
    frames: total,
    first,
    last,
    ms,
    msPerFrame: ms / total,
    audio: false,
    repeated: 0,
    compat: leftOut.report(),
    artifacts,
    warnings,
  };
}

/**
 * Renders `source` to `options.output` with `renderer` (the `render` command, packages/cli/skills/kinetograph-markup/references/AUTHORING.md §9): a `.json` scene
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
  if (options.sequence) return renderSequence(source, renderer, { ...options, sequence: options.sequence });
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
  // The frames drawn: first, first + step, ... (step is 1 unless a GIF asks for fewer).
  const total = Math.floor((last - first) / step) + 1;
  const workers = Math.min(options.concurrency ?? 1, Math.ceil(total / CHUNK_FRAMES));
  const parallel = workers > 1 && source.worker !== undefined;
  // This thread draws the frames: the GPU converts them to yuv420p, as in a worker, for the writer to send as they are.
  // Off again once the video is finished or aborted, as the renderer is used after it.
  const gpuYuv = !parallel && usesGpuYuv(plan.convertFormat, undefined);
  if (gpuYuv) renderer.setYuv420(true);
  stage('beginVideo');
  let writer: ReturnType<Renderer['beginVideo']>;
  try {
    writer = renderer.beginVideo(options.output, { width: size.width, height: size.height, fps, encoder, export: exported });
  } catch (error) {
    if (gpuYuv) renderer.setYuv420(false);
    throw error;
  }
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  const leftOut = new LeftOutCollector();
  let artifactRecords: ArtifactRecord[] = [];
  // Frames the workers did not draw because each was the same as the one before (the writer counts its own).
  let parallelRepeats = 0;
  try {
    const frameAt = (index: number): number => first + index * step;
    const onFrame = (frame: number, audio: AudioClipJson[], unsupported: Unsupported[]): void => {
      clipFrames.push({ frame, audio });
      if (options.strict && unsupported.length > 0) throw strictError(frame, unsupported);
      leftOut.add(frame, unsupported);
    };
    const pushed = (index: number): void => options.onFrame?.(index + 1, total);
    if (parallel && source.worker) {
      // The workers number the frames drawn 0..total-1; `frameAt` says which frame of the composition each is.
      artifactRecords = await renderInParallel({
        spec: source.worker,
        scale,
        convertFormat: plan.convertFormat,
        devReact: options.devReact ?? false,
        preferredEffectBackend: options.preferredEffectBackend,
        origin: first,
        step,
        workers,
        count: total,
        push: (index, data) => writer.pushYuv(data, index),
        onFrame: (index, audio, unsupported, repeated) => {
          if (repeated) parallelRepeats += 1;
          onFrame(frameAt(index), audio, unsupported);
        },
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
    stage('frames pushed (loop end)');
    const clips = joinClips(clipFrames);
    let summary: RenderSummary;
    // A GIF has no sound. A render whose clips are all muted (or at volume 0) and with no onFrame callback has none either.
    if (plan.audioCodec !== undefined && (hasAudibleClip(clips) || hasOnFrame(first, last))) {
      options.progress?.('mixing audio');
      stage('audio mix start');
      const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir, resolveSource: resolveSoundSource }));
      stage('audio mix done');
      summary = writer.finish(pcm);
    } else {
      summary = writer.finish();
    }
    if (gpuYuv) renderer.setYuv420(false);
    stage('writer.finish done');
    writeShared();
    const artifacts = await writeArtifacts(source, renderer, dirname(options.output), first, last, scale, artifactRecords);
    return { ...summary, repeated: summary.repeated + parallelRepeats, compat: leftOut.report(), artifacts };
  } catch (error) {
    try {
      writer.abort();
    } catch {
      // The writer may already be closed; the first error is the one to report.
    }
    if (gpuYuv) renderer.setYuv420(false);
    throw error;
  }
}
