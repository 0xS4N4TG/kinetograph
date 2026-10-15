import { clampPcm, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import { pathFor, planRuns, type CompatMode } from '@kinetograph/compat';
import type { Renderer, RenderSummary } from '@kinetograph/native';
import type { AudioClipJson, SceneJson, Unsupported } from '@kinetograph/scene';
import { LeftOutCollector, type CompatReport } from './compat-report.js';
import { CliError } from './errors.js';
import { openChromeRenderer, type ChromeFrame, type ChromeOptions, type ChromeRenderer } from './fallback/index.js';
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
   * What happens to frames the native path cannot draw (docs/COMPAT.md §6.1): `auto` (the default) draws them in
   * Chrome, `native` draws everything natively and reports what it left out, `chrome` draws every frame in Chrome.
   */
  compat?: CompatMode;
  /** Starts Chrome the first time a frame needs it. Tests pass a stand-in. */
  openChrome?(source: Source, options: ChromeOptions): Promise<ChromeRenderer>;
  /** Called after each frame of a project is pushed to the encoder. */
  onFrame?(done: number, total: number): void;
  /** Progress for people, e.g. "mixing audio". */
  progress?(message: string): void;
  /** Checked before each frame of a project; true aborts the render with a `CANCELLED` error and no output file. */
  shouldCancel?(): boolean;
}

/** What a render did, beside the encoder's `RenderSummary`. */
export type RenderResult = RenderSummary & { compat: CompatReport };

const NONE: readonly Unsupported[] = [];

/** `picture` as a `width` x `height` frame: Chrome rounds a half-size draft the other way on an odd size. */
export function fitFrame(picture: ChromeFrame, width: number, height: number): ChromeFrame {
  if (picture.width === width && picture.height === height) return picture;
  if (picture.width < width || picture.height < height) {
    throw new CliError('CHROME_FRAME_FAILED', `Chrome drew ${picture.width}x${picture.height}, but the video is ${width}x${height}`);
  }
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    picture.data.copy(data, y * width * 4, y * picture.width * 4, y * picture.width * 4 + width * 4);
  }
  return { width, height, data };
}

/**
 * Renders `source` to `options.output` with `renderer` (the `render` command, docs/AUTHORING.md §9): a `.json` scene
 * goes to the addon whole, a project is pushed frame by frame and its audio mixed at the end.
 *
 * A project's frame goes to the addon unless it holds something the native path cannot draw, and then (with `compat`
 * `auto`) to Chrome. The decision is per frame, never per scene (HANDOFF.md §9): both kinds of frame go into one video
 * writer, in frame order, so a transition that overlaps two scenes is drawn by whichever path each of its frames needs.
 * The frames are decided as they come, which is what `planRuns` would decide for the whole range; it is used for the
 * summary's runs.
 */
export async function renderSource(
  source: Source,
  renderer: Renderer,
  options: RenderJobOptions,
): Promise<RenderResult> {
  const { range, encoder, draft = false } = options;
  const mode = options.compat ?? 'auto';
  const { durationInFrames, fps, width, height } = source.composition;

  // A JSON scene goes to the addon whole: it has keyframes and no audio.
  if (source.kind === 'scene') {
    let { sceneJson } = await source.frame(0);
    if (draft) sceneJson = JSON.stringify(draftScene(JSON.parse(sceneJson) as SceneJson));
    const summary = renderer.render(sceneJson, options.output, { range, encoder, baseDir: source.baseDir });
    return { ...summary, compat: { mode, nativeFrames: summary.frames, chromeFrames: 0, runs: [], leftOut: [] } };
  }

  const [first, last] = frameRange(range, durationInFrames);
  const size = draft ? { width: halfSize(width), height: halfSize(height) } : { width, height };
  const writer = renderer.beginVideo(options.output, { width: size.width, height: size.height, fps, encoder });
  const clipFrames: { frame: number; audio: AudioClipJson[] }[] = [];
  const decided: { frame: number; unsupported: readonly Unsupported[] }[] = [];
  const leftOut = new LeftOutCollector();
  const openChrome = options.openChrome ?? openChromeRenderer;
  let chrome: ChromeRenderer | null = null;
  try {
    const total = last - first + 1;
    for (let frame = first; frame <= last; frame++) {
      if (options.shouldCancel?.()) throw new CliError('CANCELLED', 'the render was cancelled');
      const out = await source.frame(frame);
      clipFrames.push({ frame, audio: out.audio });
      const unsupported = out.unsupported ?? NONE;
      // Only `auto` reads what a frame holds; the other modes decide without it.
      decided.push({ frame, unsupported: mode === 'auto' ? unsupported : NONE });
      if (mode === 'native') leftOut.add(frame, unsupported);

      if (pathFor(unsupported, mode) === 'native') {
        const sceneJson = draft ? JSON.stringify(draftScene(JSON.parse(out.sceneJson) as SceneJson)) : out.sceneJson;
        writer.pushFrame(sceneJson, frame, source.baseDir);
      } else {
        // Chrome starts the first time a frame needs it: a project that never does never loads it.
        chrome ??= await openChrome(source, { progress: options.progress, scale: draft ? 0.5 : 1 });
        const picture = fitFrame(await chrome.frame(frame), size.width, size.height);
        writer.pushRgba(picture.data, picture.width, picture.height, frame);
      }
      options.onFrame?.(frame - first + 1, total);
    }
    const runs = planRuns(decided, mode);
    const chromeFrames = runs.filter((r) => r.path === 'chrome').reduce((n, r) => n + (r.last - r.first + 1), 0);
    const compat: CompatReport = { mode, nativeFrames: total - chromeFrames, chromeFrames, runs, leftOut: leftOut.result() };

    const clips = joinClips(clipFrames);
    let summary: RenderSummary;
    if (clips.length > 0 || hasOnFrame(first, last)) {
      options.progress?.('mixing audio');
      const pcm = clampPcm(await renderAudio({ fps, first, last, clips, baseDir: source.baseDir }));
      summary = writer.finish(pcm);
    } else {
      summary = writer.finish();
    }
    return { ...summary, compat };
  } catch (error) {
    try {
      writer.abort();
    } catch {
      // The writer may already be closed; the first error is the one to report.
    }
    throw error;
  } finally {
    await chrome?.close().catch(() => undefined);
  }
}
