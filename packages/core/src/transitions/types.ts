// The shapes `@remotion/transitions` presentations and timings have, so that
// presentations written for Remotion (and its custom ones) work here.

import type { ComponentType, ReactNode } from 'react';

export type PresentationDirection = 'entering' | 'exiting';

export interface PresentationComponentProps<PassedProps extends Record<string, unknown>> {
  children: ReactNode;
  /** 0 to 1 (a spring may overshoot): how far the transition is. */
  presentationProgress: number;
  presentationDirection: PresentationDirection;
  presentationDurationInFrames: number;
  passedProps: PassedProps;
}

export interface TransitionPresentation<PassedProps extends Record<string, unknown>> {
  component: ComponentType<PresentationComponentProps<PassedProps>>;
  props: PassedProps;
}

export interface TransitionTiming {
  getDurationInFrames: (options: { fps: number }) => number;
  getProgress: (options: { frame: number; fps: number }) => number;
}
