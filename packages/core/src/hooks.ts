// The hooks that read the Studio's and the Player's state: the preview scale, the pixel density, the buffering
// gate. Kinetograph has no player (every frame is a render), so each answers what Remotion answers while rendering.

export interface OutsideRemotionOptions {
  /** Remotion's switch for a call outside a composition; there is no such place here, so it changes nothing. */
  dontThrowIfOutsideOfRemotion?: boolean;
}

/**
 * The scale the preview shows the composition at. A render draws it at 1; there is no render `scale` option, and the
 * studio preview comes from the same render path.
 */
export function useCurrentScale(_options?: OutsideRemotionOptions): number {
  return 1;
}

/** The pixel density: the window's `devicePixelRatio` (1 here, as in `matchMedia`) in a preview, the render `scale` in a render. */
export function usePixelDensity(_options?: OutsideRemotionOptions): number {
  return 1;
}

export interface DelayPlaybackHandle {
  unblock: () => void;
}

export interface UseBufferState {
  delayPlayback: () => DelayPlaybackHandle;
}

const bufferState: UseBufferState = { delayPlayback: () => ({ unblock: () => undefined }) };

/**
 * Remotion's gate for a media component that is buffering. Nothing plays here, so there is nothing to hold; a
 * component that needs to wait for data holds the frame with `delayRender()`.
 */
export function useBufferState(): UseBufferState {
  return bufferState;
}
