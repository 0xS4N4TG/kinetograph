// `<AnimatedImage>`: Remotion's animated GIF, APNG and WebP on a `<canvas>`, decoded with the browser's `ImageDecoder`.
// An animated GIF, APNG or WebP is drawn by the native `gif` layer, at the picture Remotion's decoder hands the canvas
// at that time: of the picture that has started and the next, the one whose start is nearer (gif-timeline.ts). A file
// that is not animated is drawn as a still picture.

import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import type { CSSProperties, ReactNode } from 'react';
import { Gif } from '@kinetograph/react';
import { remoteMessage } from '@kinetograph/compat/shim';
import { EffectsBox, hasEffects, type EffectsOutputSize, type EffectsProp } from './effects.js';
import { Img, type FillStyle } from './fill.js';
import { imageSizeSync } from './media-utils.js';
import { isGif, nearestPicture, readApngTimeline, readGifTimeline, readWebpTimeline, type GifTimeline } from './gif-timeline.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';
import { useCurrentFrame, useVideoConfig } from './timeline.js';

export type AnimatedImageLoopBehavior = 'loop' | 'pause-after-finish' | 'clear-after-finish';

export interface AnimatedImageProps extends SequenceTimingProps, CropProps {
  src: string;
  /** The canvas's size in pixels: the picture's own by default. */
  width?: number;
  height?: number;
  /** How the picture sits in the canvas: stretched to it (the default), inside it, or covering it. */
  fit?: 'fill' | 'contain' | 'cover';
  /** What happens after the last picture: start again (the default), hold it, or draw nothing. */
  loopBehavior?: AnimatedImageLoopBehavior;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Called with a file that cannot be read, which would otherwise fail the render. */
  onError?: (error: Error) => void;
  /** Accepted: nothing is fetched. */
  requestInit?: unknown;
  effects?: EffectsProp;
  effectsOutputSize?: EffectsOutputSize | null;
}

type Source = { kind: 'gif'; timeline: GifTimeline } | { kind: 'still' };

const sources = new Map<string, Source>();

