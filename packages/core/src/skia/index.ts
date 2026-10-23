// `@remotion/skia` and `@shopify/react-native-skia` (docs/AUTHORING.md §7.7): the components of RN-Skia's `<Canvas>`
// drawn by real Skia, in the optional `@kinetograph/skia` addon, with its CPU rasteriser.

export { Canvas, SkiaCanvas, useCanvasRef, type CanvasProps } from './canvas.js';
export * from './components.js';
export { matchFont, useFont, useImage, useSVG, type FontStyleDescription } from './hooks.js';
export {
  BlendMode,
  ClipOp,
  createPicture,
  PointMode,
  BlurStyle,
  FillType,
  PathOp,
  PaintStyle,
  SkFont,
  SkImage,
  SkMatrix,
  SkPaint,
  SkParagraph,
  SkPath,
  SkPicture,
  SkPictureRecorder,
  SkRecordingCanvas,
  SkSVG,
  SkTextBlob,
  SkRuntimeEffect,
  StrokeCap,
  StrokeJoin,
  TileMode,
  type SkPoint,
  type SkRSXform,
  type SkRect,
  type SkRRect,
} from './objects.js';
export { Skia } from './skia.js';
export { hasSkiaAddon, setSkiaAddon, type SkiaAddon } from './addon.js';
export { toColor, type SkColor } from './values.js';
export type { SkiaNode } from './host.js';

/** RN-Skia's names for the same classes as types. */
export type { SkFont as SkiaFont, SkImage as SkiaImage, SkPath as SkiaPath };
import type { SkFont, SkImage, SkPath } from './objects.js';
