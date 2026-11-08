import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { VideoMattingError } from './errors.js';
import { modelDir, modelPath, resolveModel, type ModelSpec, type VideoMattingModel } from './models.js';
import { hooks, loadedModels, tracked, whenIdle } from './state.js';

/** The file is cached when it is there at its full size: it is only ever put there, whole, after its SHA-256 matched. */
function isCached(spec: ModelSpec): boolean {
  try {
    return statSync(modelPath(spec)).size === spec.size;
  } catch {
    return false;
  }
}

export interface ModelOptions {
  model: VideoMattingModel;
}

/** Whether the model's file is in the cache. Does not download or load anything. */
export async function isVideoMattingModelCached({ model }: ModelOptions): Promise<boolean> {
  return isCached(resolveModel(model));
}

export interface DownloadProgress {
  /** The file being downloaded, or `null` for the whole model. */
  file: string | null;
  /** 0 to 1. */
  progress: number;
  /** Bytes downloaded in this call (a resumed download does not count what an earlier one fetched). */
  loadedBytes: number;
  /** The model's size in bytes. */
  totalBytes: number;
}

export interface DownloadVideoMattingModelOptions extends ModelOptions {
  /** Aborting rejects with the signal's reason and removes the incomplete file. */
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

/** The URL of the pinned file: the Hugging Face original, never a mirror. */
function sourceUrl(spec: ModelSpec): string {
  return `https://huggingface.co/${spec.modelId}/resolve/${spec.revision}/${spec.file}`;
}

async function sha256Of(file: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
}

/** The first byte of a `Content-Range: bytes 100-199/200` header. */
function rangeStart(header: string | null): number | null {
  const m = header === null ? null : /^bytes (\d+)-/.exec(header);
  return m ? Number(m[1]) : null;
}

const downloading = new Map<string, Promise<unknown>>();

async function download(spec: ModelSpec, { signal, onProgress }: Omit<DownloadVideoMattingModelOptions, 'model'>): Promise<void> {
  const dir = modelDir(spec);
  const final = modelPath(spec);
  const part = `${final}.part`;
  mkdirSync(dir, { recursive: true });

  // An earlier download that stopped is carried on from where it was (its bytes are hashed again with the new ones).
  let offset = 0;
  try {
    offset = statSync(part).size;
  } catch {
    offset = 0;
  }
  if (offset >= spec.size) {
    rmSync(part, { force: true });
    offset = 0;
  }
  const discard = () => rmSync(part, { force: true });

  let handle;
  try {
    const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
    const response = await hooks.fetch(sourceUrl(spec), { headers, signal, redirect: 'follow' });
    if (offset > 0 && (response.status === 416 || (response.status === 206 && rangeStart(response.headers.get('content-range')) !== offset))) {
      // The partial file does not fit what the server holds: start over.
      await response.body?.cancel().catch(() => undefined);
      discard();
      return await download(spec, { signal, onProgress });
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new VideoMattingError('MODEL_DOWNLOAD', `Downloading ${spec.modelId} failed: HTTP ${response.status} from ${sourceUrl(spec)}`);
    }
    // A server that ignores the range sends the whole file with a 200.
    if (offset > 0 && response.status === 200) offset = 0;

    const hash = createHash('sha256');
    if (offset > 0) await sha256Of(part, hash);
    handle = await open(part, offset > 0 ? 'a' : 'w');

    let loaded = 0;
    let reported = -1;
    const report = (force: boolean) => {
      const progress = Math.min(1, (offset + loaded) / spec.size);
      if (!force && progress - reported < 0.01) return;
      reported = progress;
      const base = { progress, loadedBytes: loaded, totalBytes: spec.size };
      onProgress?.({ file: basename(spec.file), ...base });
      onProgress?.({ file: null, ...base });
    };
    report(true);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal?.throwIfAborted();
      await handle.write(chunk);
      hash.update(chunk);
      loaded += chunk.byteLength;
      report(false);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const size = offset + loaded;
    const digest = hash.digest('hex');
    if (size !== spec.size || digest !== spec.sha256) {
      discard();
      throw new VideoMattingError(
        'MODEL_CHECKSUM',
        `The download of ${spec.modelId} (${spec.file} at ${spec.revision.slice(0, 12)}) does not match the pinned file: expected ${spec.size} bytes with SHA-256 ${spec.sha256}, got ${size} bytes with ${digest}`,
      );
    }
    report(true);
    renameSync(part, final);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (signal?.aborted) {
      discard();
      throw signal.reason;
    }
    // Any other failure leaves the partial file for the next call to carry on from.
    if (error instanceof VideoMattingError) throw error;
    throw new VideoMattingError('MODEL_DOWNLOAD', `Downloading ${spec.modelId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Downloads the model from Hugging Face into the cache and checks it against its pinned SHA-256. The file is written
 * as `<name>.part` and renamed once it matches, so the cache never holds a half-written or wrong model; a download
 * that failed carries on from where it stopped.
 */
export async function downloadVideoMattingModel(options: DownloadVideoMattingModelOptions): Promise<{ alreadyDownloaded: boolean }> {
  const spec = resolveModel(options.model);
  options.signal?.throwIfAborted();
  if (isCached(spec)) return { alreadyDownloaded: true };
  // One download of a model at a time in this process: a second call waits, then finds the file.
  const before = downloading.get(spec.name);
  const run = (async () => {
    await before?.catch(() => undefined);
    options.signal?.throwIfAborted();
    if (isCached(spec)) return { alreadyDownloaded: true };
    await tracked(spec.name, () => download(spec, options));
    return { alreadyDownloaded: false };
  })();
  downloading.set(spec.name, run);
  try {
    return await run;
  } finally {
    if (downloading.get(spec.name) === run) downloading.delete(spec.name);
  }
}

/** Deletes the model's files (and an unfinished download) from the cache; waits for what is using it first. */
export async function removeVideoMattingModel({ model }: ModelOptions): Promise<void> {
  const spec = resolveModel(model);
  await whenIdle(spec.name);
  loadedModels.clear(spec.name);
  const dir = modelDir(spec);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export { isCached };
