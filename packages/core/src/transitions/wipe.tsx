// `@remotion/transitions/wipe`: a hard edge sweeps across; the new scene shows
// behind it, the old one beyond it. The scenes are cut with polygon clips.

import type { ReactNode } from 'react';
import { Layer } from '@kinetograph/react';
import { useVideoConfig } from '../timeline.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export type WipeDirection =
  | 'from-left'
  | 'from-top'
  | 'from-right'
  | 'from-bottom'
  | 'from-top-left'
  | 'from-top-right'
  | 'from-bottom-left'
  | 'from-bottom-right';
export interface WipeProps extends Record<string, unknown> {
  direction?: WipeDirection;
}

type Fraction = [number, number];

/** The clip polygon, in fractions of the composition's size (diagonal wipes reach past 0..1). */
export function wipePolygon(direction: WipeDirection, entering: boolean, p: number): Fraction[] {
  switch (direction) {
    case 'from-left':
      return entering ? [[0, 0], [p, 0], [p, 1], [0, 1]] : [[1, 1], [p, 1], [p, 0], [1, 0]];
    case 'from-right':
      return entering ? [[1, 0], [1, 1], [1 - p, 1], [1 - p, 0]] : [[0, 0], [1 - p, 0], [1 - p, 1], [0, 1]];
    case 'from-top':
      return entering ? [[0, 0], [1, 0], [1, p], [0, p]] : [[1, 1], [0, 1], [0, p], [1, p]];
    case 'from-bottom':
      return entering ? [[0, 1], [1, 1], [1, 1 - p], [0, 1 - p]] : [[1, 0], [0, 0], [0, 1 - p], [1, 1 - p]];
    case 'from-top-left':
      return entering ? [[0, 0], [2 * p, 0], [0, 2 * p]] : [[1, 1], [-1 + 2 * p, 1], [1, -1 + 2 * p]];
    case 'from-top-right':
      return entering ? [[1, 0], [1 - 2 * p, 0], [1, 2 * p]] : [[0, 1], [2 - 2 * p, 1], [0, -1 + 2 * p]];
    case 'from-bottom-left':
      return entering ? [[0, 1], [0, 1 - 2 * p], [2 * p, 1]] : [[1, 0], [-1 + 2 * p, 0], [1, 2 - 2 * p]];
    case 'from-bottom-right':
      return entering ? [[1, 1], [1 - 2 * p, 1], [1, 1 - 2 * p]] : [[0, 0], [2 - 2 * p, 0], [0, 2 - 2 * p]];
  }
}

function WipePresentation({ children, presentationProgress, presentationDirection, passedProps }: PresentationComponentProps<WipeProps>): ReactNode {
  const { width, height } = useVideoConfig();
  const polygon = wipePolygon(passedProps.direction ?? 'from-left', presentationDirection === 'entering', presentationProgress);
  return (
    <Layer clip={{ kind: 'polygon', points: polygon.map(([x, y]) => [x * width, y * height] as [number, number]) }}>{children}</Layer>
  );
}

export function wipe(options: { direction?: WipeDirection } = {}): TransitionPresentation<WipeProps> {
  return { component: WipePresentation, props: options };
}