/** The first 64 KiB of the file: enough to tell what it is, and for a PNG or WebP whether it is animated. */
function readHead(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const head = new Uint8Array(65536);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

/** `png` for a PNG with an `acTL` chunk before its first `IDAT`, `webp` for a WebP whose `VP8X` sets the animation flag. */
function animatedFormat(head: Uint8Array): 'png' | 'webp' | null {
  if (ascii(head, 1, 3) === 'PNG') {
    for (let pos = 8; pos + 8 <= head.length; ) {
      const type = ascii(head, pos + 4, 4);
      if (type === 'acTL') return 'png';
      if (type === 'IDAT') return null;
      pos += 12 + new DataView(head.buffer, head.byteOffset + pos, 4).getUint32(0);
    }
    return null;
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return ascii(head, 12, 4) === 'VP8X' && (head[20]! & 0x02) !== 0 ? 'webp' : null;
  return null;
}

function readSource(src: string): Source {
  const known = sources.get(src);
  if (known) return known;
  if (/^(https?|wss?|ftp):\/\//i.test(src)) throw new TypeError(remoteMessage('<AnimatedImage src>', src));
  let source: Source;
  try {
    const head = readHead(src);
    if (isGif(head)) {
      source = { kind: 'gif', timeline: readGifTimeline(readFileSync(src)) };
    } else {
      const format = animatedFormat(head);
      if (format === 'png') {
        source = { kind: 'gif', timeline: readApngTimeline(readFileSync(src)) };
      } else if (format === 'webp') {
        source = { kind: 'gif', timeline: readWebpTimeline(readFileSync(src)) };
      } else {
        source = { kind: 'still' };
      }
    }
  } catch (error) {
    throw new Error(`Could not read <AnimatedImage src=${JSON.stringify(src)}>: ${error instanceof Error ? error.message : String(error)}`);
  }
  sources.set(src, source);
  return source;
}

/** Forgets the files read (for tests). */
export function clearAnimatedImages(): void {
  sources.clear();
}

/**
 * The start, in seconds, of the picture to show `seconds` in, or null for nothing. A looping image wraps round; the
 * others hold the last picture, or (`clear-after-finish`) show nothing once past the end.
 */
export function pictureStart(timeline: GifTimeline, seconds: number, loopBehavior: AnimatedImageLoopBehavior): number | null {
  const duration = timeline.durationUs / 1e6;
  let time = seconds;
  if (loopBehavior === 'loop') {
    time = seconds % duration;
  } else {
    if (loopBehavior === 'clear-after-finish' && seconds > duration) return null;
    time = Math.min(seconds, duration);
  }
  return timeline.startsUs[nearestPicture(timeline, time)]! / 1e6;
}

function AnimatedFrame({
  src,
  timeline,
  playbackRate,
  loopBehavior,
  width,
  height,
  fit,
  id,
  className,
  css,
}: {
  src: string;
  timeline: GifTimeline;
  playbackRate: number;
  loopBehavior: AnimatedImageLoopBehavior;
  width: number | undefined;
  height: number | undefined;
  fit: 'fill' | 'contain' | 'cover';
  id: string | undefined;
  className: string | undefined;
  css: CSSProperties | undefined;
}): ReactNode {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = pictureStart(timeline, (frame * playbackRate) / fps, loopBehavior);
  if (start === null) return null;
  const withCss = className !== undefined || css !== undefined;
  // The gif layer finds the picture that is showing at its time: half a millisecond in is inside the one that starts here.
  const picture = (
    <Gif
      id={withCss ? undefined : id}
      src={src}
      width={width ?? (withCss ? timeline.width : undefined)}
      height={height ?? (withCss ? timeline.height : undefined)}
      fit={fit}
      time={start + 0.0005}
      loopBehavior="pause-after-finish"
    />
  );
  if (!withCss) return picture;
  return (
    <div id={id} className={className} style={{ width: width ?? timeline.width, height: height ?? timeline.height, ...css }}>
      {picture}
    </div>
  );
}

export function AnimatedImage(props: AnimatedImageProps): ReactNode {
  const [timing, withoutTiming] = splitTiming(props);
  const [crop, { src, width, height, fit = 'fill', loopBehavior = 'loop', className, style, id, onError, effects, effectsOutputSize }] = splitCrop(withoutTiming);
  const { playbackRate = 1, loop, durationInFrames, ...otherTiming } = timing;

  let source: Source;
  try {
    source = readSource(src);
  } catch (error) {
    if (!onError) throw error;
    onError(error as Error);
    return null;
  }
  // A sequence that loops an animation with the duration of the file plays it again and again: loopBehavior `loop`.
  const wrapped = loop && durationInFrames === undefined;
  const css = croppedStyle('<AnimatedImage />', crop, style);
  const sequence = {
    ...otherTiming,
    ...(loop && !wrapped ? { loop } : {}),
    ...(durationInFrames === undefined ? {} : { durationInFrames: durationInFrames / playbackRate }),
  };

  if (hasEffects(effects)) {
    const natural = width === undefined || height === undefined ? (source.kind === 'gif' ? source.timeline : imageSizeSync(src)) : null;
    return (
      <Sequenced timing={sequence} component="<AnimatedImage>" defaultName="<AnimatedImage>">
        <EffectsBox
          component="<AnimatedImage>"
          effects={effects}
          effectsOutputSize={effectsOutputSize}
          width={width ?? natural!.width}
          height={height ?? natural!.height}
          pixelDensity={undefined}
          className={className}
          id={id}
          style={css}
          source={(size) =>
            source.kind === 'still' ? (
              <Img src={src} width={size.width} height={size.height} style={{ objectFit: fit }} />
            ) : (
              <AnimatedFrame
                src={src}
                timeline={source.timeline}
                playbackRate={playbackRate}
                loopBehavior={wrapped ? 'loop' : loopBehavior}
                width={size.width}
                height={size.height}
                fit={fit}
                id={undefined}
                className={undefined}
                css={undefined}
              />
            )
          }
        />
      </Sequenced>
    );
  }
  if (source.kind === 'still') {
    return (
      <Sequenced timing={sequence} component="<AnimatedImage>" defaultName="<AnimatedImage>">
        <Img id={id} className={className} src={src} width={width} height={height} style={{ objectFit: fit, ...(css as FillStyle) }} />
      </Sequenced>
    );
  }
  return (
    <Sequenced timing={sequence} component="<AnimatedImage>" defaultName="<AnimatedImage>">
      <AnimatedFrame
        src={src}
        timeline={source.timeline}
        playbackRate={playbackRate}
        loopBehavior={wrapped ? 'loop' : loopBehavior}
        width={width}
        height={height}
        fit={fit}
        id={id}
        className={className}
        css={css}
      />
    </Sequenced>
  );
}
