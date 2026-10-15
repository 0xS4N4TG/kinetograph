// The parsed forms of the inline CSS compat mode reads (docs/COMPAT.md §3, §4).
// Committed with the contract: stream 1 (`feat/compat-css`) produces these and
// stream 2 (`feat/compat-dom`) reads them. Stream 1 may add fields; changing an
// existing one goes through the orchestrator.

export type LengthUnit = 'px' | '%' | 'em' | 'rem' | 'vw' | 'vh';
export interface Length {
  unit: LengthUnit;
  value: number;
}
export type LengthOrAuto = Length | 'auto';
export type LengthOrNone = Length | 'none';

/** sRGB, straight alpha: r, g, b in 0..255, a in 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
/** A colour, or `currentcolor` (the element's `color`, resolved by the mapping). */
export type ColorValue = Rgba | 'currentcolor';

/** Top, right, bottom, left. */
export type Sides<T> = [T, T, T, T];
/** Top-left, top-right, bottom-right, bottom-left; each `[horizontal, vertical]`. */
export type Corners = [[Length, Length], [Length, Length], [Length, Length], [Length, Length]];

/** One function of a `transform` list; angles in degrees. */
export type TransformOp =
  | { op: 'translate'; x: Length; y: Length; z: Length }
  | { op: 'scale'; x: number; y: number; z: number }
  | { op: 'rotate'; axis: 'x' | 'y' | 'z'; angle: number }
  | { op: 'skew'; x: number; y: number }
  /** `matrix(a b c d e f)` (6 values) or `matrix3d` (16, column-major). */
  | { op: 'matrix'; values: number[] }
  | { op: 'perspective'; length: Length };

export interface BoxShadow {
  inset: boolean;
  x: Length;
  y: Length;
  blur: Length;
  spread: Length;
  color: ColorValue;
}

export interface TextShadow {
  x: Length;
  y: Length;
  blur: Length;
  color: ColorValue;
}

/** One function of a `filter` list; amounts as CSS numbers (`50%` is 0.5), angles in degrees. */
export type FilterOp =
  | { op: 'blur'; radius: Length }
  | { op: 'drop-shadow'; x: Length; y: Length; blur: Length; color: ColorValue }
  | { op: 'brightness' | 'contrast' | 'saturate' | 'grayscale' | 'sepia' | 'invert' | 'opacity'; amount: number }
  | { op: 'hue-rotate'; angle: number };

export type ShapeRadius = Length | 'closest-side' | 'farthest-side';

export type ClipShape =
  | { kind: 'inset'; sides: Sides<Length>; radius: Corners }
  | { kind: 'circle'; r: ShapeRadius; cx: Length; cy: Length }
  | { kind: 'ellipse'; rx: ShapeRadius; ry: ShapeRadius; cx: Length; cy: Length }
  /** `fillRule` is present only when it is `evenodd`; the default is `nonzero`. */
  | { kind: 'polygon'; points: [Length, Length][]; fillRule?: 'evenodd' }
  | { kind: 'path'; d: string; fillRule?: 'evenodd' };

export interface ColorStop {
  color: ColorValue;
  /** Null: spread evenly between its neighbours, as CSS does. */
  position: Length | null;
}

export type Corner = 'top left' | 'top right' | 'bottom left' | 'bottom right';
export type RadialSize = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | [Length, Length];

export type BackgroundImage =
  /** `angle` in degrees (CSS's: 0 to top, 90 to right), or a corner that depends on the box. */
  | { kind: 'linear'; angle: number | Corner; stops: ColorStop[]; repeating: boolean }
  | { kind: 'radial'; shape: 'circle' | 'ellipse'; size: RadialSize; cx: Length; cy: Length; stops: ColorStop[]; repeating: boolean }
  | { kind: 'conic'; angle: number; cx: Length; cy: Length; stops: ColorStop[]; repeating: boolean }
  | { kind: 'url'; url: string };

export type BackgroundSize = 'cover' | 'contain' | [LengthOrAuto, LengthOrAuto];

