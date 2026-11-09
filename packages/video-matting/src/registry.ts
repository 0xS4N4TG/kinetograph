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

/** Microsoft's archive for one platform, pinned by SHA-256, and the files of it the addon needs (all in `lib/`). */
export interface RuntimeSpec {
  /** Where `lib/` of the archive is: the archive's top folder. */
  folder: string;
  /** The archive's file name; its URL is under github.com/microsoft/onnxruntime/releases. */
  archive: string;
  size: number;
  sha256: string;
  /** The library `ort` opens. */
  library: string;
  /** Beside it, loaded by it when an execution provider is: the file names to keep. */
  others: string[];
}

/**
 * By `${process.platform}-${process.arch}`. The Linux build needs glibc 2.28 or newer; macOS's has CoreML,
 * and Windows's and Linux's run on the CPU only.
 */
export const RUNTIMES: Record<string, RuntimeSpec> = {
  'darwin-arm64': {
    folder: `onnxruntime-osx-arm64-${RUNTIME_VERSION}`,
    archive: `onnxruntime-osx-arm64-${RUNTIME_VERSION}.tgz`,
    size: 36_549_009,
    sha256: '1031b36dd3bdaa8d976a6130d9cf2a05e9be320b93ae804f8427b91dc3432afc',
    library: `libonnxruntime.${RUNTIME_VERSION}.dylib`,
    others: [],
  },
  'linux-x64': {
    folder: `onnxruntime-linux-x64-${RUNTIME_VERSION}`,
    archive: `onnxruntime-linux-x64-${RUNTIME_VERSION}.tgz`,
    size: 11_408_003,
    sha256: 'cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57',
    library: `libonnxruntime.so.${RUNTIME_VERSION}`,
    others: ['libonnxruntime_providers_shared.so'],
  },
  'win32-x64': {
    folder: `onnxruntime-win-x64-${RUNTIME_VERSION}`,
    archive: `onnxruntime-win-x64-${RUNTIME_VERSION}.zip`,
    size: 82_887_349,
    sha256: '3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195',
    library: 'onnxruntime.dll',
    others: ['onnxruntime_providers_shared.dll'],
  },
};
