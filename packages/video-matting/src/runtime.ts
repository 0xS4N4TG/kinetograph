import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { download, type DownloadVideoMattingModelOptions } from './cache.js';
import { VideoMattingError } from './errors.js';
import { videoMattingCacheDir } from './models.js';
import { RUNTIMES, RUNTIME_PACKAGE, RUNTIME_VERSION, type RuntimeSpec } from './registry.js';
import { readZipEntries } from './zip.js';

/** The runtime for this platform, or the error that says there is none. */
export function runtimeSpec(): RuntimeSpec {
  const spec = RUNTIMES[`${process.platform}-${process.arch}`];
  if (!spec) {
    throw new VideoMattingError(
      'MATTING_UNAVAILABLE',
      `No ONNX Runtime is pinned for ${process.platform}-${process.arch}: download one from nuget.org (Microsoft.ML.OnnxRuntime) or github.com/microsoft/onnxruntime and set ORT_DYLIB_PATH to its library`,
    );
  }
  return spec;
}

/** Where the runtime is kept: beside the models, in a folder of its version. */
export function runtimeDir(): string {
  return join(videoMattingCacheDir(), `onnxruntime-${RUNTIME_VERSION}`);
}

/** Where the platform's files end up. */
function libDir(spec: RuntimeSpec): string {
  return join(runtimeDir(), spec.folder, 'lib');
}

/** The library `matteVideo` is given as `runtimePath`. */
export function runtimeLibrary(spec: RuntimeSpec = runtimeSpec()): string {
  return join(libDir(spec), spec.library);
}

let pending: Promise<string | undefined> | undefined;

/**
 * The path of ONNX Runtime's library for `matteVideo`, downloading it first when it is not in the cache: Microsoft's
 * NuGet package, checked against its pinned SHA-512, with this platform's files taken out of it. `undefined`
 * when `ORT_DYLIB_PATH` names a library (the addon reads that itself). Only runs before a job, never during one.
 */
export function ensureOnnxRuntime(options: Omit<DownloadVideoMattingModelOptions, 'model'> = {}): Promise<string | undefined> {
  if (process.env.ORT_DYLIB_PATH) return Promise.resolve(undefined);
  // One download at a time in this process; a second call waits for it.
  pending ??= fetchRuntime(options).finally(() => {
    pending = undefined;
  });
  return pending;
}

async function fetchRuntime(options: Omit<DownloadVideoMattingModelOptions, 'model'>): Promise<string> {
  const spec = runtimeSpec();
  const dir = runtimeDir();
  const wanted = Object.keys(spec.files);
  // A file is only ever at its name whole (see below), so one that is there is complete.
  if (wanted.every((f) => existsSync(join(libDir(spec), f)))) return runtimeLibrary(spec);

  const archive = join(dir, 'microsoft.ml.onnxruntime.nupkg');
  await download(
    { ...RUNTIME_PACKAGE, path: archive, name: `ONNX Runtime ${RUNTIME_VERSION}`, pin: 'Microsoft.ML.OnnxRuntime on nuget.org' },
    options,
  );
  try {
    // Only this platform's files, not the other platforms' libraries; the package is deleted after.
    const entries = await readZipEntries(archive, Object.values(spec.files));
    mkdirSync(libDir(spec), { recursive: true });
    // Written beside its name and renamed, so a kill or a full disk mid-write leaves a `.tmp` and no library.
    for (const [name, entry] of Object.entries(spec.files)) {
      const path = join(libDir(spec), name);
      writeFileSync(`${path}.tmp`, entries.get(entry)!, { mode: 0o755 });
      renameSync(`${path}.tmp`, path);
    }
  } catch (error) {
    throw new VideoMattingError('MODEL_DOWNLOAD', `Unpacking ONNX Runtime ${RUNTIME_VERSION} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(archive, { force: true });
  }
  return runtimeLibrary(spec);
}
