// Types of the scene JSON: packages/cli/skills/kinetograph/references/SCENE.md, plus the additions of
// packages/cli/skills/kinetograph/references/AUTHORING.md §4 (flex layout, transform origin, text align and per
// character styles, lottie, image fit, box-unit gradients, motion-blur
// frames). A JSON value that type-checks as `SceneJson` should load.

export type ColorString = string;

/** The easing of the segment that starts at a keyframe (SCENE.md, "Animated numbers"). Named so it cannot clash with
 *  Remotion's `Easing` when `@kinetographdev/core` re-exports this package. */
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
  /** `[a, b, c, d, e, f]`: an affine from the gradient's space (after `units`) to the painted layer's: SVG's
   *  `gradientTransform`. `[1, 0, 0, k, 0, cy * (1 - k)]` squashes a radial gradient about `(cx, cy)` into an ellipse.
   *  Not animated. */
  transform?: [number, number, number, number, number, number];
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
/** A picture as a paint, once or tiled (`background-image: url()` with `background-repeat`): drawn `width` x `height`
 *  with its top-left corner at `(x, y)` in the painted layer's space, repeated along the axes that repeat; along the
 *  others its edge pixels are held, so cut the shape to the tile. `src` is a PNG, JPEG or GIF file or a `data:` URL. */
export interface ImagePaint {
  type: 'image';
  src: string;
  /** Default 0. */
  x?: Num;
  y?: Num;
  /** Above 0. */
  width: Num;
  height: Num;
  repeatX?: boolean;
  repeatY?: boolean;
}
/** A colour string, a gradient or a picture: a shape's `fill` and a text layer's `color`. */
export type Paint = ColorString | Gradient | ImagePaint;

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
  /** A CSS `matrix3d()`: sixteen numbers, column-major, applied about the anchor after `scale` and `rotation`. A
   *  matrix that only moves the plane is folded into the flat 2D matrix; any other warps the finished layer like
   *  `rotateX`. Not animated. */
  matrix?: number[];
  /** CSS's `backface-visibility: hidden`: not drawn while its 3D placement shows its back. */
  backfaceHidden?: boolean;
}

/** One run of glyphs that share a font file and size, already positioned (`TextLayer.runs`). */
export interface GlyphRun {
  /** The font file, relative to the scene or absolute. */
  src: string;
  /** The face in a font collection. Default 0. */
  index?: number;
  /** Font size in pixels. */
  size: number;
  /** Normalised variable-font coordinates (F2Dot14 as integers). */
  coords?: number[];
  /** Synthetic italic: degrees the glyphs lean right. */
  skew?: number;
  /** Synthetic bold: pixels the outlines grow on each side. */
  embolden?: number;
  /** `[glyph id, x, y]` for each glyph: its origin on its baseline, in the layer's box. */
  glyphs: [number, number, number][];
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
  /** SCENE.md, "Sub-frame changes": `frames` as what each sub-frame changes in the layer's tree. Not with `frames`. */
  changes?: { layer: LayerJson; replaces?: string; keepChildren?: boolean }[][];
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
  /** How a colour between two grid points is blended. Default 'trilinear'. */
  interpolation?: 'trilinear' | 'tetrahedral';
}
/** The controls of `colorGrade`'s `effects`: HyperFrames' 18 look effects (`blur`, `bloom`, `halftone`, ...) and their settings. */
export type ColorGradeEffectKey =
  | 'blur' | 'pixelate' | 'chromaBleed' | 'tapeDamage' | 'tapeTracking' | 'tapeNoise' | 'tapeSpeed' | 'filmArtifacts'
  | 'halftone' | 'halftoneSize' | 'twoInkPrint' | 'twoInkPrintSize'
  | 'ascii' | 'asciiSize' | 'asciiInvert' | 'asciiStyle' | 'asciiColor' | 'asciiRotation'
  | 'dither' | 'ditherSize' | 'bloom' | 'bloomRadius'
  | 'monoScreen' | 'monoScreenSize' | 'monoScreenAngle' | 'monoScreenSpread' | 'monoScreenShape' | 'monoScreenInvert'
  | 'scanlines' | 'scanlineCount' | 'scanlineSoftness' | 'chromaticAberration' | 'chromaticAngle' | 'crtCurvature'
  | 'digitalGlitch' | 'digitalGlitchColorSplit' | 'digitalGlitchLineTear' | 'digitalGlitchPixelate'
  | 'digitalGlitchBlockAmount' | 'digitalGlitchBlockDisplacement' | 'digitalGlitchBlockOpacity' | 'digitalGlitchSpeed'
  | 'engraving' | 'engravingSpacing' | 'engravingMinThickness' | 'engravingMaxThickness' | 'engravingAngle'
  | 'engravingContrast' | 'engravingSharpness' | 'engravingWave' | 'engravingWaveFrequency'
  | 'crosshatch' | 'crosshatchSpacing' | 'crosshatchThickness' | 'crosshatchAngle' | 'crosshatchContrast'
  | 'crosshatchEdges' | 'crosshatchLineWeight' | 'crosshatchWave' | 'crosshatchWaveFrequency'
  | 'kuwahara' | 'kuwaharaRadius' | 'kuwaharaSharpness' | 'kuwaharaSaturation';
