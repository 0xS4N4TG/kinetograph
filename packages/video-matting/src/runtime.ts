import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { download, type DownloadVideoMattingModelOptions } from './cache.js';
import { VideoMattingError } from './errors.js';
import { videoMattingCacheDir } from './models.js';
import { RUNTIMES, RUNTIME_VERSION, type RuntimeSpec } from './registry.js';

const run = promisify(execFile);

/** The runtime for this platform, or the error that says there is none. */
export function runtimeSpec(): RuntimeSpec {
  const spec = RUNTIMES[`${process.platform}-${process.arch}`];
  if (!spec) {
    throw new VideoMattingError(
      'MATTING_UNAVAILABLE',
      `No ONNX Runtime is pinned for ${process.platform}-${process.arch}: download one from github.com/microsoft/onnxruntime and set ORT_DYLIB_PATH to its library`,
    );
  }
  return spec;
}

/** Where the runtime is kept: beside the models, in a folder of its version. */
export function runtimeDir(): string {
  return join(videoMattingCacheDir(), `onnxruntime-${RUNTIME_VERSION}`);
}

/** Where the archive's `lib/` ends up: the archive unpacked, its top folder kept (the macOS one is `./`-prefixed, the others are not, so nothing is stripped). */
function libDir(spec: RuntimeSpec): string {
  return join(runtimeDir(), spec.folder, 'lib');
}

/** The library `matteVideo` is given as `runtimePath`. */
export function runtimeLibrary(spec: RuntimeSpec = runtimeSpec()): string {
  return join(libDir(spec), spec.library);
}

/** Windows's `tar` is bsdtar, which reads zip; a GNU tar on the PATH (Git's) cannot take a drive-letter path. */
function tarCommand(): string {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

let pending: Promise<string | undefined> | undefined;

/**
 * The path of ONNX Runtime's library for `matteVideo`, downloading it first when it is not in the cache: Microsoft's
 * release archive for this platform, checked against its pinned SHA-256, with the library taken out of it. `undefined`
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
  const wanted = [spec.library, ...spec.others];
  if (wanted.every((f) => existsSync(join(libDir(spec), f)))) return runtimeLibrary(spec);

  const archive = join(dir, spec.archive);
  await download(
    {
      url: `https://github.com/microsoft/onnxruntime/releases/download/v${RUNTIME_VERSION}/${spec.archive}`,
      path: archive,
      size: spec.size,
      sha256: spec.sha256,
      name: `ONNX Runtime ${RUNTIME_VERSION}`,
      pin: spec.archive,
    },
    options,
  );
  try {
    // Only the files the addon needs, not the headers and symbol files.
    await run(tarCommand(), ['-xf', archive, '-C', dir, ...wanted.map((f) => `${spec.folder}/lib/${f}`)]);
  } catch (error) {
    throw new VideoMattingError('MODEL_DOWNLOAD', `Unpacking ONNX Runtime ${RUNTIME_VERSION} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(archive, { force: true });
  }
  return runtimeLibrary(spec);
}
