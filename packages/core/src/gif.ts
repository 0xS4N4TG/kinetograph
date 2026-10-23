// `@remotion/gif` (packages/cli/skills/kinetograph/references/AUTHORING.md §11.3): the native <Gif> element and
// `getGifDurationInSeconds`, which reads the sum of the pictures' delays from the file's header (`probeMedia`).

import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Gif as NativeGif, type GifProps } from '@kinetograph/react';
import { probeMedia } from './media-utils.js';

export type { GifProps } from '@kinetograph/react';

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
  if (props.loopBehavior === 'unmount-after-finish' && props.durationInSeconds === undefined) {
    return createElement(NativeGif, { ...props, durationInSeconds: gifDuration(props.src) });
  }
  return createElement(NativeGif, props);
}
