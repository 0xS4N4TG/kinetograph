import type { ReactNode } from 'react';
import { createSceneRoot, TimelineContext, type RenderedTree, type TimelineState } from '../src/index.js';

/** A timeline at `frame` of a 30 fps, 90 frame, 1280x720 composition, with any field overridden. */
export function timeline(frame = 0, extra: Partial<TimelineState> = {}): TimelineState {
  return {
    frame,
    absoluteFrame: frame,
    durationInFrames: 90,
    config: {
      id: 'Main',
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 90,
      defaultProps: {},
      props: {},
    },
    frozen: false,
    ...extra,
  };
}

/** `node` inside a timeline at `state` (a frame number or a full state). */
export function at(node: ReactNode, state: number | TimelineState = 0): ReactNode {
  return <TimelineContext.Provider value={typeof state === 'number' ? timeline(state) : state}>{node}</TimelineContext.Provider>;
}

/** Renders `node` once, in a fresh root, and returns the tree. */
export function renderAt(node: ReactNode, state: number | TimelineState = 0): RenderedTree {
  const root = createSceneRoot();
  try {
    return root.render(at(node, state));
  } finally {
    root.unmount();
  }
}

/** The layers of a one-off render. */
export function layersOf(node: ReactNode, state: number | TimelineState = 0) {
  return renderAt(node, state).layers;
}