/** Every property compat mode reads, parsed; a property left out of the style is left out here. */
export interface ParsedStyle {
  // ---- layout (docs/COMPAT.md §4.2, §5) ----
  display?: 'block' | 'flex' | 'inline-block' | 'inline-flex' | 'inline' | 'none';
  position?: 'static' | 'relative' | 'absolute' | 'fixed';
  inset?: Sides<LengthOrAuto>;
  width?: LengthOrAuto;
  height?: LengthOrAuto;
  minWidth?: LengthOrAuto;
  minHeight?: LengthOrAuto;
  maxWidth?: LengthOrNone;
  maxHeight?: LengthOrNone;
  aspectRatio?: number;
  boxSizing?: 'content-box' | 'border-box';
  margin?: Sides<LengthOrAuto>;
  padding?: Sides<Length>;
  /** As computed: a side whose style is `none` or `hidden` has width 0; an unset width is `medium` (3px). Set (all three
   *  of `borderWidth`, `borderStyle`, `borderColor`) as soon as any `border*` property is. */
  borderWidth?: Sides<Length>;
  /** An unset style is `none`. */
  borderStyle?: Sides<string>;
  /** An unset colour is `currentcolor`. */
  borderColor?: Sides<ColorValue>;
  borderRadius?: Corners;
  flexDirection?: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: LengthOrAuto | 'content';
  justifyContent?: string;
  alignItems?: string;
  alignSelf?: string;
  alignContent?: string;
  rowGap?: Length;
  columnGap?: Length;
  order?: number;
  zIndex?: number | 'auto';
  overflowX?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
  overflowY?: 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto';
  visibility?: 'visible' | 'hidden' | 'collapse';

  // ---- paint ----
  opacity?: number;
  backgroundColor?: ColorValue;
  /** First is on top, as CSS lists them. */
  backgroundImage?: BackgroundImage[];
  backgroundSize?: BackgroundSize[];
  backgroundPosition?: [Length, Length][];
  backgroundRepeat?: string[];
  backgroundClip?: 'border-box' | 'padding-box' | 'content-box' | 'text';
  backgroundOrigin?: 'border-box' | 'padding-box' | 'content-box';
  boxShadow?: BoxShadow[];
  filter?: FilterOp[];
  mixBlendMode?: string;
  transform?: TransformOp[];
  transformOrigin?: [Length, Length, Length];
  transformStyle?: 'flat' | 'preserve-3d';
  perspective?: LengthOrNone;
  perspectiveOrigin?: [Length, Length];
  clipPath?: ClipShape | 'none';
  maskImage?: BackgroundImage[];
  maskSize?: BackgroundSize[];
  maskPosition?: [Length, Length][];
  maskRepeat?: string[];
  objectFit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
  objectPosition?: [Length, Length];

  // ---- text (docs/COMPAT.md §4.4) ----
  color?: ColorValue;
  fontFamily?: string[];
  fontSize?: Length | 'xx-small' | 'x-small' | 'small' | 'medium' | 'large' | 'x-large' | 'xx-large' | 'smaller' | 'larger';
  fontWeight?: number | 'bolder' | 'lighter';
  fontStyle?: 'normal' | 'italic' | 'oblique';
  /** A number is a multiple of the font size. */
  lineHeight?: number | Length | 'normal';
  letterSpacing?: Length | 'normal';
  wordSpacing?: Length | 'normal';
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  textDecoration?: string;
  textShadow?: TextShadow[];
  whiteSpace?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line' | 'break-spaces';

  // ---- SVG presentation properties (docs/COMPAT.md §4.5), as style values ----
  fill?: SvgPaint;
  stroke?: SvgPaint;
  fillOpacity?: number;
  strokeOpacity?: number;
  /** A bare number is px, as SVG takes it. */
  strokeWidth?: Length;
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'arcs' | 'miter-clip';
  strokeDasharray?: Length[] | 'none';
  fillRule?: 'nonzero' | 'evenodd';
}

/** A `fill` or `stroke`: a colour, `none`, or a reference to a paint server (`url(#id)`) with an optional fallback. */
export type SvgPaint = ColorValue | 'none' | { url: string; fallback?: ColorValue | 'none' };

// ---- added by stream 1 (docs/COMPAT.md §3) ----

export interface Diagnostic {
  property: string;
  value: string;
  reason: string;
}

export interface LengthContext {
  /** What a percentage is of, px. */
  percentOf: number;
  fontSize: number;
  rootFontSize: number;
  viewport: { width: number; height: number };
}
