import { mkdtempSync, existsSync, renameSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { isCached } from './cache.js';
import { VideoMattingError } from './errors.js';
import { markLoaded, notDownloaded, requireMatting, type LoadProgress } from './loading.js';
import { DEFAULT_MODEL, modelPath, resolveModel, type VideoMattingModel } from './models.js';
import { hooks, tracked, type MatteVideoOptions } from './state.js';

/** What `outputWritable` receives (Mediabunny's `StreamTargetChunk`, which Remotion's option takes). */
export interface StreamTargetChunk {
  type: 'write';
  data: Uint8Array;
  position: number;
}

export interface VideoLayerOutputOptions {
  /** `arraybuffer` (the default): the layer is kept in a temporary file and `getBlob()` reads it. `web-fs` is the browser's file system and is refused. */
  outputTarget?: 'arraybuffer' | 'web-fs';
  /** Receives the encoded layer once it is finished, in chunks with their `position`. Cannot be combined with `outputTarget` or `path`. */
  outputWritable?: WritableStream<StreamTargetChunk>;
  /** Kinetograph: write the layer to this file (`.webm`, VP9 with alpha for the foreground; `.mov`, ProRes 4444) instead of a temporary one. The file is not deleted by `dispose()`. */
  path?: string;
}

export interface VideoLayerOutput {
  /** The encoded layer as a Blob; rejects when `outputWritable` was used. */
  getBlob(): Promise<Blob>;
  /** Deletes the layer's temporary file. Call it after `getBlob()` has resolved. Idempotent; a file at `path` is kept. */
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  /** Where the layer is: the `path` given, or the temporary file (until `dispose()`). Not in Remotion's API. */
  readonly path: string | null;
}

export type VideoBitrate = number | 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

export interface SeparateVideoLayersProgress {
  stage: 'processing' | 'finalizing';
  /** 0 to 1 while processing, `null` while finalizing. */
  progress: number | null;
  processedFrames: number;
  processedDurationInSeconds: number;
  durationInSeconds: number;
}

export interface SeparateVideoLayersOptions {
  /** A local path, a `file:` URL, an `http(s):` URL or a Blob (a File is one). */
  src: string | URL | Blob;
  /** Default `modnet`. */
  model?: VideoMattingModel;
  /** Which output gets the input's audio. Default `base`. */
  audio?: 'base' | 'foreground' | 'both' | 'none';
  /** `base: false` skips the base layer (not in Remotion's API); the result's `base` is then `null`. */
  outputs?: { base?: VideoLayerOutputOptions | false; foreground?: VideoLayerOutputOptions };
  /** Bits per second, or a preset. Default `very-high`. */
  videoBitrate?: VideoBitrate;
  audioBitrate?: VideoBitrate;
  /** Default 1. */
  keyframeIntervalInSeconds?: number;
  signal?: AbortSignal;
  onModelLoadProgress?: (progress: LoadProgress) => void;
  onProgress?: (progress: SeparateVideoLayersProgress) => void;
}

export interface SeparateVideoLayersResult {
  base: VideoLayerOutput;
  foreground: VideoLayerOutput;
  model: VideoMattingModel;
  width: number;
  height: number;
  durationInSeconds: number;
  processedFrames: number;
  /** The inference backend that ran the model (not in Remotion's API). */
  backend: string;
  [Symbol.asyncDispose](): Promise<void>;
}

const PRESETS = ['very-low', 'low', 'medium', 'high', 'very-high'] as const;
const AUDIO = ['base', 'foreground', 'both', 'none'] as const;
const invalid = (message: string) => new VideoMattingError('INVALID_ARG', message);

function checkBitrate(what: string, value: VideoBitrate | undefined): void {
  if (value === undefined) return;
  if (typeof value === 'number' ? Number.isInteger(value) && value > 0 : (PRESETS as readonly string[]).includes(value)) return;
  throw invalid(`${what} must be a positive whole number of bits per second or one of ${PRESETS.join(', ')}, got ${JSON.stringify(value)}`);
}

/** The addon has Remotion's five presets; a bit rate picks the nearest preset at or above it. */
function qualityOf(bitrate: VideoBitrate | undefined): MatteVideoOptions['quality'] {
  if (bitrate === undefined) return 'very-high';
  if (typeof bitrate === 'string') return bitrate;
  return bitrate <= 500_000 ? 'very-low' : bitrate <= 1_500_000 ? 'low' : bitrate <= 4_000_000 ? 'medium' : bitrate <= 10_000_000 ? 'high' : 'very-high';
}

function checkOutput(layer: 'base' | 'foreground', options: VideoLayerOutputOptions | undefined): void {
  if (options === undefined) return;
  const given = [options.outputTarget, options.outputWritable, options.path].filter((v) => v !== undefined).length;
  if (given > 1) throw invalid(`outputs.${layer}: outputTarget, outputWritable and path cannot be combined`);
  if (options.outputTarget === 'web-fs') throw invalid(`outputs.${layer}.outputTarget "web-fs" is the browser's file system; use "arraybuffer", outputWritable or path`);
  if (options.outputTarget !== undefined && options.outputTarget !== 'arraybuffer') throw invalid(`outputs.${layer}.outputTarget must be "arraybuffer", got ${JSON.stringify(options.outputTarget)}`);
  if (options.path !== undefined && !/\.(webm|mov)$/i.test(options.path)) throw invalid(`outputs.${layer}.path must end in .webm (VP9) or .mov (ProRes 4444), got "${options.path}"`);
}

function mimeOf(file: string): string {
  return extname(file).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/webm';
}

/** A layer file: temporary (deleted by `dispose()`), at the caller's `path` (kept), or streamed away (nothing left). */
function layerOutput(file: string | null, keep: boolean, streamed: boolean, release: () => void): VideoLayerOutput {
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (file !== null && !keep) rmSync(file, { force: true });
    release();
  };
  return {
    path: file === null ? null : file,
    async getBlob() {
      if (streamed || file === null) throw new VideoMattingError('INVALID_ARG', 'getBlob() is not available: the layer was sent to outputWritable');
      return new Blob([await readFile(file)], { type: mimeOf(file) });
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

/** Streams a finished file into a `WritableStream<StreamTargetChunk>` and closes it. */
async function sendTo(writable: WritableStream<StreamTargetChunk>, file: string): Promise<void> {
  const writer = writable.getWriter();
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await writer.write({ type: 'write', data: Uint8Array.from(buffer.subarray(0, bytesRead)), position });
      position += bytesRead;
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

/** The input as a local file: a path or `file:` URL as it is, a Blob or an `http(s):` URL copied to a temporary file. */
async function localInput(src: SeparateVideoLayersOptions['src'], signal: AbortSignal | undefined): Promise<{ file: string; temp: string | null }> {
  if (src instanceof Blob) {
    const temp = mkdtempSync(join(tmpdir(), 'kinetograph-matting-in-'));
    const file = join(temp, 'input.video');
    writeFileSync(file, Buffer.from(await src.arrayBuffer()));
    return { file, temp };
  }
  const text = src instanceof URL ? src.href : src;
  if (typeof text !== 'string' || text === '') throw invalid('src must be a path, a URL or a Blob');
  if (/^https?:\/\//i.test(text)) {
    const temp = mkdtempSync(join(tmpdir(), 'kinetograph-matting-in-'));
    const file = join(temp, `input${extname(new URL(text).pathname) || '.video'}`);
    try {
      const response = await hooks.fetch(text, { signal });
      if (!response.ok || response.body === null) throw new VideoMattingError('IO', `Fetching ${text} failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    return { file, temp };
  }
  const file = text.startsWith('file:') ? fileURLToPath(text) : resolve(text);
  if (!existsSync(file)) throw new VideoMattingError('IO', `src "${file}" does not exist`);
  return { file, temp: null };
}

export function separateVideoLayers(options: SeparateVideoLayersOptions & { outputs: { base: false } }): Promise<Omit<SeparateVideoLayersResult, 'base'> & { base: null }>;
export function separateVideoLayers(options: SeparateVideoLayersOptions): Promise<SeparateVideoLayersResult>;
/**
 * Separates a video into an opaque base and a foreground with alpha, by running the model in the addon
 * (`matteVideo`). The model must be downloaded first. Both layers are VP9 WebM (the foreground with alpha) unless
 * `outputs.*.path` ends in `.mov`.
 */
export async function separateVideoLayers(options: SeparateVideoLayersOptions): Promise<SeparateVideoLayersResult | (Omit<SeparateVideoLayersResult, 'base'> & { base: null })> {
  const spec = resolveModel(options.model, DEFAULT_MODEL);
  const audio = options.audio ?? 'base';
  if (!(AUDIO as readonly string[]).includes(audio)) throw invalid(`audio must be one of ${AUDIO.join(', ')}, got ${JSON.stringify(audio)}`);
  checkBitrate('videoBitrate', options.videoBitrate);
  checkBitrate('audioBitrate', options.audioBitrate);
  const keyframe = options.keyframeIntervalInSeconds;
  if (keyframe !== undefined && !(Number.isFinite(keyframe) && keyframe > 0)) throw invalid(`keyframeIntervalInSeconds must be a positive finite number, got ${keyframe}`);
  const wantBase = options.outputs?.base !== false;
  const baseOptions = options.outputs?.base === false ? undefined : options.outputs?.base;
  checkOutput('foreground', options.outputs?.foreground);
  checkOutput('base', baseOptions);
  options.signal?.throwIfAborted();

  const addon = requireMatting();
  if (!isCached(spec)) throw notDownloaded(spec.name);

  return tracked(spec.name, async () => {
    const input = await localInput(options.src, options.signal);
    const scratch = mkdtempSync(join(tmpdir(), 'kinetograph-matting-'));
    // What the addon writes: the caller's own path through a `.partial` sibling (renamed once finished), else a temporary file.
    const plan = (layer: 'base' | 'foreground', o: VideoLayerOutputOptions | undefined) => {
      const final = o?.path === undefined ? null : resolve(o.path);
      const ext = final === null ? '.webm' : extname(final);
      const written = final === null ? join(scratch, `${layer}${ext}`) : join(dirname(final), `.${basename(final, ext)}.partial${ext}`);
      return { final, written, writable: o?.outputWritable };
    };
    const fg = plan('foreground', options.outputs?.foreground);
    const bg = wantBase ? plan('base', baseOptions) : undefined;
    const parts = [fg, ...(bg ? [bg] : [])];
    const cleanup = () => {
      for (const p of parts) rmSync(p.written, { force: true });
      rmSync(scratch, { recursive: true, force: true });
      if (input.temp !== null) rmSync(input.temp, { recursive: true, force: true });
    };

    let info: { width: number; height: number; durationInSeconds: number; fps?: number | null };
    try {
      if (typeof addon.probeMedia !== 'function') throw new VideoMattingError('MATTING_UNAVAILABLE', "Video matting isn't in this build of @kinetographdev/native: it cannot probe media");
      info = addon.probeMedia(input.file);
    } catch (error) {
      cleanup();
      throw error;
    }
    const total = { frames: 0 };
    const progressOf = (done: number, of: number): SeparateVideoLayersProgress => {
      const fps = info.fps && info.fps > 0 ? info.fps : of > 0 && info.durationInSeconds > 0 ? of / info.durationInSeconds : 0;
      return {
        stage: 'processing',
        progress: of > 0 ? Math.min(1, done / of) : 0,
        processedFrames: done,
        processedDurationInSeconds: fps > 0 ? Math.min(info.durationInSeconds, done / fps) : 0,
        durationInSeconds: info.durationInSeconds,
      };
    };

    markLoaded(spec.name);
    options.onModelLoadProgress?.({ status: 'initializing', file: null, progress: null, loadedBytes: null, totalBytes: null });
    options.onModelLoadProgress?.({ status: 'ready', file: null, progress: 1, loadedBytes: null, totalBytes: null });

    const request: MatteVideoOptions = {
      input: input.file,
      modelPath: modelPath(spec),
      model: spec.name,
      foreground: fg.written,
      ...(bg ? { base: bg.written } : {}),
      keepAudio: audio !== 'none',
      quality: qualityOf(options.videoBitrate),
      audio,
      ...(typeof options.videoBitrate === 'number' ? { videoBitrate: options.videoBitrate } : {}),
      ...(options.audioBitrate !== undefined ? { audioBitrate: options.audioBitrate } : {}),
      ...(keyframe !== undefined ? { keyframeIntervalInSeconds: keyframe } : {}),
    };
    const job = addon.matteVideo(request, (done, of) => {
      total.frames = of;
      options.onProgress?.(progressOf(done, of));
    });
    // The addon cannot be stopped part way: an abort rejects now, and the job's files are removed when it ends.
    const finished = job.finally(() => undefined);
    let result;
    try {
      result = await new Promise<Awaited<typeof job>>((ok, fail) => {
        const onAbort = () => fail(options.signal?.reason);
        if (options.signal?.aborted) return onAbort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        job.then(ok, fail).finally(() => options.signal?.removeEventListener('abort', onAbort));
      });
    } catch (error) {
      void finished.then(cleanup, cleanup);
      throw error;
    }
    if (input.temp !== null) rmSync(input.temp, { recursive: true, force: true });

    try {
      options.onProgress?.({ stage: 'finalizing', progress: null, processedFrames: result.frames, processedDurationInSeconds: info.durationInSeconds, durationInSeconds: info.durationInSeconds });
      const outputs: VideoLayerOutput[] = [];
      let live = parts.length;
      const release = () => {
        live -= 1;
        if (live === 0) rmSync(scratch, { recursive: true, force: true });
      };
      for (const p of parts) {
        if (p.final !== null) renameSync(p.written, p.final);
        if (p.writable) await sendTo(p.writable, p.written);
        const file = p.final ?? p.written;
        if (p.writable) rmSync(file, { force: true });
        outputs.push(layerOutput(p.writable ? null : file, p.final !== null, p.writable !== undefined, release));
      }
      const [foreground, base] = outputs as [VideoLayerOutput, VideoLayerOutput | undefined];
      const dispose = async () => {
        await foreground.dispose();
        await base?.dispose();
      };
      return {
        base: base ?? null,
        foreground,
        model: spec.name as VideoMattingModel,
        width: info.width,
        height: info.height,
        durationInSeconds: info.durationInSeconds,
        processedFrames: result.frames,
        backend: result.backend,
        [Symbol.asyncDispose]: dispose,
      } as SeparateVideoLayersResult;
    } catch (error) {
      cleanup();
      throw error;
    }
  });
}
