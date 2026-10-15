// The native elements (docs/AUTHORING.md §6.3). Most are thin: they render a
// `kg-*` host element carrying their props, and the reconciler's `emit` turns
// the host tree into scene JSON. The ones that need time (`<Lottie>`,
// `<Audio>`) read it from the timeline here, so the host tree stays free of
// anything but plain data.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import type {
  AudioClipJson,
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
  SequenceJson,
  Stroke,
  Turbulence,
} from '@kinetograph/scene';
import { useTimeline } from './timeline.js';

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
export function Camera(props: CameraProps) {
  return createElement('kg-camera', props);
}

// ---- the host element of <Sequence> (docs/AUTHORING.md §11.4) ----

export interface SequenceHostProps {
  /** What the timeline records; `layer` is filled in by `emit`. */
  sequence: Omit<SequenceJson, 'layer'>;
  /** The children are in a `<Layer>` (false for `layout="none"`): its id becomes `layer`. */
  wrapped: boolean;
  /** The Sequence's content while it is showing; nothing while it is not. */
  children?: ReactNode;
}

/**
 * `<Sequence>` renders this whether or not it is showing, so the timeline sees every Sequence. It emits no layer
 * of its own: what is inside it stands where it does (automatic ids are unchanged).
 */
export function SequenceHost(props: SequenceHostProps) {
  return createElement('kg-sequence', props);
}

// ---- <Lottie> ----

/** Where animation data is written for the renderer to read (the scene's `src` is a file). */
function lottieCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'lottie');
}

/** Hashing a large animation on every frame would be most of a frame's cost, so a data object is hashed once. */
const writtenData = new WeakMap<object, string>();

/**
 * Writes `animationData` to `<cache>/<sha256 of its JSON>.json` unless that file exists, and returns the path. The
 * name is the content hash, so the same animation is one file however often it is rendered and concurrent writers
 * agree; the write goes through a temporary name so a reader never sees half a file.
 */
function cacheAnimationData(data: unknown): string {
  const known = typeof data === 'object' && data !== null ? writtenData.get(data) : undefined;
  if (known !== undefined && existsSync(known)) return known;
  const json = JSON.stringify(data);
  const path = join(lottieCacheDir(), `${createHash('sha256').update(json).digest('hex')}.json`);
  if (!existsSync(path)) {
    mkdirSync(lottieCacheDir(), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, path);
  }
  if (typeof data === 'object' && data !== null) writtenData.set(data, path);
  return path;
}

export function Lottie(props: LottieProps) {
  const { frame, config } = useTimeline();
  const { animationData, playbackRate = 1, ...rest } = props;
  if (animationData !== undefined && props.src !== undefined) {
    throw new Error('<Lottie> takes either src or animationData, not both');
  }
  if (animationData === undefined && props.src === undefined) {
    throw new Error('<Lottie> needs src or animationData');
  }
  const src = animationData !== undefined ? cacheAnimationData(animationData) : props.src;
  return createElement('kg-lottie', { ...rest, src, time: (frame / config.fps) * playbackRate });
}

// ---- <Audio> ----

/** `absoluteFrame - frame` is the clip's start, which is a whole frame; on a fractional motion-blur sub-frame the two
 *  numbers carry rounding noise, so a start within a hair of a whole frame is that frame. */
function snapToFrame(value: number): number {
  const whole = Math.round(value);
  return Math.abs(value - whole) < 1e-6 ? whole : value;
}

export function Audio(props: AudioProps) {
  const timeline = useTimeline();
  const volumeProp = props.volume ?? 1;
  // Remotion hands a volume callback the frame within the audio's own Sequence.
  const volume = typeof volumeProp === 'function' ? volumeProp(timeline.frame) : volumeProp;
  if (typeof volume !== 'number' || !Number.isFinite(volume)) {
    throw new Error(`<Audio src="${props.src}"> volume must be a finite number, got ${String(volume)}`);
  }
  const clip: Omit<AudioClipJson, 'id'> = {
    src: props.src,
    from: snapToFrame(timeline.absoluteFrame - timeline.frame),
    trimBefore: props.trimBefore ?? props.startFrom ?? 0,
    trimAfter: props.trimAfter ?? props.endAt ?? null,
    playbackRate: props.playbackRate ?? 1,
    volume,
    loop: props.loop ?? false,
    muted: (props.muted ?? false) || timeline.frozen,
  };
  return createElement('kg-audio', { id: props.id, clip });
}

// ---- <Video>, <OffthreadVideo>, <Gif> (docs/AUTHORING.md §11.3, stream 2) ----

export interface VideoProps extends CommonProps {
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
  /** Remotion's: `width`, `height` and `objectFit` are read; other keys are ignored. */
  style?: Record<string, unknown>;
  trimBefore?: number;
  trimAfter?: number;
  /** Older names of `trimBefore` and `trimAfter`. */
  startFrom?: number;
  endAt?: number;
  playbackRate?: number;
  loop?: boolean;
  /** A number, or a function of the frame within the video's Sequence. */
  volume?: number | ((frame: number) => number);
  muted?: boolean;
  /** Accepted and ignored. */
  transparent?: boolean;
  toneMapped?: boolean;
  pauseWhenBuffering?: boolean;
  acceptableTimeShiftInSeconds?: number;
  onError?: (error: Error) => void;
  showInTimeline?: boolean;
  name?: string;
  delayRenderTimeoutInMilliseconds?: number;
}

export function Video(_props: VideoProps): ReactNode {
  throw new Error('not implemented: <Video> (docs/AUTHORING.md §11.3)');
}

/** The same element as `<Video>`: every frame is decoded off the main thread anyway. */
export const OffthreadVideo = Video;

export interface GifProps extends CommonProps {
  src: string;
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
  style?: Record<string, unknown>;
  /** Default 1. */
  playbackRate?: number;
  /** Default `loop`. */
  loopBehavior?: 'loop' | 'pause-after-finish' | 'unmount-after-finish';
  /** Accepted and ignored. */
  onLoad?: (info: unknown) => void;
  onError?: (error: Error) => void;
}

export function Gif(_props: GifProps): ReactNode {
  throw new Error('not implemented: <Gif> (docs/AUTHORING.md §11.3)');
}
