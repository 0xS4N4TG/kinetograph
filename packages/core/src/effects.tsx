// Remotion's `effects` (`createEffect`, `<Solid>`, `<CanvasImage>`): a canvas component runs its picture through a
// chain of effects, each a function that draws the previous canvas onto the next with 2D, WebGL 2 or WebGPU. The 2D and
// WebGL 2 effects run on recording canvases (effect-chain.tsx); a WebGPU effect is not run and is reported.

import type { CSSProperties, ReactNode } from 'react';
import { enabledEffects, effectBoxStyle, scaledToBox, useEffectChain, type EffectSource, type PaintStage } from './effect-chain.js';
import { Img } from './fill.js';
import type { FillStyle } from './fill.js';
import type { InteractivitySchema } from './interactivity-schema.js';
import { imageSizeSync } from './media-utils.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';

export type Backend = '2d' | 'webgl2' | 'webgpu';

/** What an effect is handed to draw on or from: the parts of a `<canvas>` an effect uses. */
export interface EffectCanvas {
  width: number;
  height: number;
  getContext(contextId: string, options?: unknown): any;
}

export interface EffectApplyParams<P, S> {
  /** The picture to draw: `ctx.drawImage(source, ...)` on a 2D target, `gl.texImage2D(..., source)` on a WebGL one. */
  readonly source: EffectSource;
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
  /** May be `async`: the frame waits for the promise, and a rejection is reported for the frame. */
  readonly apply: (params: EffectApplyParams<P, S>) => void | Promise<void>;
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

/**
 * Whether `effects` holds an effect that is not disabled: the component then draws through the chain
 * (effect-chain.tsx), and without one it draws as it always did.
 */
export function hasEffects(effects: EffectsProp | undefined): boolean {
  return enabledEffects(effects).length > 0;
}

export interface EffectsBoxProps {
  component: string;
  effects: EffectsProp | undefined;
  effectsOutputSize: EffectsOutputSize | null | undefined;
  /** The box in CSS pixels, which the canvas's pixels (`pixelDensity`, `effectsOutputSize`) are shown in. */
  width: number;
  height: number;
  pixelDensity: number | undefined;
  /** `onInit` and `onPaint` of an `<HtmlInCanvas>`. */
  paint?: PaintStage;
  className?: string;
  id?: string;
  /** The element's CSS: with it (or a class) the box is a `div` laid out by the CSS engine, else the layers alone. */
  style?: CSSProperties;
  /** The unaffected picture, drawn `width` x `height` pixels at the origin: the pixels of the chain's canvases. */
  source: (size: { width: number; height: number }) => ReactNode;
}

/**
 * A canvas component's picture through its effect chain. The box is the `canvas` element of Remotion: a `div` of the
 * component's size that clips what it shows, which is the chain's last picture.
 */
export function EffectsBox({ component, effects, effectsOutputSize, width, height, pixelDensity, paint, className, id, style, source }: EffectsBoxProps): ReactNode {
  const chain = useEffectChain({ component, effects, effectsOutputSize, width, height, pixelDensity, paint });
  const layers = scaledToBox(chain, width, height, chain.render(source({ width: chain.width, height: chain.height })));
  if (className === undefined && style === undefined) return layers;
  return (
    <div id={id} className={className} style={effectBoxStyle(width, height, style)}>
      {layers}
    </div>
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
  /** The resolution of the canvas it is drawn on: the effects run on `ceil(width * pixelDensity)` pixels. */
  pixelDensity?: number;
}

/** A `width` x `height` rectangle of one colour, which Remotion draws on a `<canvas>` so that effects can run on it. */
export function Solid(props: SolidProps): ReactNode {
  const [timing, withoutTiming] = splitTiming(props);
  const [crop, { width, height, color, effects, effectsOutputSize, className, style, pixelDensity }] = splitCrop(withoutTiming);
  assertValidPixelDensity('<Solid>', pixelDensity);
  const css = croppedStyle('<Solid />', crop, style);
  if (hasEffects(effects)) {
    return (
      <Sequenced timing={timing} component="<Solid>" defaultName="<Solid>">
        <EffectsBox
          component="<Solid>"
          effects={effects}
          effectsOutputSize={effectsOutputSize}
          width={width}
          height={height}
          pixelDensity={pixelDensity}
          className={className}
          // A canvas is a box even when it has no CSS of its own.
          style={css ?? {}}
          source={(size) => <div style={{ width: size.width, height: size.height, ...(color === undefined ? {} : { backgroundColor: color }) }} />}
        />
      </Sequenced>
    );
  }
  const box = { width, height, ...(color === undefined ? {} : { backgroundColor: color }), ...css };
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
  const [crop, { src, width, height, fit = 'fill', effects, effectsOutputSize, className, style, id }] = splitCrop(withoutTiming);
  if (!src) throw new Error('No "src" prop was passed to <CanvasImage>.');
  // The canvas is `width` x `height` pixels and its picture is fitted to that; a missing size is the picture's own.
  const css = croppedStyle('<CanvasImage />', crop, style);
  if (hasEffects(effects)) {
    const natural = width === undefined || height === undefined ? imageSizeSync(src) : null;
    const canvasWidth = width ?? natural!.width;
    const canvasHeight = height ?? natural!.height;
    return (
      <Sequenced timing={timing} component="<CanvasImage>" defaultName="<CanvasImage>">
        <EffectsBox
          component="<CanvasImage>"
          effects={effects}
          effectsOutputSize={effectsOutputSize}
          width={canvasWidth}
          height={canvasHeight}
          pixelDensity={undefined}
          className={className}
          id={id}
          style={css}
          source={(size) => <Img src={src} width={size.width} height={size.height} style={{ objectFit: fit }} />}
        />
      </Sequenced>
    );
  }
  return (
    <Sequenced timing={timing} component="<CanvasImage>" defaultName="<CanvasImage>">
      <Img id={id} className={className} src={src} width={width} height={height} style={{ objectFit: fit, ...(css as FillStyle) }} />
    </Sequenced>
  );
}
