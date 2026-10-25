// anime.js v4 for a frame-driven render: one timeline that does not autoplay, built once, seeked to the frame's time in
// milliseconds every frame. `animejs` is a peer dependency and is never patched.
//
// The tweens are made inside `createScope`, so a string selector is looked up inside the returned ref's element and
// everything is reverted on unmount. An animation made in the build function outside the timeline would play on
// anime.js's own loop, which a render does not control, so it is warned about.

import { createElement, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { createScope, createTimeline, type Timeline } from 'animejs';

export type { Timeline };

/**
 * What `useAnimeTimeline` returns: attach it to the element that scopes string selectors. `ref.timeline` is the
 * timeline once the layout effect has run.
 */
export interface AnimeTimelineRef<T extends Element = HTMLDivElement> extends RefObject<T | null> {
  timeline: Timeline | null;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** Forgets what was warned about (for tests). */
export function resetAnimeWarnings(): void {
  warned.clear();
}

/** Animations the scope holds that are not the timeline, not inside it, and not paused. */
function strays(scope: { revertibles: unknown[] }, tl: Timeline): unknown[] {
  return scope.revertibles.filter((r) => {
    const a = r as { paused?: boolean; parent?: unknown; duration?: number };
    return r !== tl && a.parent !== tl && a.paused === false && (a.duration ?? 0) > 0;
  });
}

/**
 * A timeline that does not autoplay, seeked to the current frame.
 *
 * `build` runs once (and again when `deps` change) inside `createScope`, with the timeline to add animations to.
 * Every frame, `tl.seek(frame / fps * 1000)` moves it. Callbacks (`onUpdate`, `onComplete`) run on a seek.
 *
 * ```tsx
 * const scope = useAnimeTimeline((tl) => {
 *   tl.add('.box', { translateX: [0, 700], rotate: 360 }, 0).add('.dot', { opacity: [0, 1] }, 300);
 * });
 * return <div ref={scope}><div className="box" /><div className="dot" /></div>;
 * ```
 */
export function useAnimeTimeline<T extends Element = HTMLDivElement>(
  build: (tl: Timeline) => void,
  deps: readonly unknown[] = [],
): AnimeTimelineRef<T> {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<AnimeTimelineRef<T>>(null as unknown as AnimeTimelineRef<T>);
  if (ref.current === null) ref.current = { current: null, timeline: null } as AnimeTimelineRef<T>;
  const handle = ref.current;
  const now = useRef(0);
  now.current = (frame / fps) * 1000;

  useLayoutEffect(() => {
    const tl = createTimeline({ autoplay: false });
    const scope = createScope(handle.current ? { root: handle.current } : {});
    scope.add(() => {
      build(tl);
    });
    const stray = strays(scope as unknown as { revertibles: unknown[] }, tl);
    if (stray.length > 0) {
      warnOnce(
        `useAnimeTimeline: ${stray.length} animation${stray.length === 1 ? '' : 's'} made in the build function ` +
          `${stray.length === 1 ? 'is' : 'are'} not on the timeline and not paused, so ` +
          `${stray.length === 1 ? 'it plays' : 'they play'} on anime.js's own loop. Use tl.add(...) instead of animate(...).`,
      );
    }
    handle.timeline = tl;
    tl.seek(now.current);
    return () => {
      scope.revert();
      tl.revert();
      handle.timeline = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useLayoutEffect(() => {
    handle.timeline?.seek((frame / fps) * 1000);
  }, [frame, fps, handle]);

  return handle;
}

export interface AnimeTimelineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Adds the animations to `tl`. String selectors are looked up inside this component's element. */
  build: (tl: Timeline) => void;
  /** When these change the timeline is built again. */
  deps?: readonly unknown[];
  children?: ReactNode;
}

/** `useAnimeTimeline` as a component: a `<div>` that scopes the selectors in `build`. */
export function AnimeTimeline({ build, deps, children, ...rest }: AnimeTimelineProps) {
  const scope = useAnimeTimeline<HTMLDivElement>(build, deps);
  return createElement('div', { ...rest, ref: scope }, children);
}
