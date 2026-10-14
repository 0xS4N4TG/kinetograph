import type { ReactNode } from 'react';
import { createSceneRoot, Rect, TimelineContext, type RenderedTree, type TimelineState } from '@kinetograph/react';
import type { LayerJson } from '@kinetograph/scene';
import { useCurrentFrame, useVideoConfig } from '../src/timeline.js';

/** A timeline at `frame` of a 30 fps, 90 frame, 1280x720 composition. */
export function timeline(frame = 0, extra: Partial<TimelineState> = {}): TimelineState {
  return {
    frame,
    absoluteFrame: frame,
    durationInFrames: 90,
    config: { id: 'Main', width: 1280, height: 720, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} },
    frozen: false,
    ...extra,
  };
}

export function renderAt(node: ReactNode, frame = 0, extra: Partial<TimelineState> = {}): RenderedTree {
  const root = createSceneRoot();
  try {
    return root.render(<TimelineContext.Provider value={timeline(frame, extra)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

export interface Seen {
  name: string;
  frame: number;
  duration: number;
}

/** A leaf that records the frame and duration it sees and draws a 1x1 rect named after itself. */
export function probe(name: string, seen: Seen[], withId = true) {
  return function Probe() {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    seen.push({ name, frame, duration: durationInFrames });
    return withId ? <Rect id={name} width={1} height={1} fill="#fff" /> : <Rect width={1} height={1} fill="#fff" />;
  };
}

/** The ids of every layer in the tree, depth first. */
export function ids(layers: LayerJson[]): string[] {
  return layers.flatMap((layer) => [layer.id, ...(layer.type === 'group' ? ids(layer.children) : [])]);
}
