// @kinetograph/core: the Remotion-shaped authoring API (docs/AUTHORING.md
// §7). Projects import everything from here (and from `remotion`, which the
// CLI aliases to this package). Implemented from Remotion's documented
// behaviour, never from its source; the numeric functions are checked against
// values recorded from the published package (test/fixtures).

export * from '@kinetograph/scene';

/** Remotion's `VERSION`: the release whose behaviour the numeric functions are checked against (test/fixtures). */
export const VERSION = '4.0.535';

export {
  AmbientLight,
  Audio,
  Camera,
  Camera3D,
  Canvas,
  GlslShader,
  DirectionalLight,
  Ellipse,
  Extrude,
  Group3D,
  Image,
  Layer,
  Lottie,
  Mesh,
  MeshGradient,
  Model,
  Noise,
  Path,
  PointLight,
  Rect,
  Scene3D,
  Shape,
  Text,
  Text3D,
  TimelineContext,
  useTimeline,
  Video,
  OffthreadVideo,
} from '@kinetograph/react';
export type {
  AmbientLightProps,
  AudioProps,
  Camera3DProps,
  CameraProps,
  CanvasProps,
  GlslShaderProps,
  CommonProps,
  DirectionalLightProps,
  EllipseProps,
  ExtrudeProps,
  Group3DProps,
  ImageProps,
  LayerProps,
  LottieProps,
  MeshGradientProps,
  MeshProps,
  ModelProps,
  NoiseProps,
  Object3DProps,
  PathProps,
  PointLightProps,
  RectProps,
  Scene3DProps,
  ShapeProps,
  Text3DProps,
  TextProps,
  TimelineState,
  VideoConfig,
  VideoProps,
  GifProps,
} from '@kinetograph/react';

// <Gif> with the duration lookup that `loopBehavior="unmount-after-finish"` needs (AUTHORING.md §11.3).
export { Gif } from './gif.js';

// ---- time ----
export { useCurrentFrame, useVideoConfig, Sequence, Series, Loop, Freeze } from './timeline.js';
export type { SequenceProps, SeriesSequenceProps, LoopProps, FreezeProps } from './timeline.js';

export { interpolate } from './interpolate.js';
export type { ExtrapolateType, InterpolateOptions } from './interpolate.js';
export { interpolateColors } from './interpolate-colors.js';
export type { InterpolateColorsOptions } from './interpolate-colors.js';
export { spring, measureSpring } from './spring.js';
export type { SpringConfig } from './spring.js';
export { Easing } from './easing.js';
export type { EasingFunction } from './easing.js';
export { random } from './random.js';

// ---- CSS-shaped components ----
export { AbsoluteFill, Img } from './fill.js';
export type { AbsoluteFillProps, FillStyle, ImgProps } from './fill.js';

// ---- assets and async ----
export { staticFile, setPublicDir, delayRender, continueRender, cancelRender } from './assets.js';
export type { DelayRenderOptions } from './assets.js';
export { getRemotionEnvironment } from './environment.js';
export type { RemotionEnvironment } from './environment.js';

// ---- compositions and fonts (AUTHORING.md §7.2) ----
export {
  Composition,
  Still,
  Folder,
  registerRoot,
  getInputProps,
  setInputProps,
  getCompositions,
} from './compositions.js';
export type { CompositionInfo, CompositionProps, StillProps } from './compositions.js';
export { registerFont, getFonts } from './font-registry.js';
export type { FontRegistration } from './font-registry.js';

// ---- frame loop (AUTHORING.md §7.3) ----
export { createFrameRenderer } from './frame-loop.js';
export type { FrameRenderer, FrameResult } from './frame-loop.js';
