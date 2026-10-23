// `@remotion/transitions/iris`: the new scene opens from the middle of the frame
// as a circle that grows until it covers the corners.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import { useVideoConfig } from '../timeline.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export interface IrisProps extends Record<string, unknown> {
  width?: number;
  height?: number;
}

function IrisPresentation({ children, presentationProgress, presentationDirection, passedProps }: PresentationComponentProps<IrisProps>): ReactNode {
  const config = useVideoConfig();
  const width = passedProps.width ?? config.width;
  const height = passedProps.height ?? config.height;
  if (presentationDirection === 'exiting') return <Layer>{children}</Layer>;
  const radius = Math.max(0, (Math.hypot(width, height) / 2) * presentationProgress);
  return <Layer clip={{ kind: 'ellipse', cx: width / 2, cy: height / 2, rx: radius, ry: radius }}>{children}</Layer>;
}

export function iris(options: { width?: number; height?: number } = {}): TransitionPresentation<IrisProps> {
  return { component: IrisPresentation, props: options };
}
