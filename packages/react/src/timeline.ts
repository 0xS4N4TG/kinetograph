// The timeline every component reads time from (docs/AUTHORING.md §6.2).
// Owned by the orchestrator: the Remotion shim (`@kinetograph/core`), the
// native elements and the motion-blur sub-frames all agree on time through
// this one context, so only the orchestrator changes it.

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
  /** The frame as components here see it: relative to the enclosing
   *  Sequences, and fractional on motion-blur sub-frames. */
  frame: number;
  /** The frame of the composition being rendered (fractional on sub-frames). */
  absoluteFrame: number;
  /** Of the innermost Sequence, else of the composition. */
  durationInFrames: number;
  config: VideoConfig;
  /** Inside an active `<Freeze>`; `<Audio>` is silent there. */
  frozen: boolean;
  /** Key of the enclosing `<Sequence>` (docs/AUTHORING.md §11.4); unset or null outside one. */
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
