// The timeline context of the Chrome bundle (docs/COMPAT.md §6.2). In the bundle `@kinetograph/react` is aliased to
// this package, so the Remotion shim of `@kinetograph/core` (`useCurrentFrame`, `Sequence`, …) and the elements here
// read time from one context, as they do from `@kinetograph/react`'s in the Node bundle. The shapes are the ones of
// that package's `timeline.ts` (docs/AUTHORING.md §6.2); `@kinetograph/compat` cannot import it, since
// `@kinetograph/react` depends on this package.

import { createContext, useContext } from 'react';

export interface VideoConfig {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
  props: Record<string, unknown>;
}

export interface TimelineState {
  /** The frame as components see it: relative to the enclosing Sequences, fractional on motion-blur sub-frames. */
  frame: number;
  /** The frame of the composition being rendered. */
  absoluteFrame: number;
  /** Of the innermost Sequence, else of the composition. */
  durationInFrames: number;
  config: VideoConfig;
  /** Inside an active `<Freeze>`. */
  frozen: boolean;
  /** Key of the enclosing `<Sequence>`; unset or null outside one. */
  sequence?: string | null;
}

export const TimelineContext = createContext<TimelineState | null>(null);
TimelineContext.displayName = 'KinetographTimeline';

/** The timeline here. Throws outside a composition. */
export function useTimeline(): TimelineState {
  const timeline = useContext(TimelineContext);
  if (timeline === null) {
    throw new Error(
      'No timeline: this component is rendered outside a composition. ' +
        'Render it through a <Composition> (or a FrameRenderer), not on its own.',
    );
  }
  return timeline;
}
