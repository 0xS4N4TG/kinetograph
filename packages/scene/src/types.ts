// Types of the scene JSON: docs/SCENE.md, plus the additions of
// docs/AUTHORING.md §4 (flex layout, transform origin, text align and per
// character styles, lottie, image fit, box-unit gradients, motion-blur
// frames). A JSON value that type-checks as `SceneJson` should load.

export type ColorString = string;

/** The easing of the segment that starts at a keyframe (SCENE.md, "Animated numbers"). Named so it cannot clash with
 *  Remotion's `Easing` when `@kinetograph/core` re-exports this package. */
export type KeyframeEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
export interface Keyframe {
  frame: number;
  value: number;
  easing?: KeyframeEasing;
}
/** An animatable number: a constant or keyframes. */
export type Num = number | Keyframe[];

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

// ---- gradients ----

export type Extend = 'pad' | 'repeat' | 'reflect';

export interface Stop {
  /** 0..1 at every keyframe. */
  offset: Num;
  color: ColorString;
}

interface GradientBase {
  /** At least 2. */
  stops: Stop[];
  /** Outside the first and last stop. Default `pad`. */
  extend?: Extend;
  /** `box`: coordinates are fractions of the painted layer's box (AUTHORING.md §4.5). Default `user`. */
  units?: 'user' | 'box';
}
export interface LinearGradient extends GradientBase {
  type: 'linear';
  x0: Num;
  y0: Num;
  x1: Num;
  y1: Num;
}
export interface RadialGradient extends GradientBase {
  type: 'radial';
  cx: Num;
  cy: Num;
  /** At least 0. */
  r: Num;
}
export interface ConicGradient extends GradientBase {
  type: 'conic';
  cx: Num;
  cy: Num;
  /** Degrees clockwise from 12 o'clock. Default 0. */
  angle?: Num;
}
export type Gradient = LinearGradient | RadialGradient | ConicGradient;
/** A colour string or a gradient: a shape's `fill` and a text layer's `color`. */
export type Paint = ColorString | Gradient;

// ---- transform, clip, mask, matte, motion blur ----

export interface Transform {
  x?: Num;
  y?: Num;
  scale?: Num;
  /** Degrees, clockwise. */
  rotation?: Num;
  anchorX?: Num;
  anchorY?: Num;
  /** AUTHORING.md §4.2: a point of the layer's box as a fraction of its size, added to the anchor. */
  originX?: Num;
  originY?: Num;
  rotateX?: Num;
  rotateY?: Num;
  /** Pixels toward the viewer. */
  z?: Num;
}

export type Clip =
  | { kind: 'polygon'; points: [Num, Num][] }
  | { kind: 'inset'; top?: Num; right?: Num; bottom?: Num; left?: Num; radius?: Num }
  | { kind: 'ellipse'; cx: Num; cy: Num; rx: Num; ry: Num }
  | { kind: 'path'; d: string };

export interface Mask {
  gradient: Gradient;
  /** Default `alpha`. */
  mode?: 'alpha' | 'luminance';
}

export interface Matte {
  /** The `id` of a sibling layer. */
  layer: string;
  /** Default `alpha`. */
  mode?: 'alpha' | 'alphaInverted' | 'luminance' | 'luminanceInverted';
}

export interface MotionBlurJson {
  /** Whole number, 2 to 64. Default 8. */
  samples?: number;
  /** Frames the shutter is open, clamped to 0..2. Default 0.5. */
  shutter?: Num;
  /** AUTHORING.md §4.5: exactly `samples` complete layers of the same type, one per sub-frame in time order. */
  frames?: LayerJson[];
}

// ---- layout (AUTHORING.md §4.1) ----

export type JustifyContent =
  | 'flex-start'
  | 'flex-end'
  | 'center'
  | 'space-between'
  | 'space-around'
  | 'space-evenly';
export type AlignItems = 'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch';

export interface Layout {
  display?: 'flex';
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent?: JustifyContent;
  alignItems?: AlignItems;
  alignContent?: JustifyContent | 'stretch';
  /** A number, or `[row, column]`. */
  gap?: Num | [Num, Num];
  /** A number, or `[top, right, bottom, left]`. */
  padding?: Num | [Num, Num, Num, Num];
  width?: Num;
  height?: Num;
}

export interface LayoutItem {
  position?: 'relative' | 'absolute';
  flexGrow?: Num;
  flexShrink?: Num;
  flexBasis?: Num | 'auto';
  alignSelf?: 'auto' | AlignItems;
  /** A number, or `[top, right, bottom, left]`. */
  margin?: Num | [Num, Num, Num, Num];
  width?: Num;
  height?: Num;
}

