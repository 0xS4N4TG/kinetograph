import { useSyncExternalStore } from 'react';

// The last box dragged on the preview, in composition pixels, for the panels that tie a note to an area (the review).
// The viewer returns only the layers inside a box, so a box over empty space would be lost. A tiny store, like the
// review marks: the viewer sets it, a panel reads it. `selection` is the layers the drag picked (their ids joined by
// NUL): the box is only the current one while the selection is still that.

export interface MarqueeBox {
  box: { x: number; y: number; w: number; h: number };
  selection: string;
}

let current: MarqueeBox | null = null;
const listeners = new Set<() => void>();

export function setMarqueeBox(next: MarqueeBox | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getMarqueeBox(): MarqueeBox | null {
  return current;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useMarqueeBox(): MarqueeBox | null {
  return useSyncExternalStore(subscribe, () => current);
}
