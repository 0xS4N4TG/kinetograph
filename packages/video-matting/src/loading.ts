import { isCached } from './cache.js';
import { VideoMattingError } from './errors.js';
import { DEFAULT_MODEL, resolveModel, type VideoMattingModel } from './models.js';
import { addonLoadError, loadAddon, loadedModels, tracked, whenIdle, type MattingAddon, type MattingSupport } from './state.js';

export type VideoMattingUnsupportedReason = 'native-unavailable' | 'backend-unavailable';

export type CanUseVideoMattingResult =
  | { supported: true; /** The inference backend: `coreml`, `directml`, `cuda`, `webgpu` or `cpu`. */ backend: MattingSupport['backend'] }
  | { supported: false; reason: VideoMattingUnsupportedReason; detailedReason: string };

/**
 * Whether this machine can run video matting: the addon has it, and an inference backend is available. Unlike
 * Remotion's, the reasons are native ones: `native-unavailable` (this build of the addon has no matting) and
 * `backend-unavailable` (the addon found nothing to run a model on; `detailedReason` says what it found).
 */
export async function canUseVideoMatting({ model }: { model?: VideoMattingModel } = {}): Promise<CanUseVideoMattingResult> {
  resolveModel(model, DEFAULT_MODEL);
  const addon = loadAddon();
  if (addon === null) {
    return { supported: false, reason: 'native-unavailable', detailedReason: `@kinetographdev/native cannot be loaded: ${addonLoadError()}` };
  }
  if (typeof addon.mattingSupport !== 'function' || typeof addon.matteVideo !== 'function') {
    return { supported: false, reason: 'native-unavailable', detailedReason: unavailableMessage() };
  }
  const support = addon.mattingSupport();
  if (!support.available) {
    return { supported: false, reason: 'backend-unavailable', detailedReason: support.reason ?? 'no inference backend is available' };
  }
  return { supported: true, backend: support.backend };
}

export function unavailableMessage(): string {
  return "Video matting isn't in this build of @kinetographdev/native; install a version that includes it";
}

/** The addon with matting in it, or the error that says it has none. */
export function requireMatting(): Required<Pick<MattingAddon, 'matteVideo' | 'mattingSupport'>> & MattingAddon {
  const addon = loadAddon();
  if (addon === null) throw new VideoMattingError('MATTING_UNAVAILABLE', `@kinetographdev/native cannot be loaded: ${addonLoadError()}`);
  if (typeof addon.mattingSupport !== 'function' || typeof addon.matteVideo !== 'function') {
    throw new VideoMattingError('MATTING_UNAVAILABLE', unavailableMessage());
  }
  const support = addon.mattingSupport();
  if (!support.available) {
    throw new VideoMattingError('MATTING_UNAVAILABLE', `Video matting cannot run here: ${support.reason ?? 'no inference backend is available'}`);
  }
  return addon as Required<Pick<MattingAddon, 'matteVideo' | 'mattingSupport'>> & MattingAddon;
}

export function notDownloaded(name: string): VideoMattingError {
  return new VideoMattingError('MODEL_NOT_DOWNLOADED', `The "${name}" model is not downloaded; call downloadVideoMattingModel({ model: "${name}" }) first`);
}

export interface LoadProgress {
  /** `initializing`, then `ready`. */
  status: 'initializing' | 'ready';
  file: string | null;
  /** `null` while initializing, 1 when ready. */
  progress: number | null;
  /** Always `null`: downloads report in `downloadVideoMattingModel()`. */
  loadedBytes: null;
  totalBytes: null;
}

export interface LoadVideoMattingModelOptions {
  model: VideoMattingModel;
  signal?: AbortSignal;
  onProgress?: (progress: LoadProgress) => void;
}

export interface LoadedVideoMattingModel {
  /** Whether the same model was already loaded in this process. */
  alreadyLoaded: boolean;
  /** Releases this call's hold on the model. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Checks that the downloaded model is there and that the addon can run it, and marks it loaded. The addon makes its
 * inference session when a job starts, so nothing stays in memory between calls; `separateVideoLayers()` loads by
 * itself and this is only for checking early.
 */
export async function loadVideoMattingModel(options: LoadVideoMattingModelOptions): Promise<LoadedVideoMattingModel> {
  const spec = resolveModel(options.model);
  options.signal?.throwIfAborted();
  return tracked(spec.name, async () => {
    if (!isCached(spec)) throw notDownloaded(spec.name);
    requireMatting();
    options.onProgress?.({ status: 'initializing', file: null, progress: null, loadedBytes: null, totalBytes: null });
    const alreadyLoaded = loadedModels.has(spec.name);
    loadedModels.retain(spec.name);
    options.onProgress?.({ status: 'ready', file: null, progress: 1, loadedBytes: null, totalBytes: null });
    let released = false;
    return {
      alreadyLoaded,
      async [Symbol.asyncDispose]() {
        if (released) return;
        released = true;
        loadedModels.release(spec.name);
      },
    };
  });
}

/** Marks a model loaded for a job that loads it itself, without a handle to release. */
export function markLoaded(name: string): void {
  if (!loadedModels.has(name)) loadedModels.retain(name);
}

/** Releases the loaded models (default: all); waits for the separations using them. The downloaded files stay. */
export async function disposeVideoMattingModel({ model }: { model?: VideoMattingModel } = {}): Promise<void> {
  const spec = model === undefined ? undefined : resolveModel(model);
  await whenIdle(spec?.name);
  loadedModels.clear(spec?.name);
}
