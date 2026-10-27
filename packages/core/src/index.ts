// @kinetographdev/core: the Remotion-shaped authoring API (packages/cli/skills/kinetograph/references/AUTHORING.md
// §7). Projects import everything from here (and from `remotion`, which the
// CLI aliases to this package). Implemented from Remotion's documented
// behaviour, never from its source; the numeric functions are checked against
// values recorded from the published package (test/fixtures).

export * from '@kinetographdev/scene';

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
} from '@kinetographdev/react';
// Remotion's names for the plain HTML media tags, which are the engine's <Audio> and <Video> here.
export { Audio as Html5Audio, Video as Html5Video } from '@kinetographdev/react';
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
  DatamoshOptions,
  GifProps,
} from '@kinetographdev/react';

// <Video datamosh> on a codec without motion vectors is reported as unsupported (AUTHORING.md §11.8).
import './datamosh.js';

// <Gif> with the duration lookup that `loopBehavior="unmount-after-finish"` needs (AUTHORING.md §11.3).
export { Gif } from './gif.js';

// ---- time ----
export { useCurrentFrame, useVideoConfig, useIsInsideNonPremountFreeze, Sequence, Series, Loop, Freeze } from './timeline.js';
export type { SequenceProps, SeriesSequenceProps, LoopProps, FreezeProps } from './timeline.js';

export { interpolate, assertValidInterpolateEasingOption, assertValidInterpolatePosterizeOption } from './interpolate.js';
export type {
  ExtrapolateType,
  InterpolateOptions,
  InterpolateOutputOption,
  InterpolateOutputType,
} from './interpolate.js';
export { interpolateColors } from './interpolate-colors.js';
export type { InterpolateColorsOptions } from './interpolate-colors.js';
export { spring, measureSpring } from './spring.js';
export type { SpringConfig } from './spring.js';
export { Easing } from './easing.js';
export type { EasingFunction, EasingSpringConfig } from './easing.js';
export { random } from './random.js';

// ---- CSS-shaped components ----
export { AbsoluteFill, Img } from './fill.js';
export type { AbsoluteFillProps, FillStyle, ImgProps } from './fill.js';

// ---- assets and async ----
export { staticFile, setPublicDir, delayRender, continueRender, cancelRender, useDelayRender } from './assets.js';
export type { DelayRenderOptions } from './assets.js';
export { getRemotionEnvironment, useRemotionEnvironment } from './environment.js';
export type { RemotionEnvironment } from './environment.js';

export { getStaticFiles, watchStaticFile, prefetch } from './static-files.js';
export type { PrefetchOptions, StaticFile } from './static-files.js';
export { planeAt, readTrackFile, trackAt, usePlaneTrack, useTrack } from './track.js';
export type { PlaneTrackValue, TrackCorners, TrackFile, TrackFileFrame, TrackFilePlane, TrackPointXY, TrackValue } from './track.js';
export { MediaPlaybackError } from './media-error.js';
export { Config, Experimental } from './legacy.js';
export { Interactive, Track } from './interactive.js';
export type { InteractiveCreateOptions, InteractiveElementProps, TrackProps } from './interactive.js';
export { IFrame } from './iframe.js';
export type { IFrameProps } from './iframe.js';
export { Artifact } from './artifact.js';
export type { ArtifactProps, DownloadBehavior } from './artifact.js';
export { clearArtifacts, getArtifacts, recordArtifact } from './artifacts.js';
export type { ArtifactContent, ArtifactRecord } from './artifacts.js';
export {
  HtmlInCanvas,
  HTML_IN_CANVAS_UNSUPPORTED_MESSAGE,
  getHtmlInCanvasUnsupportedMessage,
  isHtmlInCanvasSupported,
} from './html-in-canvas.js';
export type {
  HtmlInCanvasOnInit,
  HtmlInCanvasOnInitCleanup,
  HtmlInCanvasOnPaint,
  HtmlInCanvasOnPaintParams,
  HtmlInCanvasPixelDensity,
  HtmlInCanvasProps,
} from './html-in-canvas.js';
export { createEffect, Solid, CanvasImage } from './effects.js';
export { AnimatedImage } from './animated-image.js';
export type { AnimatedImageLoopBehavior, AnimatedImageProps } from './animated-image.js';
export type {
  Backend,
  CanvasImageProps,
  EffectApplyParams,
  EffectCanvas,
  EffectDefinition,
  EffectDescriptor,
  EffectFactory,
  EffectsOutputSize,
  EffectsProp,
  SolidProps,
} from './effects.js';
export { absoluteFillSchema } from './interactivity-schema.js';
export type { InteractivitySchema, SchemaField } from './interactivity-schema.js';
export type { CropProps, SequenceTimingProps } from './sequenced.js';

// ---- preview state (Studio and Player), fixed to what a render sees ----
export { useCurrentScale, usePixelDensity, useBufferState } from './hooks.js';
export type { DelayPlaybackHandle, OutsideRemotionOptions, UseBufferState } from './hooks.js';

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
export { registerFont, getFonts, setFallbackFont } from './font-registry.js';
export type { FontRegistration } from './font-registry.js';

// ---- frame loop (AUTHORING.md §7.3) ----
export { createFrameRenderer } from './frame-loop.js';
export type { FrameRenderer, FrameResult } from './frame-loop.js';
