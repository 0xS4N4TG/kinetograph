import { createRequire } from 'node:module';
import { MODELS, type ModelSpec } from './registry.js';

/** What the addon exports for matting (the shared spec of video matting, layer 1). */
export interface MattingSupport {
  available: boolean;
  backend: 'coreml' | 'cuda' | 'webgpu' | 'cpu';
  reason?: string;
}

export interface MatteVideoOptions {
  input: string;
  modelPath: string;
  /** ONNX Runtime's library (`ensureOnnxRuntime`); without it the addon reads `ORT_DYLIB_PATH`. */
  runtimePath?: string;
  model: string;
  foreground: string;
  base?: string;
  keepAudio: boolean;
  quality: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
  jobs?: number;
  /** Extras the options of `separateVideoLayers` carry; an addon that does not read one ignores it. */
  audio?: 'base' | 'foreground' | 'both' | 'none';
  videoBitrate?: number;
  audioBitrate?: number | string;
  keyframeIntervalInSeconds?: number;
}

export interface MatteVideoResult {
  foreground: string;
  base?: string;
  frames: number;
  backend: string;
}

export interface MattingAddon {
  mattingSupport?(): MattingSupport;
  matteVideo?(options: MatteVideoOptions, onProgress?: (doneFrames: number, totalFrames: number) => void): Promise<MatteVideoResult>;
  probeMedia?(path: string, baseDir?: string | null): { width: number; height: number; durationInSeconds: number; fps?: number | null; frames?: number | null; hasAudio: boolean };
}

/** The addon, the fetch and the model list: tests replace them (`@kinetographdev/video-matting/testing`). */
export const hooks: {
  addon: MattingAddon | null | undefined;
  fetch: typeof fetch;
  models: ModelSpec[];
  /** Stands in for `ensureOnnxRuntime`. */
  runtime: ((signal?: AbortSignal) => Promise<string | undefined>) | undefined;
} = {
  addon: undefined,
  fetch: (input, init) => fetch(input, init),
  models: MODELS,
  runtime: undefined,
};

let loadError = '';

/** The addon (a CommonJS package, so loaded with `require`), or null when it cannot be loaded; `addonLoadError()` says why. */
export function loadAddon(): MattingAddon | null {
  if (hooks.addon !== undefined) return hooks.addon;
  try {
    hooks.addon = createRequire(import.meta.url)('@kinetographdev/native') as MattingAddon;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    hooks.addon = null;
  }
  return hooks.addon;
}

export function addonLoadError(): string {
  return loadError;
}

// ---- Models in use: removal and disposal wait for what is running ----

const active = new Map<string, Set<Promise<unknown>>>();
const loaded = new Map<string, number>();

/** Runs `work` as an operation on `model`. */
export function tracked<T>(model: string, work: () => Promise<T>): Promise<T> {
  const promise = work();
  const set = active.get(model) ?? new Set();
  active.set(model, set);
  const done = promise.then(
    () => undefined,
    () => undefined,
  );
  set.add(done);
  void done.then(() => set.delete(done));
  return promise;
}

/** Resolves when nothing is running on `model` (or on any model). */
export async function whenIdle(model?: string): Promise<void> {
  const sets = model === undefined ? [...active.values()] : [active.get(model) ?? new Set<Promise<unknown>>()];
  await Promise.all(sets.flatMap((s) => [...s]));
}

export const loadedModels = {
  has: (model: string): boolean => loaded.has(model),
  retain(model: string): void {
    loaded.set(model, (loaded.get(model) ?? 0) + 1);
  },
  release(model: string): void {
    const n = (loaded.get(model) ?? 0) - 1;
    if (n <= 0) loaded.delete(model);
    else loaded.set(model, n);
  },
  clear(model?: string): void {
    if (model === undefined) loaded.clear();
    else loaded.delete(model);
  },
};

export function resetState(): void {
  hooks.addon = undefined;
  hooks.fetch = (input, init) => fetch(input, init);
  hooks.models = MODELS;
  hooks.runtime = undefined;
  loadError = '';
  active.clear();
  loaded.clear();
}
