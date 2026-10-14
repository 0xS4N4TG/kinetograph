// @kinetograph/scene: TypeScript types of the scene JSON (docs/SCENE.md and
// docs/AUTHORING.md §4) and the effect, paint and motion-blur helpers
// (AUTHORING.md §5).
//
// Orchestrator scaffolding: the exported names and signatures are the
// contract. Stream 3 (`feat/reconciler`) completes the types (every field of
// every layer and effect) and implements the helpers.

export type ColorString = string;

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

export type Extend = 'pad' | 'repeat' | 'reflect';

export interface Stop {
  offset: Num;
  color: ColorString;
}

interface GradientBase {
  stops: Stop[];
  extend?: Extend;
  /** AUTHORING.md §4.5. */
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
  r: Num;
}
export interface ConicGradient extends GradientBase {
  type: 'conic';
  cx: Num;
  cy: Num;
  angle?: Num;
}
export type Gradient = LinearGradient | RadialGradient | ConicGradient;
export type Paint = ColorString | Gradient;

export interface Transform {
  x?: Num;
  y?: Num;
  scale?: Num;
  rotation?: Num;
  anchorX?: Num;
  anchorY?: Num;
  /** AUTHORING.md §4.2. */
  originX?: Num;
  originY?: Num;
  rotateX?: Num;
  rotateY?: Num;
  z?: Num;
}

/** One SCENE.md effect. Stream 3 replaces this with the union of all 22. */
export interface Effect {
  type: string;
  [field: string]: unknown;
}

export type Clip =
  | { kind: 'polygon'; points: [Num, Num][] }
  | { kind: 'inset'; top?: Num; right?: Num; bottom?: Num; left?: Num; radius?: Num }
  | { kind: 'ellipse'; cx: Num; cy: Num; rx: Num; ry: Num }
  | { kind: 'path'; d: string };

export interface Mask {
  gradient: Gradient;
  mode?: 'alpha' | 'luminance';
}

export interface Matte {
  layer: string;
  mode?: 'alpha' | 'alphaInverted' | 'luminance' | 'luminanceInverted';
}

export interface MotionBlurJson {
  samples?: number;
  shutter?: Num;
  /** AUTHORING.md §4.5: one complete layer per sub-frame. */
  frames?: LayerJson[];
}

/** AUTHORING.md §4.1. */
export interface Layout {
  display?: 'flex';
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'space-between'
    | 'space-around'
    | 'space-evenly';
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch';
  alignContent?:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
    | 'stretch';
  gap?: Num | [Num, Num];
  padding?: Num | [Num, Num, Num, Num];
  width?: Num;
  height?: Num;
}

/** AUTHORING.md §4.1. */
export interface LayoutItem {
  position?: 'relative' | 'absolute';
  flexGrow?: Num;
  flexShrink?: Num;
  flexBasis?: Num | 'auto';
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch';
  margin?: Num | [Num, Num, Num, Num];
  width?: Num;
  height?: Num;
}

/** AUTHORING.md §4.3. */
export interface CharStyle {
  x?: Num;
  y?: Num;
  scale?: Num;
  rotation?: Num;
  opacity?: Num;
  color?: ColorString;
}

export interface LayerBase {
  id: string;
  transform?: Transform;
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

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape:
    | { kind: 'rect'; width: Num; height: Num }
    | { kind: 'roundedRect'; width: Num; height: Num; radius: Num }
    | { kind: 'ellipse'; width: Num; height: Num }
    | { kind: 'path'; d: string };
  fill?: Paint;
  stroke?: Stroke;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  font: string;
  size: Num;
  color?: Paint;
  lineHeight?: Num;
  maxWidth?: Num;
  align?: 'left' | 'center' | 'right';
  chars?: (CharStyle | null)[];
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
}

export interface GroupLayer extends LayerBase {
  type: 'group';
  children: LayerJson[];
  preserve3d?: boolean;
  layout?: Layout;
}

export interface Turbulence {
  type: 'fractalNoise' | 'turbulence';
  baseFrequency: Num | [Num, Num];
  numOctaves?: number;
  seed: number;
}

export interface NoiseLayer extends LayerBase {
  type: 'noise';
  width: Num;
  height: Num;
  turbulence: Turbulence;
  channels?: 'rgba' | 'gray';
}

export interface MeshGradientLayer extends LayerBase {
  type: 'meshGradient';
  width: Num;
  height: Num;
  columns?: number;
  rows?: number;
  points?: [Num, Num][];
  colors: ColorString[];
}

