// `@remotion/gif` (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §11.3): the native <Gif> element and
// `getGifDurationInSeconds`, which reads the sum of the pictures' delays from the file's header (`probeMedia`).

import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Gif as NativeGif, type GifProps as NativeGifProps } from '@kinetographdev/react';
import { EffectsBox, hasEffects, splitEffects, withCommonProps, type EffectsOutputSize, type MixedEffects } from './effects.js';
import { probeMedia } from './media-utils.js';

/**
 * `<Gif>`'s props: the native element's, with `effects` that may be Remotion's (run in a chain over the picture, on a
 * canvas of the GIF's size or `effectsOutputSize`) as well as the engine's own, and `effectsOutputSize`.
 */
export type GifProps = Omit<NativeGifProps, 'effects'> & {
  effects?: MixedEffects;
  effectsOutputSize?: EffectsOutputSize | null;
};

/** `10` and `'10px'` are 10; anything else is null. */
function pixels(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = typeof value === 'string' ? /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value) : null;
  return match === null ? null : Number(match[1]);
}

function gifDuration(src: string): number {
  const info = probeMedia(src, { cache: true });
  if (info.kind !== 'gif') throw new Error(`${src} is not a GIF (the file reads as a ${info.kind})`);
  return info.durationInSeconds;
}

/** How long one run of the GIF at `src` lasts, in seconds: the sum of its pictures' delays. */
export async function getGifDurationInSeconds(src: string): Promise<number> {
  return gifDuration(src);
}

/**
 * Remotion's way to load a GIF before it is used. The file is read from disk, so there is nothing to wait for: it is
 * probed now, which checks that it is a GIF and keeps the answer for `Gif`, and `waitUntilDone()` resolves, or rejects
 * with what is wrong with the file. `free()` does nothing.
 */
export function preloadGif(src: string, _options?: { requestInit?: unknown }): { waitUntilDone: () => Promise<void>; free: () => void } {
  let failure: unknown = null;
  try {
    gifDuration(src);
  } catch (error) {
    failure = error;
  }
  return { waitUntilDone: () => (failure === null ? Promise.resolve() : Promise.reject(failure)), free: () => undefined };
}

/**
 * An animated GIF. As `@remotion/gif`'s: `playbackRate` (default 1) and `loopBehavior` (`loop`, the default,
 * `pause-after-finish` or `unmount-after-finish`). The native element needs the duration for the last of those, so
 * this reads it from the file, and only then.
 */
export function Gif(props: GifProps): ReactNode {
  const { effects, effectsOutputSize, ...native } = props;
  const { chain, native: ownEffects } = splitEffects(effects);
  if (hasEffects(chain)) return GifWithEffects(native, chain, ownEffects, effectsOutputSize);
  return plainGif({ ...native, ...(ownEffects === undefined ? {} : { effects: ownEffects }) });
}

/** A GIF run through Remotion's effects: the canvas is the GIF's own size (or `width` and `height`), and the picture is drawn at the chain's. */
function GifWithEffects(props: Omit<GifProps, 'effects' | 'effectsOutputSize'>, chain: ReturnType<typeof splitEffects>['chain'], ownEffects: ReturnType<typeof splitEffects>['native'], effectsOutputSize: EffectsOutputSize | null | undefined): ReactNode {
  const { style, onLoad, onError } = props;
  const css: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style ?? {})) if (!['width', 'height', 'objectFit'].includes(key)) css[key] = value;
  const natural = pixels(style?.width ?? props.width) === null || pixels(style?.height ?? props.height) === null ? probeMedia(props.src, { cache: true }) : null;
  const width = pixels(style?.width ?? props.width) ?? natural!.width;
  const height = pixels(style?.height ?? props.height) ?? natural!.height;
  const objectFit = style?.objectFit;
  const fit = objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover' ? objectFit : props.fit;
  return withCommonProps(
    props as Record<string, unknown>,
    ownEffects,
    { width: effectsOutputSize?.width ?? width, height: effectsOutputSize?.height ?? height },
    createElement(EffectsBox, {
      component: '<Gif>',
      effects: chain,
      effectsOutputSize,
      width,
      height,
      pixelDensity: undefined,
      style: Object.keys(css).length > 0 ? (css as never) : undefined,
      source: (size) => plainGif({ src: props.src, playbackRate: props.playbackRate, loopBehavior: props.loopBehavior, time: props.time, durationInSeconds: props.durationInSeconds, onLoad, onError, fit, width: size.width, height: size.height }),
    }),
  );
}

function plainGif(props: NativeGifProps): ReactNode {
  if (props.loopBehavior === 'unmount-after-finish' && props.durationInSeconds === undefined) {
    return createElement(NativeGif, { ...props, durationInSeconds: gifDuration(props.src) });
  }
  return createElement(NativeGif, props);
}
