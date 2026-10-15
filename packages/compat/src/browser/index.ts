// `@kinetograph/compat/browser` (docs/COMPAT.md §6.2): the native elements as React DOM components, for the Chrome
// bundle, where `@kinetograph/react` is aliased here; and `installBrowserRuntime`, which sets up
// `window.__kinetograph`. It exports the names `@kinetograph/react` does, with the same props, so
// `@kinetograph/core` bundles against either.

export {
  Audio,
  Camera,
  Ellipse,
  Gif,
  Image,
  Layer,
  Lottie,
  MeshGradient,
  Noise,
  OffthreadVideo,
  Path,
  Rect,
  SequenceHost,
  Shape,
  Text,
  Video,
} from './elements.js';
export type {
  AudioProps,
  CameraProps,
  CharStyleFn,
  CommonProps,
  EllipseProps,
  GifProps,
  ImageProps,
  LayerProps,
  LottieProps,
  MeshGradientProps,
  NoiseProps,
  PathProps,
  RectProps,
  SequenceHostProps,
  ShapeProps,
  TextProps,
  VideoProps,
} from './props.js';

export { TimelineContext, useTimeline } from './timeline.js';
export type { TimelineState, VideoConfig } from './timeline.js';

export { createSceneRoot, findStage, STAGE_ID } from './scene-root.js';
export type { RenderedTree, SceneRoot } from './scene-root.js';

export { installBrowserRuntime, isTransparentColor } from './runtime.js';
export type { BrowserFrameRenderer, BrowserRuntime, FrameReport } from './runtime.js';

export { BROWSER_CSS, clipPathCss, filterCss, layoutCss, layoutItemCss, paintCss, transformCss } from './style.js';
export { fileUrl, gifUrl, videoUrl } from './urls.js';
export { resetWarnings, takeWarnings, warnOnce } from './warn.js';
