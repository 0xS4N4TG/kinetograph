import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { VideoMattingError } from './errors.js';
import type { ModelSpec, VideoMattingModel } from './registry.js';
import { hooks } from './state.js';

export { DEFAULT_MODEL } from './registry.js';
export type { ModelSpec, VideoMattingModel } from './registry.js';

/** What `getAvailableModels()` lists for one model. */
export interface AvailableModel {
  /** The name every function of this package takes. */
  name: VideoMattingModel;
  /** The upstream Hugging Face model. */
  modelId: string;
  purpose: string;
  /** The model's licence (an addition to Remotion's fields). */
  license: string;
  /** The bytes downloaded for the model. Remotion's name; here it is the one ONNX file. */
  webGpuDownloadSize: number;
}

export function getAvailableModels(): AvailableModel[] {
  return hooks.models.map((m) => ({
    name: m.name as VideoMattingModel,
    modelId: m.modelId,
    purpose: m.purpose,
    license: m.license,
    webGpuDownloadSize: m.size,
  }));
}

/** The spec for `name`; an unknown or missing name is an error that lists the valid ones. */
export function resolveModel(name: unknown, fallback?: VideoMattingModel): ModelSpec {
  const wanted = name ?? fallback;
  const spec = hooks.models.find((m) => m.name === wanted);
  if (spec) return spec;
  const valid = hooks.models.map((m) => m.name).join(', ');
  throw new VideoMattingError(
    'UNKNOWN_MODEL',
    wanted === undefined
      ? `model is required; one of: ${valid}`
      : `Unknown video matting model ${JSON.stringify(wanted)}; one of: ${valid}`,
  );
}

/**
 * Where models are cached: `$KINETOGRAPH_MODEL_DIR`, else `kinetograph/models` in the OS cache directory
 * (`~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` or `~/.cache` elsewhere).
 */
export function videoMattingCacheDir(): string {
  const set = process.env.KINETOGRAPH_MODEL_DIR;
  if (set) return resolve(set);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'kinetograph', 'models');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'kinetograph', 'models');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kinetograph', 'models');
}

/** The folder of a model at its pinned revision: a new revision downloads again beside the old one. */
export function modelDir(spec: ModelSpec): string {
  return join(videoMattingCacheDir(), `${spec.name}-${spec.revision.slice(0, 12)}`);
}

/** The `.onnx` file `matteVideo` is given as `modelPath`. */
export function modelPath(spec: ModelSpec): string {
  return join(modelDir(spec), basename(spec.file));
}
