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
