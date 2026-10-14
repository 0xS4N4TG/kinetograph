// `@remotion/transitions/flip`: the old scene turns away about its middle and
// the new one turns in from behind it. A face turned away is not drawn.
//
// The scene's 3D transform needs a camera to have any perspective; the entering
// side adds one (`<Camera perspective>`, 1000 as in the package) while the flip
// is under way. A composition that has a `<Camera>` of its own would have two, so
// it passes `perspective: null` to use the camera it has (or none: orthographic).

import type { ReactNode } from 'react';
import { Camera, Layer } from '@kinetograph/react';
import { useVideoConfig } from '../timeline.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export type FlipDirection = 'from-left' | 'from-top' | 'from-right' | 'from-bottom';
export interface FlipProps extends Record<string, unknown> {
  direction?: FlipDirection;
  perspective?: number | null;
}

/** Degrees the scene is turned, about the vertical axis for left and right, the horizontal one for top and bottom. */
export function flipAngle(direction: FlipDirection, entering: boolean, progress: number): number {
  // Positive turns about y swing the right edge away (from-left leaves that way); about x it is the bottom edge.
  const sign = direction === 'from-left' || direction === 'from-bottom' ? 1 : -1;
  return entering ? -sign * 180 * (1 - progress) : sign * 180 * progress;
}

function FlipPresentation({ children, presentationProgress, presentationDirection, passedProps }: PresentationComponentProps<FlipProps>): ReactNode {
  const { width, height } = useVideoConfig();
  const direction = passedProps.direction ?? 'from-left';
  const perspective = passedProps.perspective === undefined ? 1000 : passedProps.perspective;
  const entering = presentationDirection === 'entering';
  const angle = flipAngle(direction, entering, presentationProgress);
  const horizontal = direction === 'from-left' || direction === 'from-right';
  const underway = presentationProgress > 0 && presentationProgress < 1;
  return (
    <Layer
      x={width / 2}
      y={height / 2}
      anchorX={width / 2}
      anchorY={height / 2}
      rotateY={horizontal ? angle : 0}
      rotateX={horizontal ? 0 : angle}
      opacity={Math.abs(angle) > 90 ? 0 : 1}
    >
      {children}
      {entering && underway && perspective !== null ? <Camera perspective={perspective} /> : null}
    </Layer>
  );
}

export function flip(options: { direction?: FlipDirection; perspective?: number | null } = {}): TransitionPresentation<FlipProps> {
  return { component: FlipPresentation, props: options };
}
