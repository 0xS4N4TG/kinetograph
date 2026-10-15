// The props of the native elements, as `@kinetograph/react` declares them (docs/AUTHORING.md §6.3). They are written
// out here because this package cannot import that one (see timeline.ts); the Chrome bundle never type-checks
// against them, it only needs the same names to be exported.

import type { ReactNode } from 'react';
import type {
  BlendMode,
  CharStyle,
  Clip,
  ColorString,
  Effect,
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
  animationData?: unknown;
  width?: Num;
  height?: Num;
  loop?: boolean;
  playbackRate?: number;
}

export interface CanvasProps extends CommonProps {
  width: number;
  height: number;
  /** Called with the canvas's real 2D context after each render: Chrome draws it natively. */
  draw: (context: any) => void;
}

export interface GlslShaderProps extends CommonProps {
  width: number;
  height: number;
  fragment: string;
  vertex?: string;
  uniforms?: Record<string, number | boolean | readonly number[]>;
  textures?: Record<string, string | { src: string; filter?: 'linear' | 'nearest'; wrap?: 'clamp' | 'repeat' | 'mirror' }>;
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
  startFrom?: number;
  endAt?: number;
  playbackRate?: number;
  loop?: boolean;
  muted?: boolean;
}

export interface VideoProps extends CommonProps {
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
  /** Remotion's: `width`, `height` and `objectFit` are read; other keys are ignored. */
  style?: Record<string, unknown>;
  trimBefore?: number;
  trimAfter?: number;
  startFrom?: number;
  endAt?: number;
  playbackRate?: number;
  loop?: boolean;
  volume?: number | ((frame: number) => number);
  muted?: boolean;
  transparent?: boolean;
  toneMapped?: boolean;
  pauseWhenBuffering?: boolean;
  acceptableTimeShiftInSeconds?: number;
  onError?: (error: Error) => void;
  showInTimeline?: boolean;
  name?: string;
  delayRenderTimeoutInMilliseconds?: number;
}

export interface GifProps extends CommonProps {
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
  style?: Record<string, unknown>;
  playbackRate?: number;
  loopBehavior?: 'loop' | 'pause-after-finish' | 'unmount-after-finish';
  durationInSeconds?: number;
  onLoad?: (info: unknown) => void;
  onError?: (error: Error) => void;
}

export interface SequenceHostProps {
  sequence: unknown;
  wrapped: boolean;
  children?: ReactNode;
}
