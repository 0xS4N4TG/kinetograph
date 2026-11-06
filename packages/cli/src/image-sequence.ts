// `render --sequence`: one image file per frame instead of a video. The frames are drawn as `still` draws them, so a
// frame is the same file whichever thread drew it.

import type { Renderer } from '@kinetographdev/native';

export type ImageFormat = 'png' | 'jpeg';

export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg'];

/**
 * Frame `frame` of `sceneJson` as the bytes of an image file. PNG is the addon's `still` (8-bit RGBA, straight alpha as
 * drawn); JPEG is its `preview` at full size (quality 80, no alpha: flattened over black).
 */
export function encodeFrame(renderer: Renderer, format: ImageFormat, sceneJson: string, frame: number, baseDir: string): Buffer {
  if (format === 'png') return renderer.still(sceneJson, frame, baseDir);
  return renderer.preview(sceneJson, frame, { format: 'jpeg' }, baseDir).data;
}

/** `Main-042.png`: the frame's number in the composition, padded to the width of its last frame (`lastFrame`). */
export function sequenceFileName(stem: string, frame: number, lastFrame: number, format: ImageFormat): string {
  return `${stem}-${String(frame).padStart(String(lastFrame).length, '0')}.${format}`;
}
