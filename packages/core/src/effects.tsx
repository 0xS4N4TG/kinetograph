// Remotion's `effects` (`createEffect`, `<Solid>`, `<CanvasImage>`): a canvas component runs its picture through a
// chain of effects, each a function that draws the previous canvas onto the next with 2D, WebGL 2 or WebGPU. An effect
// is a function of a browser canvas, so one is defined and composed here (`createEffect` is data) but not run:
// a component with an enabled effect draws its picture without it and says so once.

import type { CSSProperties, ReactNode } from 'react';
import { Img } from './fill.js';
import type { FillStyle } from './fill.js';
import type { InteractivitySchema } from './interactivity-schema.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';
import { warnOnce } from './warn.js';

export type Backend = '2d' | 'webgl2' | 'webgpu';

/** What an effect is handed to draw on or from: the parts of a `<canvas>` an effect uses. */
export interface EffectCanvas {
  width: number;
  height: number;
  getContext(contextId: string, options?: unknown): any;
}

export interface EffectApplyParams<P, S> {
  readonly source: EffectCanvas;
  readonly target: EffectCanvas;
  readonly state: S;
  readonly params: P;
  readonly width: number;
  readonly height: number;
  readonly gpuDevice: unknown | null;
  readonly flipSourceY: boolean;
}

export interface EffectDefinition<P, S = unknown> {
  readonly type: string;
  readonly label: string;
  readonly documentationLink: string | null;
  readonly backend: Backend;
  /** Two descriptors of one definition with the same key are the same effect. */
  readonly calculateKey: (params: P) => string;
  readonly setup: (target: EffectCanvas) => S;
  readonly apply: (params: EffectApplyParams<P, S>) => void;
  readonly cleanup: (state: S) => void;
  readonly schema: InteractivitySchema;
  /** Throws when mandatory params are missing or invalid. `createEffect`'s factory calls it first. */
  readonly validateParams: (params: P) => void;
}

export interface EffectDescriptor<P = unknown> {
  readonly definition: EffectDefinition<P, unknown>;
  readonly effectKey: string;
  readonly params: P;
  readonly memoized: false;
}

export type EffectsProp = ReadonlyArray<EffectDescriptor<unknown>>;

export interface EffectsOutputSize {
  readonly width: number;
  readonly height: number;
}

export type EffectFactory<P> = {} extends P
  ? (params?: P & { readonly disabled?: boolean }) => EffectDescriptor<unknown>
  : (params: P & { readonly disabled?: boolean }) => EffectDescriptor<unknown>;

/** Every effect has this field: the Studio's eye toggle. */
export const disabledEffectField = { type: 'boolean', default: false, description: 'Disabled' } as const;

/**
 * Defines an effect and returns its factory, `blur({ radius: 4 })`, which validates the params and returns a
 * descriptor to put in a component's `effects`. `disabled` is part of the descriptor's key, as in Remotion.
 */
export function createEffect<P, S>(definition: EffectDefinition<P, S>): EffectFactory<P> {
  const widened = {
    ...definition,
    documentationLink: definition.documentationLink ?? null,
    calculateKey: (params: P) => `${definition.calculateKey(params)}-disabled-${(params as { disabled?: boolean }).disabled ?? false}`,
    schema: { disabled: disabledEffectField, ...definition.schema },
  } as unknown as EffectDefinition<unknown, unknown>;
  const factory = (params: P = {} as P): EffectDescriptor<unknown> => {
    definition.validateParams(params);
    return { definition: widened, params, effectKey: widened.calculateKey(params), memoized: false };
  };
  return factory as unknown as EffectFactory<P>;
}

/** Says once, for `component`, that the enabled effects of `effects` are not run. */
export function warnEffects(component: string, effects: EffectsProp | undefined): void {
  const enabled = (effects ?? []).filter((effect) => !(effect.params as { disabled?: boolean } | undefined)?.disabled);
  if (enabled.length === 0) return;
  warnOnce(
    `${component}.effects`,
    `${component} draws without its effects (${enabled.map((effect) => effect.definition.label).join(', ')}): an effect draws on a browser canvas, which Kinetograph does not have.`,
  );
}

// ---- <Solid> ----

/** Throws unless `pixelDensity` is left out or a positive, finite number. It sizes a canvas's pixels, which a render has none of. */
export function assertValidPixelDensity(component: string, pixelDensity: number | undefined): void {
  if (pixelDensity === undefined) return;
  if (typeof pixelDensity !== 'number' || !Number.isFinite(pixelDensity) || pixelDensity <= 0) {
    throw new Error(`${component}: \`pixelDensity\` must be a positive finite number. Received: ${String(pixelDensity)}.`);
  }
}

export interface SolidProps extends SequenceTimingProps, CropProps {
  width: number;
  height: number;
  /** Any CSS colour; transparent when left out. */
  color?: string;
  effects?: EffectsProp;
  effectsOutputSize?: EffectsOutputSize | null;
  className?: string;
  style?: CSSProperties;
  /** The resolution of the canvas it is drawn on; this changes nothing in a render. */
  pixelDensity?: number;
}

/** A `width` x `height` rectangle of one colour, which Remotion draws on a `<canvas>` so that effects can run on it. */
export function Solid(props: SolidProps): ReactNode {
  const [timing, withoutTiming] = splitTiming(props);
  const [crop, { width, height, color, effects, className, style, pixelDensity }] = splitCrop(withoutTiming);
  assertValidPixelDensity('<Solid>', pixelDensity);
  warnEffects('<Solid>', effects);
  const box = { width, height, ...(color === undefined ? {} : { backgroundColor: color }), ...croppedStyle('<Solid />', crop, style) };
  return (
    <Sequenced timing={timing} component="<Solid>" defaultName="<Solid>">
      <div className={className} style={box} />
    </Sequenced>
  );
}

// ---- <CanvasImage> ----

export interface CanvasImageProps extends SequenceTimingProps, CropProps {
  src: string;
  width?: number;
  height?: number;
  /** How the picture sits in the canvas: stretched to it (the default), inside it, or covering it. */
  fit?: 'fill' | 'contain' | 'cover';
  effects?: EffectsProp;
  effectsOutputSize?: EffectsOutputSize | null;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Accepted: there is no loading that can fail apart from the file being missing, which is an error. */
  onError?: (error: Error) => void;
  crossOrigin?: 'anonymous' | 'use-credentials' | '';
  pauseWhenLoading?: boolean;
  maxRetries?: number;
  delayRenderRetries?: number;
  delayRenderTimeoutInMilliseconds?: number;
}

/** A still picture on a `<canvas>` of `width` x `height` (the picture's own size by default), so that effects can run on it. */
export function CanvasImage(props: CanvasImageProps): ReactNode {
  const [timing, withoutTiming] = splitTiming(props);
  const [crop, { src, width, height, fit = 'fill', effects, className, style, id }] = splitCrop(withoutTiming);
  if (!src) throw new Error('No "src" prop was passed to <CanvasImage>.');
  warnEffects('<CanvasImage>', effects);
  // The canvas is `width` x `height` pixels and its picture is fitted to that; a missing size is the picture's own.
  const css = croppedStyle('<CanvasImage />', crop, style);
  return (
    <Sequenced timing={timing} component="<CanvasImage>" defaultName="<CanvasImage>">
      <Img id={id} className={className} src={src} width={width} height={height} style={{ objectFit: fit, ...(css as FillStyle) }} />
    </Sequenced>
  );
}
