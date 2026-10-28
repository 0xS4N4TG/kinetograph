// `@remotion/skia` and `@shopify/react-native-skia` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.7): the components of RN-Skia's `<Canvas>`
// drawn by real Skia, in the optional `@kinetographdev/skia` addon, with its CPU rasteriser. `react-native-reanimated`
// is `./reanimated.js` (its shared values are what RN-Skia animates with).

export { Canvas, SkiaCanvas, useCanvasRef, type CanvasProps } from './canvas.js';
export * from './components.js';
export { matchFont, useFont, useFonts, useImage, useSVG, useTypeface, type FontStyleDescription } from './hooks.js';
export {
  useAnimatedImage,
  useAnimatedImageValue,
  useClock,
  usePathInterpolation,
  usePathValue,
  useRectBuffer,
  useRSXformBuffer,
  useVectorInterpolation,
} from './animation.js';
export { drawAsImage, drawAsPicture, SkSurface } from './surface.js';
export { useVideo, type UseVideoOptions, type UseVideoResult } from './video.js';
export { AlphaType, ColorType, SkAnimatedImage, SkData, SkFontMgr, SkTypefaceFontProvider, type ImageInfo } from './data.js';
export { SkRuntimeShaderBuilder } from './factories.js';
export { isSharedValue, makeMutable, type SharedValue } from './shared-value.js';
export {
  BlendMode,
  ClipOp,
  createPicture,
  PointMode,
  BlurStyle,
  FilterMode,
  MipmapMode,
  SkTypeface,
  type SkDeclaration,
  type LineMetrics,
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
