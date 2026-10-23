// `@remotion/transitions/clock-wipe`: the new scene is revealed by a sweeping
// hand, clockwise from twelve o'clock, over the old one.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import { useVideoConfig } from '../timeline.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export interface ClockWipeProps extends Record<string, unknown> {
  width?: number;
  height?: number;
}

/** The clip path that shows the first `progress` of a turn, as a pie slice big enough to cover the frame. */
export function clockWipePath(width: number, height: number, progress: number): string {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.hypot(width, height) / 2;
  const angle = progress * 2 * Math.PI;
  const point = (a: number) => `${cx + radius * Math.sin(a)} ${cy - radius * Math.cos(a)}`;
  const arc = (a: number) => `A ${radius} ${radius} 0 0 1 ${point(a)}`;
  const parts = [`M ${point(0)}`];
  if (progress > 0.5) parts.push(arc(Math.PI));
  parts.push(arc(angle));
  if (progress > 0 && progress < 1) parts.push(`L ${cx} ${cy}`);
  parts.push('Z');
  return parts.join(' ');
}

function ClockWipePresentation({ children, presentationProgress, presentationDirection, passedProps }: PresentationComponentProps<ClockWipeProps>): ReactNode {
  const config = useVideoConfig();
  const width = passedProps.width ?? config.width;
  const height = passedProps.height ?? config.height;
  if (presentationDirection === 'exiting') return <Layer>{children}</Layer>;
  return <Layer clip={{ kind: 'path', d: clockWipePath(width, height, presentationProgress) }}>{children}</Layer>;
}

export function clockWipe(options: { width?: number; height?: number } = {}): TransitionPresentation<ClockWipeProps> {
  return { component: ClockWipePresentation, props: options };
}
