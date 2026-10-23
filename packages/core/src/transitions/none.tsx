// `@remotion/transitions/none`: no effect; the scenes simply overlap for the length of the transition.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

function NonePresentation({ children }: PresentationComponentProps<Record<string, never>>): ReactNode {
  return <Layer>{children}</Layer>;
}

export function none(): TransitionPresentation<Record<string, never>> {
  return { component: NonePresentation, props: {} };
}
