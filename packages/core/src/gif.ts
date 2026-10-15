// `@remotion/gif` (docs/AUTHORING.md §11.3): the native <Gif> element and
// `getGifDurationInSeconds`, which reads the sum of the pictures' delays from the file's header (`probeMedia`).

import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Gif as NativeGif, type GifProps } from '@kinetograph/react';
import { probeMedia } from './media-utils.js';

export type { GifProps } from '@kinetograph/react';

function probeGif(src: string) {
  const info = probeMedia(src);
  if (info.kind !== 'gif') throw new Error(`${src} is not a GIF (the file reads as a ${info.kind})`);
  return info;
}

/** How long one run of the GIF at `src` lasts, in seconds: the sum of its pictures' delays. */
export async function getGifDurationInSeconds(src: string): Promise<number> {
  return probeGif(src).durationInSeconds;
}

/**
 * An animated GIF. As `@remotion/gif`'s: `playbackRate` (default 1) and `loopBehavior` (`loop`, the default,
 * `pause-after-finish` or `unmount-after-finish`). The native element needs the duration for the last of those, so
 * this reads it from the file, and only then.
 */
export function Gif(props: GifProps): ReactNode {
  if (props.loopBehavior === 'unmount-after-finish' && props.durationInSeconds === undefined) {
    return createElement(NativeGif, { ...props, durationInSeconds: probeGif(props.src).durationInSeconds });
  }
  return createElement(NativeGif, props);
}