export interface ColorGradeEffect {
  type: 'colorGrade';
  /** 0..1, default 1: the mix of the grade with the picture. */
  intensity?: number;
  /** exposure -2..2; contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation -1..1. */
  adjust?: Partial<
    Record<'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'temperature' | 'tint' | 'vibrance' | 'saturation', number>
  >;
  /** Each wheel: hue in degrees, amount 0..1, level -1..1. */
  wheels?: Partial<Record<'shadows' | 'midtones' | 'highlights', { hue?: number; amount?: number; level?: number }>>;
  /** Points [input, output], 2 to 16 per curve. */
  curves?: Partial<Record<'master' | 'red' | 'green' | 'blue', [number, number][]>>;
  /** Points [hue degrees, delta], 3 to 16 per curve. */
  hueCurves?: Partial<Record<'hueVsHue' | 'hueVsSaturation' | 'hueVsLuma', [number, number][]>>;
  /** Up to four HSL qualifiers with a correction each (HyperFrames' `secondaries`). */
  secondaries?: {
    key: {
      hue?: { center?: number; range?: number; softness?: number };
      saturation?: { min?: number; max?: number; softness?: number };
      luma?: { min?: number; max?: number; softness?: number };
    };
    correction: { hueShift?: number; saturation?: number; luma?: number; temperature?: number; tint?: number };
  }[];
  /** A `.cube` file relative to the scene file, and how much of it. */
  lut?: { src: string; intensity?: number };
  vignette?: { amount?: number; midpoint?: number; roundness?: number; feather?: number };
  /** Film grain, laid on the graded box. `seed` is a whole number the pattern is made from (also film artifacts' frame). */
  grain?: { amount?: number; size?: number; roughness?: number; seed?: number };
  /** The look effects, each control by name; a missing control keeps its HyperFrames default. */
  effects?: Partial<Record<ColorGradeEffectKey, number>>;
  /** 2 to 6 `#rrggbb` colours, darkest first, for ascii, dither, monoScreen, engraving and crosshatch. */
  palette?: string[];
  /** Seconds the time-varying effects run at (default: the frame's time). */
  time?: number;
  /** The picture's box in the layer's space [x, y, width, height], what the vignette, grain and the effects are laid out on. */
  box?: [number, number, number, number];
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

/** One SCENE.md effect: a union over `type` of all 23. */
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
  | ColorGradeEffect
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
  /** Glyphs someone else shaped and positioned (the DOM painter). When there are any, the core does not use `text`,
   *  `font`, `size`, `maxWidth`, `align`, `lineHeight` or `chars`, and does not require `font` to be in `fonts`. */
  runs?: GlyphRun[];
  /** The box of a layer with `runs`, in pixels. */
  boxWidth?: Num;
  boxHeight?: Num;
  /** An outline around each glyph (CSS `-webkit-text-stroke`), centred on the glyph's edge. Only `color`, `width`,
   *  `join` and `miterLimit` are used; `join` defaults to `round`. */
  stroke?: Stroke & { join?: 'miter' | 'round' | 'bevel'; miterLimit?: Num };
  /** Which is drawn on top: the fill (`strokeFill`) or the stroke (`fillStroke`, the default). */
  paintOrder?: 'fillStroke' | 'strokeFill';
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
  /**
   * Does not isolate the children: one that blends with a mode other than `normal` blends with what is behind the
   * group, as if it were not there (CSS `isolation: auto` on an element that is not a stacking context). Takes effect
   * on a group that is otherwise plain (packages/cli/skills/kinetograph/references/SCENE.md, "group").
   */
  passThrough?: boolean;
  layout?: Layout;
  /** A GLSL pass that makes the group's picture out of its children, which its `layer` textures name (packages/cli/skills/kinetograph/references/SCENE.md, "Shader groups"). */
  glsl?: GlslPass;
  /** A Canvas 2D drawing that makes the group's picture out of its children, which its `layer` sources name (packages/cli/skills/kinetograph/references/SCENE.md, "Canvas passes"). */
  canvas?: CanvasPass;
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

// ---- canvas (packages/cli/skills/kinetograph/references/SCENE.md, "canvas") ----

/** `[a, b, c, d, e, f]`, as a canvas's `setTransform` and SVG's `matrix()`. */
export type CanvasMatrix = [number, number, number, number, number, number];

/** Colour stops of a canvas gradient: `[offset, colour]`, offsets 0 to 1 in order. */
export type CanvasStops = [number, ColorString][];

export type CanvasPaint =
  | { type: 'color'; color: ColorString }
  | { type: 'linear'; x0: number; y0: number; x1: number; y1: number; stops: CanvasStops }
  | { type: 'radial'; x0: number; y0: number; r0: number; x1: number; y1: number; r1: number; stops: CanvasStops }
  /** `angle` in radians, clockwise from 3 o'clock. */
  | { type: 'conic'; x: number; y: number; angle: number; stops: CanvasStops }
  | { type: 'pattern'; source: CanvasSource; repeatX?: boolean; repeatY?: boolean; m?: [number, number, number, number, number, number] };

export type CanvasSource =
  /** An image file of the scene, by its `src`. */
  | { kind: 'src'; src: string }
  /** Straight-alpha RGBA8, base64: an `ImageData`. */
  | { kind: 'pixels'; width: number; height: number; data: string }
  /**
   * A picture of a video file: what a `<video>` shows, or a `<Video>` clip shows at a scene frame, at `time` seconds
   * after the file's first picture (SCENE.md "video", rule 5); `end` is where the clip ends, in seconds after the
   * first picture (the stream's end when omitted). This is what `onVideoFrame` hands a project to `drawImage`.
   */
  | { kind: 'video'; src: string; time: number; end?: number }
  /** Another canvas, drawn as a whole. */
  | { kind: 'canvas'; width: number; height: number; commands: CanvasCommand[] }
  /**
   * The picture of a child of a canvas pass (`GroupLayer.canvas`), by `id`: the child drawn on the canvas and read
   * as the pixels a browser holds for a canvas it was drawn on (packages/cli/skills/kinetograph/references/SCENE.md, "Canvas passes"). Outside such a
   * group nothing is drawn.
   */
  | { kind: 'layer'; id: string; width: number; height: number };

export type CanvasBlend =
  | 'source-over'
  | 'source-in'
  | 'source-out'
  | 'source-atop'
  | 'destination-over'
  | 'destination-in'
  | 'destination-out'
  | 'destination-atop'
  | 'lighter'
  | 'copy'
  | 'xor'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  /** What `clearRect` writes. */
  | 'clear';

/** `shadowColor`, `shadowBlur`, `shadowOffsetX` and `shadowOffsetY`, in canvas pixels. */
export interface CanvasShadow {
  color: string;
  /** `shadowBlur`: the blur's standard deviation is half of it. Default 0. */
  blur?: number;
  x?: number;
  y?: number;
}

/** One function of a `filter` list. The numbers are CSS's: lengths in pixels, angles in degrees, amounts 1 for no change. */
export type CanvasFilterFn =
  | { type: 'blur'; radius: number }
  | { type: 'brightness' | 'contrast' | 'grayscale' | 'invert' | 'saturate' | 'sepia'; amount: number }
  | { type: 'hueRotate'; angle: number }
  /** `blur` is the standard deviation, half the CSS length. */
  | { type: 'dropShadow'; x: number; y: number; blur: number; color: string };

/**
 * What every drawing command is drawn with; the defaults are the identity, 1 and `source-over`, no shadow and no
 * filter.
 */
export interface CanvasState {
  /** Takes the command's own space to the canvas. */
  m?: CanvasMatrix;
  /** `globalAlpha`, times the `opacity()` of the `filter`. */
  a?: number;
  blend?: CanvasBlend;
  /** Present only when the shadow shows: a colour with alpha, and a blur or an offset. */
  shadow?: CanvasShadow;
  /** `filter`, in order; `opacity()` is in `a`. */
  filter?: CanvasFilterFn[];
  /** The `url()` references in the `filter`, which are not drawn: the host reports them. */
  unsupportedFilter?: string;
}

export interface CanvasLine {
  /** Default 1. */
  width?: number;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  /** Default 10. */
  miterLimit?: number;
  dash?: number[];
  dashOffset?: number;
}

export type CanvasCommand =
  | ({ op: 'fill'; path: string; rule?: 'nonzero' | 'evenodd'; paint: CanvasPaint } & CanvasState)
  | ({ op: 'stroke'; path: string; paint: CanvasPaint } & CanvasLine & CanvasState)
  | ({
      op: 'text';
      text: string;
      /** A key of the scene's `fonts`. */
      font: string;
      size: number;
      x: number;
      y: number;
      align?: 'start' | 'end' | 'left' | 'right' | 'center';
      baseline?: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';
      /** Stroked glyph outlines instead of filled ones. */
      line?: CanvasLine;
      paint: CanvasPaint;
      maxWidth?: number;
      letterSpacing?: number;
      wordSpacing?: number;
    } & CanvasState)
  | ({
      op: 'image';
      source: CanvasSource;
      sx?: number;
      sy?: number;
      sw?: number;
      sh?: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
      /** Default true. */
      smooth?: boolean;
    } & CanvasState)
  | { op: 'clip'; path: string; rule?: 'nonzero' | 'evenodd'; m?: CanvasMatrix }
  | { op: 'unclip' };

export interface CanvasLayer extends LayerBase {
  type: 'canvas';
  width: Num;
  height: Num;
  commands?: CanvasCommand[];
}

// ---- glsl (packages/cli/skills/kinetograph/references/SCENE.md, "glsl") ----

export interface GlslProgram {
  vertex: string;
  fragment: string;
  /** Attribute name to location. */
  attributes?: Record<string, number>;
}

export interface GlslTexture {
  /** A picture file relative to the scene, or a `data:` URL. */
  src?: string;
  /** Base64 RGBA8, straight alpha. */
  pixels?: string;
  /** The `id` of a child of the shader group the recording belongs to: the texture is that layer, drawn. */
  layer?: string;
  width?: number;
  height?: number;
  flipY?: boolean;
  premultiply?: boolean;
  /** `generateMipmap` was called. */
  mipmaps?: boolean;
  /** A framebuffer's texture: `width` by `height`, drawn into by the ops that name it as their `target`. */
  target?: boolean;
}

export interface GlslAttribute {
  buffer: string;
  size: number;
  type: 'f32' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32';
  normalized?: boolean;
  stride?: number;
  offset?: number;
  /** `vertexAttribDivisor`: 1 advances for each instance (default 0, for each vertex). */
  divisor?: number;
}

export interface GlslUniform {
  /** `f` for `uniform*f`, `i` for `uniform*i`, `m` for `uniformMatrix*` (column-major). */
  kind: 'f' | 'i' | 'm';
  value: number[];
  /** The array element the first value goes to. */
  index?: number;
}

export interface GlslSampler {
  texture: string;
  min: string;
  mag: string;
  wrapS: string;
  wrapT: string;
}

export interface GlslBlend {
  srcRgb: string;
  dstRgb: string;
  srcAlpha: string;
  dstAlpha: string;
  eqRgb: string;
  eqAlpha: string;
  color: [number, number, number, number];
}

export interface GlslDepth {
  /** `NEVER`, `LESS`, `EQUAL`, `LEQUAL`, `GREATER`, `NOTEQUAL`, `GEQUAL` or `ALWAYS`. */
  func: string;
  mask: boolean;
  /** `depthRange`, each within 0 to 1. */
  near: number;
  far: number;
}

export interface GlslDraw {
  program: string;
  mode: 'points' | 'triangles' | 'triangleStrip' | 'triangleFan';
  first: number;
  count: number;
  /** `drawArraysInstanced` and `drawElementsInstanced`: how many instances (default 1). */
  instances?: number;
  indices?: { buffer: string; type: 'u8' | 'u16' | 'u32'; offset: number };
  attributes: Record<string, GlslAttribute>;
  uniforms: Record<string, GlslUniform[]>;
  units: Record<string, GlslSampler>;
  /** `x, y, width, height`, y up from the bottom row. */
  viewport: [number, number, number, number];
  scissor?: [number, number, number, number];
  blend?: GlslBlend;
  colorMask?: [boolean, boolean, boolean, boolean];
  cull?: { face: string; front: string };
  /** The depth test, when it was on and the buffer drawn into has a depth buffer (`depthFunc`, `depthMask`, `depthRange`). */
  depth?: GlslDepth;
  /** `polygonOffset(factor, units)` with `POLYGON_OFFSET_FILL` on; only with `depth`. */
  polygonOffset?: { factor: number; units: number };
  /** The id of the target texture it draws into; the drawing buffer without one. */
  target?: string;
}

/** `blitFramebuffer` (COLOR_BUFFER_BIT): a rectangle of one buffer over a rectangle of another. */
export interface GlslBlit {
  /** The target texture read; the drawing buffer without one. */
  src?: string;
  /** The target texture written; the drawing buffer without one. */
  target?: string;
  /** `x0, y0, x1, y1` of the source, y up from the bottom row; reversed corners mirror. */
  from: [number, number, number, number];
  to: [number, number, number, number];
  /** `LINEAR` rather than `NEAREST`. */
  linear?: boolean;
  /** `x, y, width, height` when the scissor test was on. */
  scissor?: [number, number, number, number];
}

/** `texSubImage2D` into a texture a framebuffer draws in: pixels over a rectangle of what the ops before it left. */
export interface GlslUpload {
  /** The target texture written. */
  target: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Base64 RGBA8, straight alpha. */
  pixels: string;
  flipY?: boolean;
  premultiply?: boolean;
}

/** `clear`: the colour (`COLOR_BUFFER_BIT`), the depth buffer (`DEPTH_BUFFER_BIT`, to `depth`), or both. */
export type GlslOp = { op: 'clear'; color?: [number, number, number, number]; depth?: number; target?: string } | ({ op: 'draw' } & GlslDraw) | ({ op: 'blit' } & GlslBlit) | ({ op: 'upload' } & GlslUpload);

/** What a WebGL context did: the programs, data and calls of a `glsl` layer. */
export interface GlslContent {
  premultipliedAlpha?: boolean;
  alpha?: boolean;
  programs: Record<string, GlslProgram>;
  /** Base64 bytes. */
  buffers: Record<string, string>;
  textures: Record<string, GlslTexture>;
  ops: GlslOp[];
  /** What a WebGPU context did (the other fields are empty then). */
  webgpu?: WebGpuContent;
}

// ---- webgpu (packages/cli/skills/kinetograph/references/SCENE.md, "glsl") ----

export interface WebGpuVertexAttribute {
  format: string;
  offset: number;
  location: number;
}

export interface WebGpuVertexLayout {
  stride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: WebGpuVertexAttribute[];
}

export interface WebGpuBlendComponent {
  operation?: string;
  srcFactor?: string;
  dstFactor?: string;
}

export interface WebGpuTarget {
  format: string;
  blend?: { color: WebGpuBlendComponent; alpha: WebGpuBlendComponent };
  writeMask?: number;
}

export interface WebGpuPipeline {
  /** The ids of the bind group layouts (`WebGpuContent.layouts`); omitted for `layout: 'auto'`. */
  layout?: string[];
  vertex: { module: string; entryPoint?: string; buffers: WebGpuVertexLayout[] };
  fragment?: { module: string; entryPoint?: string; targets: (WebGpuTarget | null)[] };
  primitive: { topology: string; stripIndexFormat?: string; frontFace: string; cullMode: string };
}

export interface WebGpuBindingLayout {
  binding: number;
  /** `GPUShaderStage` bits. */
  visibility: number;
  type: 'uniform' | 'storage' | 'read-only-storage' | 'texture' | 'storage-texture' | 'sampler';
  dynamicOffset?: boolean;
  /** Of a `storage-texture`: `write-only` when left out. */
  access?: 'read-only' | 'read-write';
  /** Of a `storage-texture`: the format the shader declares. */
  format?: string;
  /** Of a `texture`: `float` when left out. */
  sampleType?: 'float' | 'unfilterable-float' | 'sint' | 'uint';
  /** Of a `sampler`: `filtering` when left out. */
  samplerType?: 'filtering' | 'non-filtering';
}

/** `levels` mip levels of a texture, from `baseMip`. */
export interface WebGpuTextureView {
  id: string;
  baseMip: number;
  mips: number;
}

export type WebGpuBindEntry =
  | { binding: number; buffer: string; offset: number; size: number }
  | { binding: number; texture: WebGpuTextureView }
  | { binding: number; sampler: string };

export interface WebGpuBindGroup {
  /** An id of `WebGpuContent.layouts`, or `auto:<pipeline>:<index>` for a layout a pipeline made. */
  layout: string;
  entries: WebGpuBindEntry[];
}

/** A 2D texture. The recording never holds its contents: the steps that wrote it do. */
export interface WebGpuTexture {
  width: number;
  height: number;
  mips: number;
  format: string;
}

export interface WebGpuSampler {
  addressModeU?: string;
  addressModeV?: string;
  addressModeW?: string;
  magFilter?: string;
  minFilter?: string;
  mipmapFilter?: string;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  maxAnisotropy?: number;
}

/** A compute pipeline: `layout` is the ids of the bind group layouts, left out for `layout: 'auto'`. */
export interface WebGpuComputePipeline {
  layout?: string[];
  module: string;
  entryPoint?: string;
}

export type WebGpuCommand =
  | { c: 'pipeline'; id: string }
  | { c: 'bind'; index: number; group: string; offsets?: number[] }
  | { c: 'vertex'; slot: number; buffer: string; offset: number; size?: number }
  | { c: 'index'; buffer: string; format: string; offset: number; size?: number }
  | { c: 'draw'; vertices: number; instances: number; first: number; firstInstance: number }
  | { c: 'drawIndexed'; indices: number; instances: number; first: number; base: number; firstInstance: number }
  | { c: 'viewport'; x: number; y: number; width: number; height: number; minDepth: number; maxDepth: number }
  | { c: 'scissor'; x: number; y: number; width: number; height: number }
  | { c: 'blend'; color: [number, number, number, number] };

export interface WebGpuPass {
  k: 'render';
  /** A level of the texture drawn into; the canvas when left out. */
  target?: { texture: string; mip: number };
  /** The clear colour, or null for `loadOp: 'load'`. */
  clear: [number, number, number, number] | null;
  commands: WebGpuCommand[];
}

export type WebGpuComputeCommand =
  | { c: 'pipeline'; id: string }
  | { c: 'bind'; index: number; group: string; offsets?: number[] }
  | { c: 'dispatch'; x: number; y: number; z: number };

/** A compute pass: it writes the storage textures and storage buffers its bind groups hold. */
export interface WebGpuCompute {
  k: 'compute';
  commands: WebGpuComputeCommand[];
}

/** `queue.writeBuffer` into a buffer the GPU writes (a key of `WebGpuContent.gpuBuffers`): `data` is a key of `blobs`. */
export interface WebGpuBufferWrite {
  k: 'writeBuffer';
  buffer: string;
  offset: number;
  data: string;
}

/** `copyBufferToBuffer` between two buffers the GPU writes. */
export interface WebGpuBufferCopy {
  k: 'copyBuffer';
  from: string;
  fromOffset: number;
  to: string;
  toOffset: number;
  size: number;
}

/** `clearBuffer` of a buffer the GPU writes. */
export interface WebGpuBufferClear {
  k: 'clearBuffer';
  buffer: string;
  offset: number;
  size: number;
}

/** Where the pixels of an upload come from. A picture is decoded by the renderer, so a recording holds its path. */
export type WebGpuSource =
  /** Bytes in the texture's format, tightly packed: a key of `WebGpuContent.blobs`. */
  | { raw: string }
  /** Straight RGBA8 of `width` by `height`: a key of `blobs`. */
  | { pixels: { id: string; width: number; height: number } }
  | { src: string }
  /** The frame of a video file `time` seconds after its first picture. */
  | { video: { src: string; time: number } }
  /** A child of the shader group (or effect) the recording belongs to. */
  | { layer: string };

/** `writeTexture`, `copyBufferToTexture`, `copyExternalImageToTexture`: `width` by `height` texels of `source` (from `sx`, `sy`) at `x`, `y`. */
export interface WebGpuUpload {
  k: 'upload';
  texture: string;
  mip?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  source: WebGpuSource;
  sx?: number;
  sy?: number;
  flipY?: boolean;
  premultiply?: boolean;
}

export interface WebGpuCopy {
  k: 'copy';
  from: { texture: string; mip?: number; x: number; y: number };
  to: { texture: string; mip?: number; x: number; y: number };
  width: number;
  height: number;
}

/** What a queue did to the drawing or to a texture, in the order it did it. */
export type WebGpuStep = WebGpuPass | WebGpuUpload | WebGpuCopy | WebGpuCompute | WebGpuBufferWrite | WebGpuBufferCopy | WebGpuBufferClear;

/**
 * What a WebGPU context drew in a frame: the steps in order, with everything they use by id. A buffer is the bytes it
 * held when the command buffer that draws from it was submitted; ids are made from content, so a frame does not depend
 * on which frames were drawn before it.
 */
export interface WebGpuContent {
  /** WGSL, by id. */
  modules: Record<string, string>;
  layouts: Record<string, WebGpuBindingLayout[]>;
  pipelines: Record<string, WebGpuPipeline>;
  /** Base64 bytes: a buffer as it was when a pass that only reads it was submitted. */
  buffers: Record<string, string>;
  /** Buffers a compute pass writes, by id (`B<n>`): zeroed, and the steps that wrote them make their contents. */
  gpuBuffers?: Record<string, { size: number }>;
  computePipelines?: Record<string, WebGpuComputePipeline>;
  bindGroups: Record<string, WebGpuBindGroup>;
  /** The textures the steps and the bind groups use, by id. */
  textures?: Record<string, WebGpuTexture>;
  samplers?: Record<string, WebGpuSampler>;
  /** Base64 bytes written into textures, by id. */
  blobs?: Record<string, string>;
  /** Render and compute passes, uploads and copies, in the order the page submitted them. */
  passes: WebGpuStep[];
  /** Calls the engine does not draw; the frame reports each. */
  notes?: string[];
  /** What the frame reads that earlier frames made (state a page carries), so that the frame is not the same alone as in a sequence. */
  impure?: string[];
}

export interface GlslLayer extends LayerBase, Partial<GlslContent> {
  type: 'glsl';
  width: Num;
  height: Num;
}

/** A group's canvas pass: commands drawn on a canvas of `width` by `height`, whose `layer` sources are the group's children. */
export interface CanvasPass {
  width: Num;
  height: Num;
  commands?: CanvasCommand[];
}

/** A group's GLSL pass: a recording drawn into a buffer of `width` by `height`. */
export interface GlslPass extends Partial<GlslContent> {
  width: Num;
  height: Num;
}

export interface VideoLayer extends LayerBase {
  type: 'video';
  /** Any file FFmpeg reads with a video stream, relative to the scene. */
  src: string;
  /** Both left out: the stream's size; one left out keeps its aspect ratio. */
  width?: Num;
  height?: Num;
  /** Default `fill`. */
  fit?: 'fill' | 'contain' | 'cover';
  /** The scene frame the clip's clock reads. Default: the frame being rendered. */
  frame?: Num;
  /** The scene frame of the clip's frame 0. Default 0. */
  from?: number;
  /** Scene frames skipped at the start of the file. Default 0. */
  trimBefore?: number;
  /** Scene frames from the start of the file at which the clip ends. Default: the stream's end. */
  trimAfter?: number;
  /** Above 0, default 1. */
  playbackRate?: number;
  /** Default false. */
  loop?: boolean;
  /** Datamosh (SCENE.md "video", "datamosh"): inside the window the clip's motion moves a held picture. */
  datamosh?: DatamoshJson;
}

/**
 * A datamosh window, in scene frames: `from` shows the held picture, each later frame to `to` (exclusive) moves it by
 * the clip's own motion vectors, and the clip plays again from `to`. At most 600 frames.
 */
export interface DatamoshJson {
  from: number;
  to: number;
  /** What the motion moves: the clip's own picture one frame before `from` (default), or a frame of another file. */
  hold?: 'previous' | { src: string; frame: number };
  /** How much of the clip's residual (the new picture's detail) is added back, 0 to 1. Default 0. */
  mix?: number;
}

export interface GifLayer extends LayerBase {
  type: 'gif';
  /** A `.gif`, relative to the scene. */
  src: string;
  width?: Num;
  height?: Num;
  /** Default `fill`. */
  fit?: 'fill' | 'contain' | 'cover';
  /** Seconds into the animation. Default: the frame's time. */
  time?: Num;
  /** Default true. */
  loop?: boolean;
}

// ---- scene3d (packages/cli/skills/kinetograph/references/SCENE.md, "scene3d") ----

/** Three animatable numbers: x, y, z. */
export type Vec3 = [Num, Num, Num];

export type Geometry3D =
  | { kind: 'box'; width?: number; height?: number; depth?: number }
  | { kind: 'sphere'; radius?: number; segments?: number; rings?: number }
  | { kind: 'plane'; width?: number; height?: number }
  | { kind: 'cylinder'; radiusTop?: number; radiusBottom?: number; height?: number; segments?: number; capped?: boolean }
  | { kind: 'torus'; radius?: number; tube?: number; tubeSegments?: number; ringSegments?: number };

/** Metallic-roughness shading. */
export interface Material3D {
  /** Default `#ffffff`; its alpha multiplies `opacity`. */
  color?: ColorString;
  /** An image file, relative to the scene, multiplied by `color`. */
  texture?: string;
  /** 0..1, default 0. */
  metallic?: Num;
  /** 0..1, default 0.5. */
  roughness?: Num;
  /** Default black. */
  emissive?: ColorString;
  /** Default 1. */
  emissiveIntensity?: Num;
  /** 0..1, default 1. Below 1 the object is drawn after the opaque ones, farthest first. */
  opacity?: Num;
  /** Draws colour and emission only, with no lights. */
  unlit?: boolean;
  /** Draws back faces too. */
  doubleSided?: boolean;
}

export interface Placement3D {
  /** Default `[0, 0, 0]`. */
  position?: Vec3;
  /** Degrees, XYZ Euler angles. Default `[0, 0, 0]`. */
  rotation?: Vec3;
  /** Default 1. */
  scale?: Num | Vec3;
  /** Default true. */
  visible?: boolean;
}

/** Which objects cast and receive shadows (a directional light's `castShadow` turns the shadow map on). */
export interface Shadowing3D {
  /** Default false. */
  castShadow?: boolean;
  /** Default false. */
  receiveShadow?: boolean;
}

export interface Mesh3D extends Placement3D, Shadowing3D {
  type: 'mesh';
  id?: string;
  geometry: Geometry3D;
  material?: Material3D;
}
export interface Model3D extends Placement3D, Shadowing3D {
  type: 'model';
  id?: string;
  /** A `.gltf` or `.glb` file, relative to the scene. */
  src: string;
  /** Replaces the file's own materials. */
  material?: Material3D;
  /** The file's clip to play: its name, or its position in the file. With none the model stands as the file has it. */
  animation?: string | number;
  /** Seconds into the clip; animatable. Default: the scene's own time, `frame / fps`. */
  time?: Num;
  /** A clip that is over starts again (default true); `false` holds its last pose. */
  loop?: boolean;
}
export interface Text3D extends Placement3D, Shadowing3D {
  type: 'text';
  id?: string;
  text: string;
  /** A key of the scene's `fonts`. */
  font: string;
  /** The em size in world units. Default 1. */
  size?: number;
  /** Extrusion along z, centred on the origin. Default 0.2. */
  depth?: number;
  /** Default `center`. */
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  material?: Material3D;
}
export interface Extrude3D extends Placement3D, Shadowing3D {
  type: 'extrude';
  id?: string;
  /** SVG path data; y points down, as in SVG. */
  path: string;
  /** The longer side of the path's box in world units. Default 1. */
  size?: number;
  depth?: number;
  fillRule?: 'nonzero' | 'evenodd';
  material?: Material3D;
}
export interface Group3D extends Placement3D {
  type: 'group';
  id?: string;
  children?: Object3DJson[];
}
export type Object3DJson = Mesh3D | Model3D | Text3D | Extrude3D | Group3D;

export interface Camera3DJson {
  /** Default `perspective`. */
  type?: 'perspective' | 'orthographic';
  /** Perspective: vertical field of view in degrees, default 45. */
  fov?: Num;
  /** Orthographic: the world height shown, default 4. */
  height?: Num;
  /** Default 0.1. */
  near?: Num;
  /** Default 100. */
  far?: Num;
  /** Default `[0, 0, 5]`. */
  position?: Vec3;
  /** Default `[0, 0, 0]`. */
  target?: Vec3;
  /** Default `[0, 1, 0]`; not animated. */
  up?: [number, number, number];
}

/** A directional light's shadow map. The map covers the objects that cast shadows. */
export interface Shadow3DOptions {
  /** Texels along each side of the square map, 64 to 4096. Default 2048. */
  mapSize?: number;
  /** Texels a surface is moved toward the light before its depth is compared. Default 1. */
  bias?: number;
  /** Texels a surface is moved along its normal, more the more it leans away from the light. Default 1.5. */
  normalBias?: number;
  /** Half the width of the soft edge, in texels. Default 1. */
  radius?: number;
}

export type Light3DJson =
  | { type: 'ambient'; color?: ColorString; intensity?: Num }
  | {
      type: 'directional';
      direction?: Vec3;
      color?: ColorString;
      intensity?: Num;
      /** Shade what the objects that cast shadows block. At most 4 lights do. Default false. */
      castShadow?: boolean;
      shadow?: Shadow3DOptions;
    }
  | { type: 'point'; position: Vec3; color?: ColorString; intensity?: Num; range?: Num };

/**
 * Image-based lighting: an equirectangular picture of the surroundings. Its centre is toward +x and its top is +y, as
 * three.js reads it. It adds to the lights.
 */
export interface Environment3DJson {
  /** A Radiance `.hdr` (linear light, any brightness), or a `.png` or `.jpg` (sRGB), relative to the scene. */
  src: string;
  /** What the lighting from the picture is multiplied by. Default 1. */
  intensity?: Num;
  /** Degrees the picture is turned about y, counter-clockwise seen from above. Default 0. */
  rotation?: Num;
  /** Draw the picture behind the objects, which makes the layer opaque over its box. Default false. */
  background?: boolean;
  /** What the background is multiplied by. Default 1. */
  backgroundIntensity?: Num;
  /** 0 to 1: how blurred the background is. Default 0. */
  backgroundBlur?: Num;
}

export interface Scene3DLayer extends LayerBase {
  type: 'scene3d';
  width: Num;
  height: Num;
  /** 1 or 4, default 4. */
  msaa?: 1 | 4;
  camera?: Camera3DJson;
  environment?: Environment3DJson;
  /** At most 8. */
  lights?: Light3DJson[];
  objects?: Object3DJson[];
}

export type LayerJson =
  | ShapeLayer
  | TextLayer
  | ImageLayer
  | GroupLayer
  | NoiseLayer
  | MeshGradientLayer
  | LottieLayer
  | CanvasLayer
  | GlslLayer
  | Scene3DLayer
  | VideoLayer
  | GifLayer;
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
  /**
   * The space layers are composited in: `linear` (default) or `srgb`, as CSS does (SCENE.md "Blend space"). A tree with
   * DOM islands asks for `srgb`: the painter writes its layers for it (ENGINE.md §10.1).
   */
  blendSpace?: 'linear' | 'srgb';
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
  /** The sound of a `<Video>`: decoded with the addon's `decodeAudio` (packages/cli/skills/kinetograph/references/AUTHORING.md §11.3). */
  video?: boolean;
  /** Remotion's `toneFrequency`: the pitch times this (0.01 to 2), the length unchanged. Left out when it is 1. */
  toneFrequency?: number;
  /**
   * The audio effects of a HyperFrames media element (`data-fx-chain` on it, on its `<hf-audio-group>` and on the
   * composition root). With it, `volume` is the gain after the element's own chain.
   */
  hfFx?: HfAudioFxJson;
}

