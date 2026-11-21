export type VideoMattingModel = 'modnet' | 'ben2-base';

/** A model Kinetograph can download: the Hugging Face file, pinned to a commit and checked by SHA-256. */
export interface ModelSpec {
  name: string;
  /** The Hugging Face repository, `owner/name`. */
  modelId: string;
  purpose: string;
  license: string;
  /** The commit of the repository the file is downloaded at. */
  revision: string;
  /** The file's path in the repository. */
  file: string;
  /** Its size in bytes. */
  size: number;
  sha256: string;
}

/** The two models of `@remotion/video-matting`, from their Hugging Face originals (packages/video-matting/THIRD-PARTY-NOTICES.md). */
export const MODELS: ModelSpec[] = [
  {
    name: 'modnet',
    modelId: 'Xenova/modnet',
    purpose: 'People',
    license: 'Apache-2.0',
    revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
    file: 'onnx/model.onnx',
    size: 25_888_640,
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
  },
  {
    name: 'ben2-base',
    modelId: 'onnx-community/BEN2-ONNX',
    purpose: 'General foreground subjects',
    license: 'MIT',
    revision: 'c552aa82688edce09f0ac9d2e31ad53d9d629010',
    file: 'onnx/model_fp16.onnx',
    size: 219_121_675,
    sha256: 'dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1',
  },
];

export const DEFAULT_MODEL: VideoMattingModel = 'modnet';

/** The release of ONNX Runtime (Microsoft's, CPU build) the addon loads at run time; `ort` needs 1.17 or newer. */
export const RUNTIME_VERSION = '1.31.0';

/**
 * Microsoft's NuGet package `Microsoft.ML.OnnxRuntime` on nuget.org: one zip with every platform's library under
 * `runtimes/<rid>/native/`, pinned by the SHA-512 NuGet publishes for it (`packageHash` in its catalog entry).
 */
export const RUNTIME_PACKAGE = {
  url: `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${RUNTIME_VERSION}/microsoft.ml.onnxruntime.${RUNTIME_VERSION}.nupkg`,
  size: 159_626_085,
  sha512: '27b6ab4e7fbb9eb59d67e3c5d9297d68d5b5fc16b90c2b75cb0677af99772caab38f7c3ca02ec297fb9a806dd7a758afb98258400312b9ec3479fffbe1fed70b',
};

/** The files of the package one platform needs: where in the cache each goes, and the package entry it comes from. */
export interface RuntimeSpec {
  /** The folder of the cache the files go in, as `<folder>/lib/<file>`. */
  folder: string;
  /** The library `ort` opens: a key of `files`. */
  library: string;
  /** Cache file name to the package entry it is read from. Beside the library, so it can load what an execution provider needs. */
  files: Record<string, string>;
}

/**
 * By `${process.platform}-${process.arch}`. The Linux build needs glibc 2.28 or newer; macOS's has CoreML,
 * and Windows's and Linux's run on the CPU only.
 */
export const RUNTIMES: Record<string, RuntimeSpec> = {
  'darwin-arm64': {
    folder: `onnxruntime-osx-arm64-${RUNTIME_VERSION}`,
    library: `libonnxruntime.${RUNTIME_VERSION}.dylib`,
    files: { [`libonnxruntime.${RUNTIME_VERSION}.dylib`]: 'runtimes/osx-arm64/native/libonnxruntime.dylib' },
  },
  'linux-x64': {
    folder: `onnxruntime-linux-x64-${RUNTIME_VERSION}`,
    library: `libonnxruntime.so.${RUNTIME_VERSION}`,
    files: {
      [`libonnxruntime.so.${RUNTIME_VERSION}`]: 'runtimes/linux-x64/native/libonnxruntime.so',
      'libonnxruntime_providers_shared.so': 'runtimes/linux-x64/native/libonnxruntime_providers_shared.so',
    },
  },
  'win32-x64': {
    folder: `onnxruntime-win-x64-${RUNTIME_VERSION}`,
    library: 'onnxruntime.dll',
    files: {
      'onnxruntime.dll': 'runtimes/win-x64/native/onnxruntime.dll',
      'onnxruntime_providers_shared.dll': 'runtimes/win-x64/native/onnxruntime_providers_shared.dll',
    },
  },
};
