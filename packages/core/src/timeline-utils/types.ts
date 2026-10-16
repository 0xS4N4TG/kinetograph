// The browser types `@remotion/timeline-utils` is written against (`HTMLCanvasElement`, `OffscreenCanvas`,
// `VideoFrame`, mediabunny's tracks), as the little each function uses. The library has no DOM types, and these are
// what Kinetograph's `<canvas>` and `OffscreenCanvas` (docs/AUTHORING.md §6.5) answer to.

export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
}

export interface Context2DLike {
  clearRect(x: number, y: number, width: number, height: number): void;
  createImageData(width: number, height: number): ImageDataLike;
  putImageData(imageData: ImageDataLike, dx: number, dy: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(image: any, dx: number, dy: number, dWidth: number, dHeight: number): void;
}

/** An `HTMLCanvasElement` or an `OffscreenCanvas`. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): Context2DLike | null;
}

/** The part of a WebCodecs `VideoFrame` the frame strip reads. */
export interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration?: number | null;
  allocationSize(): number;
  close(): void;
}

/** A mediabunny `InputAudioTrack`; only a path can be loaded here. */
export interface InputAudioTrackLike {
  readonly id: number;
}

// The messages the published package's waveform worker is sent and answers with. There is no worker here, so nothing
// sends them; they are exported for code that is typed against them.

export type AudioWaveformWorkerLoadMessage = {
  readonly type: 'load';
  readonly requestId: number;
  readonly src: string;
  readonly waveformSampleRate: number;
};

export type AudioWaveformWorkerIncomingMessage = AudioWaveformWorkerLoadMessage;

export type AudioWaveformWorkerPeaksMessage = {
  readonly type: 'peaks';
  readonly requestId: number;
  readonly peaks: Float32Array;
  readonly maxima: readonly Float32Array[];
  readonly final: boolean;
  readonly averageVolume: number | null;
};

export type AudioWaveformWorkerErrorMessage = {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
};

export type AudioWaveformWorkerOutgoingMessage = AudioWaveformWorkerPeaksMessage | AudioWaveformWorkerErrorMessage;