/** AUTHORING.md §6.4: a HyperFrames element's effects, as the mix runs them (HyperFrames' engine/audioMixer.ts). */
export interface HfAudioFxJson {
  /** The element. Its clips (a speed-ramped file plays as several) are one input to its chain. */
  track: string;
  /** Composition seconds at which the element's own time 0 falls: the clock of its lanes. */
  start: number;
  /** Composition seconds at which the element ends; an effect tail plays on after it, at most 5 s. */
  end: number;
  /** The element's `data-fx-chain`, or null when it has no effect in the path. */
  chain: string | null;
  /** The element's `data-automation`, whose `fx.*` lanes drive its chain. */
  automation: string | null;
  /** The gain ahead of the chain (`data-volume` when the chain has effects, else 1). */
  pre: number;
  /** The gain after the chain from `end` on (the volume lane's last value, 0 after a fade-out). */
  after: number;
  /**
   * The `<hf-audio-group>` bus the element plays into, when the group has effects: its chain, its `data-automation`
   * (lanes on composition time) and its `data-volume`. Its fader is `volume` times its `volume` lane.
   */
  group: { id: string; chain: string; automation: string | null; volume: number } | null;
  /** The master bus: the root composition's `data-fx-chain`, run over the whole mix. */
  master: string | null;
}

