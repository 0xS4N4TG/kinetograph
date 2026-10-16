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
  CanvasContext2D,
  GlslTextureOptions,
  CharStyle,
  Clip,
  ColorString,
  Effect,
  Geometry3D,
  Layout,
  LayoutItem,
  Mask,
  Material3D,
  Matte,
  MotionBlurMarker,
  Num,
  Paint,
  SequenceJson,
  Shadow3DOptions,
  Stroke,
  Turbulence,
  Vec3,
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
  /**
   * @internal `<AbsoluteFill>`'s layer mapping says what the CSS box it stands for is, so that a tree holding DOM
   * elements draws it as that `div` (docs/ENGINE.md §10): the author's style, and whether the first child is the
   * background rectangle the layer mapping adds.
   */
  domFill?: { style: Record<string, unknown>; id?: string; background: boolean };
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

export interface CanvasProps extends CommonProps {
  /** The canvas's size in layer pixels, whole, not animated. */
  width: number;
  height: number;
  /**
   * Draws the canvas with a Canvas 2D context. It is called with a fresh, empty context each time the frame is read,
   * and everything it draws is the frame's canvas (docs/SCENE.md, "canvas"), so what it draws must come from the
   * props and the frame it closes over, not from what was drawn before.
   */
  draw: (context: CanvasContext2D) => void;
}

export interface GlslShaderProps extends CommonProps {
  /** The size of the shader's drawing buffer in layer pixels, whole, not animated. */
  width: number;
  height: number;
  /** The fragment shader, GLSL ES 100 or 300 es (docs/SCENE.md, "glsl"). */
  fragment: string;
  /** The vertex shader. Default: one that covers the box with the attribute `a_position`, in clip space. */
  vertex?: string;
  /** Values for its uniforms, by name; compute them from the frame (`useCurrentFrame`), not from a clock. */
  uniforms?: Record<string, number | boolean | readonly number[]>;
  /** Pictures for its `sampler2D` uniforms, by name. */
  textures?: Record<string, string | GlslTextureOptions>;
}

// ---- the 3D layer (docs/AUTHORING.md §6.6) ----

export interface Scene3DProps extends CommonProps {
  /** The layer's box in layer pixels; the camera's aspect ratio is its width over its height. */
  width: Num;
  height: Num;
  /** Samples per pixel, 1 or 4 (default 4). */
  msaa?: 1 | 4;
  /** `<Camera3D>`, lights and the objects. */
  children?: ReactNode;
}

export interface Camera3DProps {
  type?: 'perspective' | 'orthographic';
  fov?: Num;
  height?: Num;
  near?: Num;
  far?: Num;
  position?: Vec3;
  target?: Vec3;
  up?: [number, number, number];
}

export interface AmbientLightProps {
  color?: ColorString;
  intensity?: Num;
}
export interface DirectionalLightProps {
  /** The way the light travels. Default `[-1, -1, -1]`. */
  direction?: Vec3;
  color?: ColorString;
  intensity?: Num;
  /** Shade what the objects with `castShadow` block, on the ones with `receiveShadow`. At most 4 lights do. */
  castShadow?: boolean;
  shadow?: Shadow3DOptions;
}
export interface PointLightProps {
  position: Vec3;
  color?: ColorString;
  intensity?: Num;
  /** Above 0: the distance at which the light has faded to nothing. */
  range?: Num;
}

/** What every 3D object takes. */
export interface Object3DProps {
  id?: string;
  position?: Vec3;
  /** Degrees, XYZ Euler angles. */
  rotation?: Vec3;
  scale?: Num | Vec3;
  visible?: boolean;
}
/** What the objects that are drawn (not groups) take. */
export interface Drawn3DProps extends Object3DProps {
  /** Blocks the light of the directional lights that `castShadow`. */
  castShadow?: boolean;
  /** Is shaded by what blocks those lights. */
  receiveShadow?: boolean;
}
export interface MeshProps extends Drawn3DProps {
  geometry: Geometry3D;
  material?: Material3D;
}
export interface ModelProps extends Drawn3DProps {
  /** A `.gltf` or `.glb` file. */
  src: string;
  /** Replaces the file's own materials. */
  material?: Material3D;
}
export interface Text3DProps extends Drawn3DProps {
  /** The text: strings and numbers, as for `<Text>`. */
  children?: ReactNode;
  font: string;
  weight?: number | string;
  fontStyle?: 'normal' | 'italic';
  /** The em size in world units. */
  size?: number;
  /** Extrusion along z. */
  depth?: number;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  material?: Material3D;
}
export interface ExtrudeProps extends Drawn3DProps {
  /** SVG path data. */
  path: string;
  /** The longer side of the path's box in world units. */
  size?: number;
  depth?: number;
  fillRule?: 'nonzero' | 'evenodd';
  material?: Material3D;
}
export interface Group3DProps extends Object3DProps {
  children?: ReactNode;
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
  /** The pitch times this, 0.01 to 2 (Remotion's); the speed is unchanged. */
  toneFrequency?: number;
}

