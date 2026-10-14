// @kinetograph/react: the react-reconciler host config that emits scene
// JSON, and the native elements (docs/AUTHORING.md §6).
//
// Orchestrator scaffolding: names and prop types are the contract. Stream 3
// (`feat/reconciler`) implements `createSceneRoot` and the elements. Until
// then the elements render placeholder host elements named `kg-*`, which no
// reconciler here understands yet.

import { createElement, type ReactNode } from 'react';
import type {
  AudioClipJson,
  BlendMode,
  CameraJson,
  CharStyle,
  Clip,
  ColorString,
  Effect,
  LayerJson,
  Layout,
  LayoutItem,
  Mask,
  Matte,
  MotionBlurMarker,
  Num,
  Paint,
  Stroke,
  Turbulence,
} from '@kinetograph/scene';

export { TimelineContext, useTimeline } from './timeline.js';
export type { TimelineState, VideoConfig } from './timeline.js';

// ---- root (AUTHORING.md §6.1) ----

export interface RenderedTree {
  layers: LayerJson[];
  camera: CameraJson | null;
  audio: AudioClipJson[];
}

export interface SceneRoot {
  /** Renders `element` synchronously (effects flushed) and returns the emitted tree. */
  render(element: ReactNode): RenderedTree;
  /** The tree as it is now, after state updates since the last render. */
  snapshot(): RenderedTree;
  unmount(): void;
}

export function createSceneRoot(): SceneRoot {
  throw new Error('not implemented: createSceneRoot (@kinetograph/react, stream 3)');
}

// ---- elements (AUTHORING.md §6.3) ----

export interface CommonProps {
  id?: string;
  x?: Num;
  y?: Num;
  scale?: Num;
  rotation?: Num;
  anchorX?: Num;
  anchorY?: Num;
  originX?: Num;
  originY?: Num;
  origin?: 'center' | [number, number];
  rotateX?: Num;
  rotateY?: Num;
  z?: Num;
  opacity?: Num;
  blendMode?: BlendMode;
  effects?: (Effect | MotionBlurMarker)[];
  clip?: Clip;
  mask?: Mask;
  matte?: Matte;
  motionBlur?: { samples?: number; shutter?: number };
  layoutItem?: LayoutItem;
}

export interface LayerProps extends CommonProps {
  preserve3d?: boolean;
  layout?: Layout;
  children?: ReactNode;
}

export interface ShapeProps extends CommonProps {
  kind: 'rect' | 'roundedRect' | 'ellipse' | 'path';
  width?: Num;
  height?: Num;
  radius?: Num;
  d?: string;
  fill?: Paint;
  stroke?: Stroke;
}

export interface RectProps extends CommonProps {
  width: Num;
  height: Num;
  radius?: Num;
  fill?: Paint;
  stroke?: Stroke;
}

export interface EllipseProps extends CommonProps {
  width: Num;
  height: Num;
  fill?: Paint;
  stroke?: Stroke;
}

export interface PathProps extends CommonProps {
  d: string;
  fill?: Paint;
  stroke?: Stroke;
}

export type CharStyleFn = (char: string, index: number, count: number) => CharStyle | null | undefined;

export interface TextProps extends CommonProps {
  children?: ReactNode;
  font: string;
  weight?: number | string;
  fontStyle?: 'normal' | 'italic';
  size: Num;
  color?: Paint;
  /** Alias of `color`. */
  fill?: Paint;
  lineHeight?: Num;
  maxWidth?: Num;
  align?: 'left' | 'center' | 'right';
  chars?: (CharStyle | null)[] | CharStyleFn;
}

export interface ImageProps extends CommonProps {
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
}

export interface NoiseProps extends CommonProps {
  width: Num;
  height: Num;
  turbulence: Turbulence;
  channels?: 'rgba' | 'gray';
}

export interface MeshGradientProps extends CommonProps {
  width: Num;
  height: Num;
  columns?: number;
  rows?: number;
  points?: [Num, Num][];
  colors: ColorString[];
}

export interface LottieProps extends CommonProps {
  src?: string;
  /** Parsed Lottie JSON, written once to a content-addressed cache file. */
  animationData?: unknown;
  width?: Num;
  height?: Num;
  loop?: boolean;
  playbackRate?: number;
}

export interface CameraProps {
  perspective: Num;
  x?: Num;
  y?: Num;
}

export interface AudioProps {
  id?: string;
  src: string;
  volume?: number | ((frame: number) => number);
  trimBefore?: number;
  trimAfter?: number;
  /** Older name of `trimBefore`. */
  startFrom?: number;
  /** Older name of `trimAfter`. */
  endAt?: number;
  playbackRate?: number;
  loop?: boolean;
  muted?: boolean;
}

export function Layer(props: LayerProps) {
  return createElement('kg-layer', props);
}
export function Shape(props: ShapeProps) {
  return createElement('kg-shape', props);
}
export function Rect(props: RectProps) {
  return createElement('kg-rect', props);
}
export function Ellipse(props: EllipseProps) {
  return createElement('kg-ellipse', props);
}
export function Path(props: PathProps) {
  return createElement('kg-path', props);
}
export function Text(props: TextProps) {
  return createElement('kg-text', props);
}
export function Image(props: ImageProps) {
  return createElement('kg-image', props);
}
export function Noise(props: NoiseProps) {
  return createElement('kg-noise', props);
}
export function MeshGradient(props: MeshGradientProps) {
  return createElement('kg-mesh-gradient', props);
}
export function Lottie(props: LottieProps) {
  return createElement('kg-lottie', props);
}
export function Camera(props: CameraProps) {
  return createElement('kg-camera', props);
}
export function Audio(props: AudioProps) {
  return createElement('kg-audio', props);
}