/** Something compat mode cannot draw (kinetograph site, /docs/compat/); a frame holding one is drawn without it or approximated. */
export interface Unsupported {
  /** The element's host-tree path and tag: `'$0.2.1 <div>'`. */
  path: string;
  /** `'div'`, `'svg > text'`, … */
  element: string;
  /** `'transform'`; null for an unsupported element. */
  property: string | null;
  value: string | null;
  reason: string;
}

/** A `<Sequence>` as the timeline sees it (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4). */
export interface SequenceJson {
  /** `${parent key ?? ''}/${name ?? 'Sequence'}@${from}+${durationInFrames}`, stable across frames. */
  key: string;
  name: string | null;
  /** The absolute frame of the Sequence's frame 0. */
  from: number;
  /** Clamped to what is left of the parent's, so always finite. */
  durationInFrames: number;
  /** Key of the enclosing Sequence. */
  parent: string | null;
  /** Id of the group its children are in on this frame; null when not showing or with `layout="none"`. */
  layer: string | null;
  /** Studio builds only: the name a person would give it (`name`, else the first user component inside, else `Sequence`). */
  label?: string;
  /** Studio builds only: the nearest user component whose render wrote the `<Sequence>`. */
  component?: string;
  /** Studio builds only: the `<Sequence>` JSX. */
  source?: SourceLocation;
}

/** Where a piece of JSX is in the project; studio builds only. */
export interface SourceLocation {
  /** Relative to the directory the studio was started in; absolute when outside it. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** What the studio shows for a layer instead of its path id; studio builds only. */
export interface LayerName {
  label: string;
  component?: string;
  source?: SourceLocation;
}