export interface LottieLayer extends LayerBase {
  type: 'lottie';
  src: string;
  width?: Num;
  height?: Num;
  time?: Num;
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

export interface CameraJson {
  perspective: Num;
  x?: Num;
  y?: Num;
}

export interface SceneJson {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background?: ColorString;
  fonts?: Record<string, string>;
  camera?: CameraJson;
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

// ---- helpers (AUTHORING.md §5.2) ----

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name} (@kinetograph/scene, stream 3)`);
}

type Fields = Record<string, unknown>;

export function blur(radius: Num | { radius: Num }): Effect {
  return notImplemented(`blur(${JSON.stringify(radius)})`);
}
export function backdropBlur(radius: Num | { radius: Num }): Effect {
  return notImplemented(`backdropBlur(${JSON.stringify(radius)})`);
}
export function glow(radius: Num | { radius: Num; color?: ColorString; intensity?: Num }): Effect {
  return notImplemented(`glow(${JSON.stringify(radius)})`);
}
export function chromaticAberration(amount: Num | { amount: Num; angle?: Num }): Effect {
  return notImplemented(`chromaticAberration(${JSON.stringify(amount)})`);
}
export function dropShadow(fields: Fields): Effect {
  return notImplemented(`dropShadow(${JSON.stringify(fields)})`);
}
export function insetShadow(fields: Fields): Effect {
  return notImplemented(`insetShadow(${JSON.stringify(fields)})`);
}
export function saturate(amount: Num | { amount: Num }): Effect {
  return notImplemented(`saturate(${JSON.stringify(amount)})`);
}
export function contrast(amount: Num | { amount: Num }): Effect {
  return notImplemented(`contrast(${JSON.stringify(amount)})`);
}
export function brightness(amount: Num | { amount: Num }): Effect {
  return notImplemented(`brightness(${JSON.stringify(amount)})`);
}
export function grayscale(amount?: Num | { amount: Num }): Effect {
  return notImplemented(`grayscale(${JSON.stringify(amount)})`);
}
export function sepia(amount?: Num | { amount: Num }): Effect {
  return notImplemented(`sepia(${JSON.stringify(amount)})`);
}
export function invert(amount?: Num | { amount: Num }): Effect {
  return notImplemented(`invert(${JSON.stringify(amount)})`);
}
export function hueRotate(angle: Num | { angle: Num }): Effect {
  return notImplemented(`hueRotate(${JSON.stringify(angle)})`);
}
export function gradientMap(fields: Fields): Effect {
  return notImplemented(`gradientMap(${JSON.stringify(fields)})`);
}
export function lut(fields: Fields): Effect {
  return notImplemented(`lut(${JSON.stringify(fields)})`);
}
export function grain(amount: Num, fields: Fields): Effect {
  return notImplemented(`grain(${JSON.stringify([amount, fields])})`);
}
export function dither(levels?: Num, fields?: Fields): Effect {
  return notImplemented(`dither(${JSON.stringify([levels, fields])})`);
}
export function halftone(fields?: Fields): Effect {
  return notImplemented(`halftone(${JSON.stringify(fields)})`);
}
export function dotMatrix(fields: Fields): Effect {
  return notImplemented(`dotMatrix(${JSON.stringify(fields)})`);
}
export function displace(fields: Fields): Effect {
  return notImplemented(`displace(${JSON.stringify(fields)})`);
}
export function cornerPin(fields: Fields): Effect {
  return notImplemented(`cornerPin(${JSON.stringify(fields)})`);
}
export function shader(fields: Fields): Effect {
  return notImplemented(`shader(${JSON.stringify(fields)})`);
}

/** A marker for an `effects` array; the reconciler moves it to the layer's `motionBlur`. */
export interface MotionBlurMarker {
  type: 'motionBlur';
  samples?: number;
  shutter?: Num;
}
export function motionBlur(options?: { samples?: number; shutter?: Num }): MotionBlurMarker {
  return notImplemented(`motionBlur(${JSON.stringify(options)})`);
}

export type GradientColors = (ColorString | [offset: number, color: ColorString])[];

export function linearGradient(
  colors: GradientColors,
  options?: { angle?: number; extend?: Extend },
): Gradient {
  return notImplemented(`linearGradient(${JSON.stringify([colors, options])})`);
}
export function radialGradient(
  colors: GradientColors,
  options?: { cx?: number; cy?: number; r?: number; extend?: Extend },
): Gradient {
  return notImplemented(`radialGradient(${JSON.stringify([colors, options])})`);
}
export function conicGradient(
  colors: GradientColors,
  options?: { cx?: number; cy?: number; angle?: number; extend?: Extend },
): Gradient {
  return notImplemented(`conicGradient(${JSON.stringify([colors, options])})`);
}
export function gradient(json: Gradient): Gradient {
  return notImplemented(`gradient(${JSON.stringify(json)})`);
}

/** `'Inter'` for 400 normal, else `'Inter:700'`, `'Inter:400i'`, `'Inter:700i'`. */
export function fontKey(
  family: string,
  weight?: number | string,
  style?: 'normal' | 'italic',
): string {
  return notImplemented(`fontKey(${JSON.stringify([family, weight, style])})`);
}

export interface EffectField {
  name: string;
  type: string;
  default?: unknown;
  description: string;
}
export interface EffectInfo {
  type: string;
  description: string;
  fields: EffectField[];
}
/** Every effect and its fields, for `kinetograph effects`. */
export const effectCatalog: EffectInfo[] = [];

// ---- motion blur (AUTHORING.md §5.3) ----

export function motionTimes(frame: number, samples: number, shutter: number): number[] {
  return notImplemented(`motionTimes(${frame}, ${samples}, ${shutter})`);
}
export function collectMotionTimes(layers: LayerJson[], frame: number): number[] {
  return notImplemented(`collectMotionTimes(${layers.length} layers, ${frame})`);
}
export function attachMotionFrames(
  layers: LayerJson[],
  frame: number,
  treesAt: ReadonlyMap<number, LayerJson[]>,
): LayerJson[] {
  return notImplemented(`attachMotionFrames(${layers.length} layers, ${frame}, ${treesAt.size} trees)`);
}