/** AUTHORING.md §4.3: one entry of a text layer's `chars`. */
export interface CharStyle {
  x?: Num;
  y?: Num;
  scale?: Num;
  rotation?: Num;
  opacity?: Num;
  color?: ColorString;
}

// ---- effects (SCENE.md, "Effects") ----

export interface Turbulence {
  type: 'fractalNoise' | 'turbulence';
  /** Not negative: one number (both axes) or `[x, y]`. */
  baseFrequency: Num | [Num, Num];
  /** Whole number, 0 to 10. Default 1. */
  numOctaves?: number;
  seed: number;
}

export interface BlurEffect {
  type: 'blur';
  radius: Num;
}
export interface BackdropBlurEffect {
  type: 'backdropBlur';
  radius: Num;
}
export interface GlowEffect {
  type: 'glow';
  radius: Num;
  color?: ColorString;
  /** Default 1, clamped to 0..4. */
  intensity?: Num;
}
export interface ChromaticAberrationEffect {
  type: 'chromaticAberration';
  amount: Num;
  /** Degrees clockwise from +x. Default 0. */
  angle?: Num;
}
interface ShadowFields {
  x?: Num;
  y?: Num;
  blur?: Num;
  spread?: Num;
  /** With straight alpha. Default `#000000`. */
  color?: ColorString;
}
export interface DropShadowEffect extends ShadowFields {
  type: 'dropShadow';
}
export interface InsetShadowEffect extends ShadowFields {
  type: 'insetShadow';
}
export interface SaturateEffect {
  type: 'saturate';
  amount?: Num;
}
export interface ContrastEffect {
  type: 'contrast';
  amount?: Num;
}
export interface BrightnessEffect {
  type: 'brightness';
  amount?: Num;
}
export interface GrayscaleEffect {
  type: 'grayscale';
  amount?: Num;
}
export interface SepiaEffect {
  type: 'sepia';
  amount?: Num;
}
export interface InvertEffect {
  type: 'invert';
  amount?: Num;
}
export interface HueRotateEffect {
  type: 'hueRotate';
  /** Degrees. Default 0. */
  angle?: Num;
}
export interface GradientMapEffect {
  type: 'gradientMap';
  /** 2 to 16. */
  stops: Stop[];
  /** 0..1, default 1. */
  amount?: Num;
}
export interface LutEffect {
  type: 'lut';
  /** A `.cube` file, relative to the scene file. */
  src: string;
  amount?: Num;
}
export interface GrainEffect {
  type: 'grain';
  amount: Num;
  size?: Num;
  /** Whole number, 0 to 4294967295. */
  seed: number;
  animate?: boolean;
  monochrome?: boolean;
}
export interface DitherEffect {
  type: 'dither';
  mode?: 'ordered' | 'random';
  levels?: Num;
  size?: Num;
  /** Whole number, 0 to 4294967295. Required for `random`. */
  seed?: number;
  animate?: boolean;
}
export interface HalftoneEffect {
  type: 'halftone';
  size?: Num;
  angle?: Num;
  shape?: 'circle' | 'square' | 'line';
  color?: ColorString;
  invert?: boolean;
}
export interface DotMatrixEffect {
  type: 'dotMatrix';
  size?: Num;
  progress: Num;
  order?: 'random' | 'sweep';
  angle?: Num;
  stagger?: Num;
  /** Whole number, 0 to 4294967295. Required for `random`. */
  seed?: number;
  shape?: 'circle' | 'square';
}
export type NoiseChannel = 'R' | 'G' | 'B' | 'A';
export interface DisplaceEffect {
  type: 'displace';
  scale: Num;
  xChannelSelector?: NoiseChannel;
  yChannelSelector?: NoiseChannel;
  turbulence: Turbulence;
}
export interface CornerPinEffect {
  type: 'cornerPin';
  topLeft?: [Num, Num];
  topRight?: [Num, Num];
  bottomRight?: [Num, Num];
  bottomLeft?: [Num, Num];
}
export interface ShaderEffect {
  type: 'shader';
  /** WGSL defining `fn effect(px: vec2<f32>) -> vec4<f32>`. */
  code: string;
  /** Each reaches the shader as `u.<name>`. */
  uniforms?: Record<string, Num>;
  padding?: Num;
}

