// `@remotion/transitions/slide`: the new scene slides in over the old one, which
// is pushed out the other way. Offsets are fractions of the composition's size.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import { useVideoConfig } from '../timeline.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export type SlideDirection = 'from-left' | 'from-top' | 'from-right' | 'from-bottom';
export interface SlideProps extends Record<string, unknown> {
  direction?: SlideDirection;
}

/** Offset as a fraction of the size, along the sliding axis. */
export function slideOffset(direction: SlideDirection, entering: boolean, progress: number): number {
  const sign = direction === 'from-left' || direction === 'from-top' ? 1 : -1;
  // entering: from one full size away, to rest; exiting: from rest, one full size away on the other side
  return entering ? -sign * (1 - progress) : sign * progress;
}

function SlidePresentation({ children, presentationProgress, presentationDirection, passedProps }: PresentationComponentProps<SlideProps>): ReactNode {
  const { width, height } = useVideoConfig();
  const direction = passedProps.direction ?? 'from-left';
  const offset = slideOffset(direction, presentationDirection === 'entering', presentationProgress);
  const horizontal = direction === 'from-left' || direction === 'from-right';
  return (
    <Layer x={horizontal ? offset * width : 0} y={horizontal ? 0 : offset * height}>
      {children}
    </Layer>
  );
}

export function slide(options: { direction?: SlideDirection } = {}): TransitionPresentation<SlideProps> {
  return { component: SlidePresentation, props: options };
}
