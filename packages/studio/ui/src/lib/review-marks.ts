import { useSyncExternalStore } from 'react';

// The review panel's notes, as frames the timeline's ruler marks. A tiny store, so the timeline needs no new prop and
// the layout no new wiring: the panel sets it while it is open, the ruler reads it.

export interface ReviewMarks {
  comp: string;
  frames: number[];
}

let current: ReviewMarks | null = null;
const listeners = new Set<() => void>();

export function setReviewMarks(marks: ReviewMarks | null): void {
  current = marks;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useReviewMarks(): ReviewMarks | null {
  return useSyncExternalStore(subscribe, () => current);
}