/** One SCENE.md effect: a union over `type` of all 22. */
export type Effect =
  | BlurEffect
  | BackdropBlurEffect
  | GlowEffect
  | ChromaticAberrationEffect
  | DropShadowEffect
  | InsetShadowEffect
  | SaturateEffect
  | ContrastEffect
  | BrightnessEffect
  | GrayscaleEffect
  | SepiaEffect
  | InvertEffect
  | HueRotateEffect
  | GradientMapEffect
  | LutEffect
  | GrainEffect
  | DitherEffect
  | HalftoneEffect
  | DotMatrixEffect
  | DisplaceEffect
  | CornerPinEffect
  | ShaderEffect;
export type EffectType = Effect['type'];
/** The effect with a given `type`. */
export type EffectOf<T extends EffectType> = Extract<Effect, { type: T }>;

// ---- layers ----

export interface LayerBase {
  /** Unique across the whole scene. */
  id: string;
  transform?: Transform;
  /** Clamped to 0..1. Default 1. */
  opacity?: Num;
  blendMode?: BlendMode;
  effects?: Effect[];
  clip?: Clip;
  mask?: Mask;
  matte?: Matte;
  motionBlur?: MotionBlurJson;
  layoutItem?: LayoutItem;
}

export interface Stroke {
  color: ColorString;
  width: Num;
}

export type ShapeGeometry =
  | { kind: 'rect'; width: Num; height: Num }
  | { kind: 'roundedRect'; width: Num; height: Num; radius: Num }
  | { kind: 'ellipse'; width: Num; height: Num }
  | { kind: 'path'; d: string };

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: ShapeGeometry;
  fill?: Paint;
  stroke?: Stroke;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  /** A key of the scene's `fonts`. */
  font: string;
  size: Num;
  color?: Paint;
  /** A multiple of `size`. */
  lineHeight?: Num;
  maxWidth?: Num;
  /** Default `left`. */
  align?: 'left' | 'center' | 'right';
  /** One entry per Unicode code point of `text`. */
  chars?: (CharStyle | null)[];
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  src: string;
  /** Both left out: the file's pixel size; one left out keeps the aspect ratio. */
  width?: Num;
  height?: Num;
  /** Default `fill`. */
  fit?: 'fill' | 'contain' | 'cover';
}

export interface GroupLayer extends LayerBase {
  type: 'group';
  children: LayerJson[];
  preserve3d?: boolean;
  layout?: Layout;
}

export interface NoiseLayer extends LayerBase {
  type: 'noise';
  width: Num;
  height: Num;
  turbulence: Turbulence;
  /** Default `rgba`. */
  channels?: 'rgba' | 'gray';
}

export interface MeshGradientLayer extends LayerBase {
  type: 'meshGradient';
  width: Num;
  height: Num;
  /** 2 to 8, default 3. */
  columns?: number;
  rows?: number;
  /** `columns x rows` `[x, y]` pairs, row by row. */
  points?: [Num, Num][];
  /** One per point. */
  colors: ColorString[];
}

export interface LottieLayer extends LayerBase {
  type: 'lottie';
  /** A Lottie `.json` or `.lottie` file, relative to the scene. */
  src: string;
  width?: Num;
  height?: Num;
  /** Seconds into the animation. Default: the frame's time. */
  time?: Num;
  /** Default false. */
  loop?: boolean;
}

export type LayerJson =
  | ShapeLayer
  | TextLayer
  | ImageLayer
  | GroupLayer
  | NoiseLayer
  | MeshGradientLayer
  | LottieLayer;
export type LayerType = LayerJson['type'];

// ---- scene ----

export interface CameraJson {
  /** Above 0 at every keyframe. */
  perspective: Num;
  /** Default: the middle of the canvas. */
  x?: Num;
  y?: Num;
}

export interface SceneJson {
  /** Integers, 1..=8192. */
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Default `#000000`. */
  background?: ColorString;
  /**
   * The least margin, in pixels, to render with: a whole number, not negative. The margin is this or what the effects
   * reach, whichever is more (SCENE.md "Canvas margin"). Default 0.
   */
  margin?: number;
  /** Font key to font file. */
  fonts?: Record<string, string>;
  camera?: CameraJson;
  /** Bottom layer first. */
  layers: LayerJson[];
}

/** AUTHORING.md §6.4. */
export interface AudioClipJson {
  id: string;
  src: string;
  from: number;
  trimBefore: number;
  trimAfter: number | null;
  playbackRate: number;
  volume: number;
  loop: boolean;
  muted: boolean;
}