/** `toneFrequency` as a clip field: left out when it is 1 (or not given), so clips without it are as before. */
function toneOf(label: string, toneFrequency: number | undefined): { toneFrequency?: number } {
  if (toneFrequency === undefined || toneFrequency === 1) return {};
  if (!(typeof toneFrequency === 'number' && toneFrequency >= 0.01 && toneFrequency <= 2)) {
    throw new Error(`${label} toneFrequency must be between 0.01 and 2, got ${String(toneFrequency)}`);
  }
  return { toneFrequency };
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

// ---- the 3D layer ----

/** A 3D scene drawn natively into a box of `width` x `height` (docs/SCENE.md, "scene3d"). */
export function Scene3D(props: Scene3DProps) {
  return createElement('kg-scene3d', props);
}
export function Camera3D(props: Camera3DProps) {
  return createElement('kg-camera3d', props);
}
export function AmbientLight(props: AmbientLightProps) {
  return createElement('kg-ambient-light', props);
}
export function DirectionalLight(props: DirectionalLightProps) {
  return createElement('kg-directional-light', props);
}
export function PointLight(props: PointLightProps) {
  return createElement('kg-point-light', props);
}
export function Mesh(props: MeshProps) {
  return createElement('kg-mesh', props);
}
export function Model(props: ModelProps) {
  return createElement('kg-model', props);
}
export function Text3D(props: Text3DProps) {
  return createElement('kg-text3d', props);
}
export function Extrude(props: ExtrudeProps) {
  return createElement('kg-extrude', props);
}
export function Group3D(props: Group3DProps) {
  return createElement('kg-group3d', props);
}

// ---- <Canvas> ----

/** A canvas drawn with `draw(context)`: a Canvas 2D context's commands, drawn natively (docs/SCENE.md, "canvas"). */
export function Canvas(props: CanvasProps) {
  return createElement('kg-canvas', props);
}

// ---- <GlslShader> ----

/** A full-screen GLSL fragment shader, run natively on the GPU (docs/SCENE.md, "glsl"). */
export function GlslShader(props: GlslShaderProps) {
  return createElement('kg-glsl', props);
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
    ...toneOf(`<Audio src="${props.src}">`, props.toneFrequency),
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
  /** The pitch of the video's sound times this, 0.01 to 2 (Remotion's); the speed is unchanged. */
  toneFrequency?: number;
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

/** `10` and `'10px'` are 10; anything else (a percentage, `auto`) is null. */
function px(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * The box and fit of a `<Video>` or `<Gif>`, read as `Img` reads them: `style.width`, `style.height` and
 * `style.objectFit` win over the props, `scale-down` is `contain`, other style keys are ignored.
 */
function boxOf(props: {
  width?: Num;
  height?: Num;
  fit?: 'fill' | 'contain' | 'cover';
  style?: Record<string, unknown>;
}): { width?: Num; height?: Num; fit?: 'fill' | 'contain' | 'cover' } {
  const style = props.style ?? {};
  const box: { width?: Num; height?: Num; fit?: 'fill' | 'contain' | 'cover' } = {};
  const width = px(style.width) ?? props.width;
  const height = px(style.height) ?? props.height;
  if (width !== undefined) box.width = width;
  if (height !== undefined) box.height = height;
  const objectFit = style.objectFit;
  if (objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover') box.fit = objectFit;
  else if (objectFit === 'scale-down') box.fit = 'contain';
  else if (props.fit !== undefined) box.fit = props.fit;
  return box;
}

export function Video(props: VideoProps): ReactNode {
  const timeline = useTimeline();
  const { src, playbackRate } = props;
  const label = `<Video src=${JSON.stringify(src)}>`;
  if (typeof src !== 'string' || src === '') throw new Error(`<Video> needs a src, got ${JSON.stringify(src)}`);
  if (playbackRate !== undefined && !(playbackRate > 0 && Number.isFinite(playbackRate))) {
    throw new Error(`${label} playbackRate must be above 0, got ${String(playbackRate)}`);
  }
  const trimBefore = props.trimBefore ?? props.startFrom;
  const trimAfter = props.trimAfter ?? props.endAt;
  if (trimBefore !== undefined && !(trimBefore >= 0)) {
    throw new Error(`${label} trimBefore must not be negative, got ${String(trimBefore)}`);
  }
  if (trimAfter !== undefined && !(trimAfter > (trimBefore ?? 0))) {
    throw new Error(`${label} trimAfter (${String(trimAfter)}) must be greater than trimBefore (${trimBefore ?? 0})`);
  }
  const volumeProp = props.volume ?? 1;
  // Remotion hands a volume callback the frame within the video's own Sequence.
  const volume = typeof volumeProp === 'function' ? volumeProp(timeline.frame) : volumeProp;
  if (typeof volume !== 'number' || !Number.isFinite(volume)) {
    throw new Error(`${label} volume must be a finite number, got ${String(volume)}`);
  }
  // As <Audio>: the absolute frame at which the clip's own frame 0 falls.
  const from = snapToFrame(timeline.absoluteFrame - timeline.frame);
  const sound: Omit<AudioClipJson, 'id'> = {
    src,
    from,
    trimBefore: trimBefore ?? 0,
    trimAfter: trimAfter ?? null,
    playbackRate: playbackRate ?? 1,
    volume,
    loop: props.loop ?? false,
    muted: (props.muted ?? false) || timeline.frozen,
    video: true,
    ...toneOf(label, props.toneFrequency),
  };
  // `emit` reads the common props and the layer's fields from here; `volume`, `muted` and the ignored props stay behind.
  return createElement('kg-video', {
    ...props,
    ...boxOf(props),
    from,
    trimBefore,
    trimAfter,
    // Inside a <Freeze> the clock reads the composition's frame; `from` is shifted so that frame is the frozen one.
    frame: timeline.frozen ? timeline.absoluteFrame : undefined,
    sound,
  });
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
  /**
   * The GIF's duration, which `loopBehavior="unmount-after-finish"` needs. Set by `Gif` from `@kinetograph/core/gif`,
   * which probes the file (this package cannot).
   */
  durationInSeconds?: number;
  /** Accepted and ignored. */
  onLoad?: (info: unknown) => void;
  onError?: (error: Error) => void;
}

export function Gif(props: GifProps): ReactNode {
  const { frame, config } = useTimeline();
  const { src, playbackRate = 1, loopBehavior = 'loop' } = props;
  const label = `<Gif src=${JSON.stringify(src)}>`;
  if (typeof src !== 'string' || src === '') throw new Error(`<Gif> needs a src, got ${JSON.stringify(src)}`);
  if (!(playbackRate > 0 && Number.isFinite(playbackRate))) {
    throw new Error(`${label} playbackRate must be above 0, got ${String(playbackRate)}`);
  }
  if (loopBehavior !== 'loop' && loopBehavior !== 'pause-after-finish' && loopBehavior !== 'unmount-after-finish') {
    throw new Error(
      `${label} loopBehavior must be loop, pause-after-finish or unmount-after-finish, got ${JSON.stringify(loopBehavior)}`,
    );
  }
  // Remotion's <Gif> reads useCurrentFrame(), so the time is relative to the enclosing Sequence.
  const time = (frame / config.fps) * playbackRate;
  if (loopBehavior === 'unmount-after-finish') {
    if (props.durationInSeconds === undefined) {
      throw new Error(
        `${label} with loopBehavior="unmount-after-finish" needs the GIF's duration, which this package cannot read: import Gif from @kinetograph/core/gif (or @remotion/gif), which probes the file`,
      );
    }
    if (time >= props.durationInSeconds) return null;
  }
  return createElement('kg-gif', { ...props, ...boxOf(props), time, loop: loopBehavior === 'loop' });
}
