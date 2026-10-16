// What a scene inside a `TransitionSeries` can ask about the transitions it is in (`useTransitionProgress`), and the
// identity of a transition that its two presentations share.

import { createContext, useContext } from 'react';

export const EnteringContext = createContext<{ enteringProgress: number } | null>(null);
export const ExitingContext = createContext<{ exitingProgress: number } | null>(null);
/** The id of the transition a presentation is drawing: the same for the scene going out and the one coming in. */
export const TransitionIdContext = createContext<string | null>(null);

export interface TransitionState {
  /** Whether the scene is in a transition of a `TransitionSeries` at this frame. */
  isInTransitionSeries: boolean;
  /** How far the scene has come in: 0 to 1, and 1 when it is not entering. */
  entering: number;
  /** How far the scene has gone out: 0 to 1, and 0 when it is not exiting. */
  exiting: number;
}

/**
 * Inside a `<TransitionSeries.Sequence>`: the progress of the transitions the scene is in at this frame, to move the
 * things in a scene along with them. Outside a transition it says the scene is not in one.
 */
export function useTransitionProgress(): TransitionState {
  const entering = useContext(EnteringContext);
  const exiting = useContext(ExitingContext);
  if (!entering && !exiting) return { isInTransitionSeries: false, entering: 1, exiting: 0 };
  return { isInTransitionSeries: true, entering: entering?.enteringProgress ?? 1, exiting: exiting?.exitingProgress ?? 0 };
}
