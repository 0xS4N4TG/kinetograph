// The picture a `<Video>`'s `onVideoFrame` hands a project (packages/cli/skills/kinetograph/references/AUTHORING.md §7.1): a
// `CanvasImageSource` whose pixels are the decoded frame the video shows at that composition frame. It names the file
// and the instant (a canvas command `{ kind: 'video' }`); the renderer decodes it with the engine's own decoder when a
// canvas draws it or reads it, so holding one costs nothing and the frame is a function of the frame number alone.

import { CANVAS_SOURCE, type CanvasPicture, type CanvasPictureSource } from './canvas.js';
import { VIDEO_FRAME, type VideoFrameSource } from './webgpu.js';

/** The fields of a `<Video>` that pick its picture (SCENE.md, "video"), with the scene frame they are read at. */
export interface VideoClipTime {
  /** The scene frame being drawn. */
  frame: number;
  fps: number;
  /** The scene frame at which the clip's own frame 0 falls. */
  start: number;
  trimBefore: number;
  /** Frames after which the clip ends; null: the end of the stream. */
  trimAfter: number | null;
  playbackRate: number;
  loop: boolean;
}

/**
 * The time in the file, in seconds after its first picture, that a clip shows at a scene frame, and where the clip ends
 * (SCENE.md, "video", rules 1 to 4; the same arithmetic as `Clip::source_time` in `crates/core/src/video.rs`).
 * `duration` is the stream's, in seconds after its first picture.
 */
export function videoClipTime(clip: VideoClipTime, duration: number): { time: number; end: number } {
  // 1. The clip's frame.
  let n = (clip.frame - clip.start) * clip.playbackRate;
  // 2. The clip's length, in scene frames.
  const end = clip.trimAfter === null ? duration : clip.trimAfter / clip.fps;
  const length = end * clip.fps - clip.trimBefore;
  // 3. Wrapped or clamped into the clip.
  if (clip.loop) n = length > 0 ? ((n % length) + length) % length : 0;
  else n = Math.min(Math.max(n, 0), length);
  // 4. Seconds from the stream's first picture.
  return { time: (clip.trimBefore + n) / clip.fps, end };
}

/**
 * One decoded picture of a video file, as `onVideoFrame` hands it over: size, `timestamp` (microseconds) and the
 * methods of an `ImageBitmap`/`VideoFrame` that need no pixels (`close`). `drawImage`, `createPattern` and WebGL's
 * `texImage2D` take it; `getImageData` of a canvas it was drawn on reads the pixels.
 */
export class VideoFramePicture implements CanvasPictureSource {
  readonly width: number;
  readonly height: number;
  /** The same size under the names of `VideoFrame`, `HTMLVideoElement` and `HTMLImageElement`. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** Microseconds after the file's first picture. */
  readonly timestamp: number;
  readonly duration = null;
  readonly src: string;
  /** Seconds after the file's first picture. */
  readonly time: number;
  private readonly end: number | undefined;

  constructor(src: string, time: number, width: number, height: number, end?: number) {
    this.src = src;
    this.time = time;
    this.end = end;
    this.width = this.displayWidth = this.codedWidth = this.videoWidth = this.naturalWidth = width;
    this.height = this.displayHeight = this.codedHeight = this.videoHeight = this.naturalHeight = height;
    this.timestamp = Math.round(time * 1e6);
  }

  /** What `drawImage` and `createPattern` read: the file and the instant. */
  [CANVAS_SOURCE](): CanvasPicture {
    const source = { kind: 'video' as const, src: this.src, time: this.time, ...(this.end !== undefined ? { end: this.end } : {}) };
    return { source, width: this.width, height: this.height };
  }

  /** What `queue.copyExternalImageToTexture` reads of it (WebGPU). */
  [VIDEO_FRAME](): VideoFrameSource {
    return { src: this.src, time: this.time, width: this.width, height: this.height };
  }

  /** A `VideoFrame` is closed when the project is done with it; here there is nothing to free. */
  close(): void {}
}
