/** The slide every card movement uses: ~200 ms, ease-out. */
export const SLIDE_MS = 200;
export const SLIDE_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

export interface Offset {
  x: number;
  y: number;
}

/** Whether `el` may be moved with an animation: the browser has the Web Animations API and the user has not asked for less motion. */
export function motionAllowed(el: HTMLElement): boolean {
  if (typeof el.animate !== 'function') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Where a running animation has the element right now, read from its computed transform. */
export function currentOffset(el: HTMLElement): Offset {
  const m = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(el).transform);
  const parts = m?.[1]?.split(',').map(Number);
  return parts && parts.length === 6 ? { x: parts[4]!, y: parts[5]! } : { x: 0, y: 0 };
}

/** Slides `el` from an offset to where it now sits. `done` runs when the slide ends or is cancelled. */
export function slideFrom(el: HTMLElement, from: Offset, done: () => void): Animation | null {
  if (!motionAllowed(el)) return null;
  const a = el.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: 'translate(0px, 0px)' }], {
    duration: SLIDE_MS,
    easing: SLIDE_EASE,
  });
  a.onfinish = done;
  a.oncancel = done;
  return a;
}

/** A card that was just added eases in. */
export function fadeIn(el: HTMLElement): void {
  if (!motionAllowed(el)) return;
  el.animate(
    [
      { opacity: 0, transform: 'scale(0.96)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    { duration: SLIDE_MS, easing: SLIDE_EASE },
  );
}
