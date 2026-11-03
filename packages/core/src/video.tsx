// `<Video>` of `@remotion/media` with its `effects`: the engine's native `<Video>` (packages/react) plus Remotion's chain.
// Remotion draws each frame on a canvas of the video's own size (or `effectsOutputSize`), runs the effects over it, and
// shows the canvas like a video: in the box `style` gives it, with `objectFit` (`contain` by default). Here the video is
// drawn as a layer of the chain's size, the effects run over it (effect-chain.tsx), and the chain's picture is fitted to
// the box. The sound is the video's, untouched.

import type { CSSProperties, ReactNode } from 'react';
import { Video as NativeVideo, type VideoProps as NativeVideoProps } from '@kinetographdev/react';
import { resolveRemoteAsset } from '@kinetographdev/compat/dom';
import { effectBoxStyle, useEffectChain, type EffectChain } from './effect-chain.js';
import { hasEffects, splitEffects, withCommonProps, withoutCommonProps, type EffectsOutputSize, type EffectsProp, type MixedEffects, type NativeEffects } from './effects.js';
import { probeMedia } from './media-utils.js';

/** `<Video>`'s props: the native element's, with `effects` that may be Remotion's as well as the engine's own, and `effectsOutputSize`. */
export type VideoProps = Omit<NativeVideoProps, 'effects'> & {
  effects?: MixedEffects;
  effectsOutputSize?: EffectsOutputSize | null;
};

function pixels(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = typeof value === 'string' ? /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value) : null;
  return match === null ? null : Number(match[1]);
}

/** The chain's picture in a `width` x `height` box, as a canvas element is with `object-fit`: nothing when it already is that size. */
function fittedToBox(chain: EffectChain, width: number, height: number, fit: 'fill' | 'contain' | 'cover', layers: ReactNode): ReactNode {
  const sx = width / chain.width;
  const sy = height / chain.height;
  const scaleX = fit === 'fill' ? sx : fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const scaleY = fit === 'fill' ? sy : scaleX;
  if (scaleX === 1 && scaleY === 1) return layers;
  const dx = (width - chain.width * scaleX) / 2;
  const dy = (height - chain.height * scaleY) / 2;
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <div style={{ position: 'relative', width: chain.width, height: chain.height, transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, transformOrigin: '0 0' }}>{layers}</div>
    </div>
  );
}

interface WithEffectsProps {
  props: Omit<VideoProps, 'effects'>;
  chainEffects: EffectsProp;
  ownEffects: NativeEffects | undefined;
}

function VideoWithEffects({ props, chainEffects, ownEffects }: WithEffectsProps): ReactNode {
  const { effectsOutputSize, style, className, width: widthProp, height: heightProp, fit: fitProp, ...rest } = withoutCommonProps(props) as Omit<VideoProps, 'effects'>;
  const info = probeMedia(resolveRemoteAsset(props.src) ?? props.src, { cache: true });
  const css: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props.style ?? {})) if (!['width', 'height', 'objectFit'].includes(key)) css[key] = value;
  // The box: the size the video is given, else its own; one side given keeps the video's aspect ratio.
  let boxWidth = pixels(style?.width ?? widthProp);
  let boxHeight = pixels(style?.height ?? heightProp);
  if (boxWidth === null && boxHeight === null) [boxWidth, boxHeight] = [info.width, info.height];
  else if (boxWidth === null) boxWidth = (boxHeight! * info.width) / info.height;
  else if (boxHeight === null) boxHeight = (boxWidth * info.height) / info.width;
  const objectFit = style?.objectFit;
  const fit: 'fill' | 'contain' | 'cover' = objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover' ? objectFit : objectFit === 'scale-down' ? 'contain' : (fitProp ?? 'contain');
  const chain = useEffectChain({ component: '<Video>', effects: chainEffects, effectsOutputSize, width: info.width, height: info.height, pixelDensity: 1 });
  const layers = fittedToBox(chain, boxWidth!, boxHeight!, fit, chain.render(<NativeVideo {...rest} width={chain.width} height={chain.height} fit="fill" />));
  const hasBox = className !== undefined || Object.keys(css).length > 0;
  return withCommonProps(
    props as Record<string, unknown>,
    ownEffects,
    { width: boxWidth!, height: boxHeight! },
    hasBox ? (
      <div className={className} style={effectBoxStyle(boxWidth!, boxHeight!, css as CSSProperties)}>
        {layers}
      </div>
    ) : (
      layers
    ),
  );
}

/**
 * The engine's `<Video>`, which also takes Remotion's `effects` and `effectsOutputSize` (those of `@remotion/media`'s
 * `<Video>`). Without an effect that is not disabled it is the native element.
 */
export function Video(props: VideoProps): ReactNode {
  const { effects, ...rest } = props;
  const { chain, native } = splitEffects(effects);
  if (!hasEffects(chain)) {
    const { effectsOutputSize: _unused, ...plain } = rest;
    return <NativeVideo {...plain} {...(native === undefined ? {} : { effects: native })} />;
  }
  return <VideoWithEffects props={rest} chainEffects={chain} ownEffects={native} />;
}
