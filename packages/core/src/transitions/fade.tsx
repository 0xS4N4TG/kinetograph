// `@remotion/transitions/fade`: the scene coming in fades up over the one going
// out, which stays fully visible underneath until it is gone.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

function FadePresentation({ children, presentationProgress, presentationDirection }: PresentationComponentProps<Record<string, never>>): ReactNode {
  return <Layer opacity={presentationDirection === 'entering' ? presentationProgress : 1}>{children}</Layer>;
}

export function fade(): TransitionPresentation<Record<string, never>> {
  return { component: FadePresentation, props: {} };
}
