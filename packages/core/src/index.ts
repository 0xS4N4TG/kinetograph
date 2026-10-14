// @kinetograph/core: the Remotion-shaped authoring API (docs/AUTHORING.md
// §7). Projects import everything from here (and from `remotion`, which the
// CLI aliases to this package).
//
// Orchestrator scaffolding: exported names and signatures are the contract.
// Stream 2 (`feat/remotion-shim`) implements them from Remotion's documented
// behaviour, never from its source.

import type { ComponentType, ReactNode } from 'react';
import type { AudioClipJson, SceneJson } from '@kinetograph/scene';
import type { VideoConfig } from '@kinetograph/react';

export * from '@kinetograph/scene';
export {
  Audio,
  Camera,
  Ellipse,
  Image,
  Layer,
  Lottie,
  MeshGradient,
  Noise,
  Path,
  Rect,
  Shape,
  Text,
  TimelineContext,
  useTimeline,
} from '@kinetograph/react';
export type {
  AudioProps,
  CameraProps,
  CommonProps,
  EllipseProps,
  ImageProps,
  LayerProps,
  LottieProps,
  MeshGradientProps,
  NoiseProps,
  PathProps,
  RectProps,
  ShapeProps,
  TextProps,
  TimelineState,
  VideoConfig,
} from '@kinetograph/react';

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name} (@kinetograph/core, stream 2)`);
}

// ---- time ----

export function useCurrentFrame(): number {
  return notImplemented('useCurrentFrame');
}

export function useVideoConfig(): VideoConfig {
  return notImplemented('useVideoConfig');
}

export type ExtrapolateType = 'extend' | 'identity' | 'clamp' | 'wrap';
export interface InterpolateOptions {
  easing?: (t: number) => number;
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
}

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: InterpolateOptions,
): number {
  return notImplemented(`interpolate(${input}, ${inputRange}, ${outputRange}, ${JSON.stringify(options)})`);
}

export function interpolateColors(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly string[],
): string {
  return notImplemented(`interpolateColors(${input}, ${inputRange}, ${outputRange})`);
}

export interface SpringConfig {
  damping: number;
  mass: number;
  stiffness: number;
  overshootClamping: boolean;
}

export function spring(options: {
  frame: number;
  fps: number;
  config?: Partial<SpringConfig>;
  from?: number;
  to?: number;
  durationInFrames?: number;
  durationRestThreshold?: number;
  delay?: number;
  reverse?: boolean;
}): number {
  return notImplemented(`spring(${JSON.stringify(options)})`);
}

export function measureSpring(options: {
  fps: number;
  config?: Partial<SpringConfig>;
  threshold?: number;
  from?: number;
  to?: number;
}): number {
  return notImplemented(`measureSpring(${JSON.stringify(options)})`);
}

export type EasingFunction = (t: number) => number;

/** Remotion's `Easing` (React Native's set). */
export const Easing: {
  linear: EasingFunction;
  ease: EasingFunction;
  quad: EasingFunction;
  cubic: EasingFunction;
  poly: (n: number) => EasingFunction;
  sin: EasingFunction;
  circle: EasingFunction;
  exp: EasingFunction;
  elastic: (bounciness?: number) => EasingFunction;
  back: (s?: number) => EasingFunction;
  bounce: EasingFunction;
  bezier: (x1: number, y1: number, x2: number, y2: number) => EasingFunction;
  in: (easing: EasingFunction) => EasingFunction;
  out: (easing: EasingFunction) => EasingFunction;
  inOut: (easing: EasingFunction) => EasingFunction;
} = new Proxy({} as never, {
  get: (_target, name) => notImplemented(`Easing.${String(name)}`),
});

/** Deterministic pseudo-random number in [0, 1), bit-exact with Remotion's `random`. */
export function random(seed: number | string | null): number {
  return notImplemented(`random(${JSON.stringify(seed)})`);
}

// ---- timeline components ----

export interface SequenceProps {
  from?: number;
  durationInFrames?: number;
  name?: string;
  layout?: 'absolute-fill' | 'none';
  children?: ReactNode;
}
export function Sequence(props: SequenceProps): ReactNode {
  return notImplemented(`Sequence(${props.from})`);
}

export interface SeriesSequenceProps {
  durationInFrames: number;
  offset?: number;
  name?: string;
  layout?: 'absolute-fill' | 'none';
  children?: ReactNode;
}
function SeriesSequence(props: SeriesSequenceProps): ReactNode {
  return notImplemented(`Series.Sequence(${props.durationInFrames})`);
}
export const Series: ((props: { children?: ReactNode }) => ReactNode) & {
  Sequence: typeof SeriesSequence;
} = Object.assign((_props: { children?: ReactNode }): ReactNode => notImplemented('Series'), {
  Sequence: SeriesSequence,
});

export interface LoopProps {
  durationInFrames: number;
  times?: number;
  layout?: 'absolute-fill' | 'none';
  name?: string;
  children?: ReactNode;
}
export function Loop(props: LoopProps): ReactNode {
  return notImplemented(`Loop(${props.durationInFrames})`);
}

export interface FreezeProps {
  frame: number;
  active?: boolean | ((frame: number) => boolean);
  children?: ReactNode;
}
export function Freeze(props: FreezeProps): ReactNode {
  return notImplemented(`Freeze(${props.frame})`);
}

/** CSS-like style keys that map onto the engine (AUTHORING.md §7.1). */
export type FillStyle = Record<string, string | number | undefined>;

export interface AbsoluteFillProps {
  style?: FillStyle;
  children?: ReactNode;
}
export function AbsoluteFill(props: AbsoluteFillProps): ReactNode {
  return notImplemented(`AbsoluteFill(${JSON.stringify(props.style)})`);
}

export interface ImgProps {
  src: string;
  style?: FillStyle;
}
export function Img(props: ImgProps): ReactNode {
  return notImplemented(`Img(${props.src})`);
}

// ---- assets and async ----

/** The absolute path of `name` in the public directory. */
export function staticFile(name: string): string {
  return notImplemented(`staticFile(${name})`);
}

export function setPublicDir(dir: string): void {
  notImplemented(`setPublicDir(${dir})`);
}

export function delayRender(label?: string): number {
  return notImplemented(`delayRender(${label})`);
}

export function continueRender(handle: number): void {
  notImplemented(`continueRender(${handle})`);
}

export function cancelRender(error: unknown): void {
  notImplemented(`cancelRender(${String(error)})`);
}

// ---- compositions and fonts (AUTHORING.md §7.2) ----

export interface CompositionInfo {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
}

export interface CompositionProps<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  component?: ComponentType<P>;
  lazyComponent?: () => Promise<{ default: ComponentType<P> }>;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  defaultProps?: P;
  calculateMetadata?: (options: {
    defaultProps: P;
    props: P;
  }) =>
    | Partial<Omit<CompositionInfo, 'id'> & { props: P }>
    | Promise<Partial<Omit<CompositionInfo, 'id'> & { props: P }>>;
  schema?: unknown;
}
export function Composition<P extends Record<string, unknown>>(props: CompositionProps<P>): ReactNode {
  return notImplemented(`Composition(${props.id})`);
}

export type StillProps<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  CompositionProps<P>,
  'durationInFrames' | 'fps'
> & { fps?: number };
export function Still<P extends Record<string, unknown>>(props: StillProps<P>): ReactNode {
  return notImplemented(`Still(${props.id})`);
}

export function Folder(props: { name: string; children?: ReactNode }): ReactNode {
  return notImplemented(`Folder(${props.name})`);
}

export function registerRoot(root: ComponentType): void {
  notImplemented(`registerRoot(${root.name})`);
}

export function getInputProps(): Record<string, unknown> {
  return notImplemented('getInputProps');
}

export function getCompositions(): CompositionInfo[] {
  return notImplemented('getCompositions');
}

export function registerFont(font: {
  family: string;
  path: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
}): void {
  notImplemented(`registerFont(${JSON.stringify(font)})`);
}

/** fontKey → absolute path, every font registered. */
export function getFonts(): Record<string, string> {
  return notImplemented('getFonts');
}

// ---- frame loop (AUTHORING.md §7.3) ----

export interface FrameResult {
  scene: SceneJson;
  audio: AudioClipJson[];
}

export interface FrameRenderer {
  readonly config: VideoConfig;
  renderFrame(frame: number): Promise<FrameResult>;
  dispose(): void;
}

export function createFrameRenderer(
  compositionId: string,
  options?: { inputProps?: Record<string, unknown> },
): FrameRenderer {
  return notImplemented(`createFrameRenderer(${compositionId}, ${JSON.stringify(options)})`);
}
