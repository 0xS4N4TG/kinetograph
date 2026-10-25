// GSAP for a frame-driven render. The pattern Remotion documents, and the one Kinetograph's GSAP support is checked
// against: one paused timeline, built once on mount, seeked to the frame's time in a layout effect.
//
// `gsap` is a peer dependency and is never patched. The hook only owns the timeline's life: it builds the tweens inside
// a `gsap.context` (so they are reverted on unmount) and seeks with `suppressEvents = false` (so `onUpdate`, `onStart`
// and `onComplete` run on a seek, which GSAP's own default suppresses). A tween in `build` that is not on the timeline
// plays on GSAP's root clock, which the engine moves with the frame (packages/core/src/gsap-clock.ts).

import { createElement, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { gsap } from 'gsap';

/**
 * What `useGsapTimeline` returns: attach it to the element that scopes string selectors (`tl.to('.box', ...)` looks
 * inside it). `ref.timeline` is the timeline once the layout effect has run.
 */
export interface GsapTimelineRef<T extends Element = HTMLDivElement> extends RefObject<T | null> {
  timeline: gsap.core.Timeline | null;
}

/**
 * A paused GSAP timeline, seeked to the current frame.
 *
 * `build` runs once (and again when `deps` change) inside `gsap.context`, after the layout is mounted, with a paused
 * timeline to add tweens to. Every frame, `tl.seek(frame / fps, false)` moves it. Put every tween on `tl`.
 *
 * ```tsx
 * const scope = useGsapTimeline((tl) => {
 *   tl.to('.box', { x: 700, duration: 1.8, ease: 'power2.out' }, 0.1);
 * });
 * return <div ref={scope}><div className="box" /></div>;
 * ```
 */
export function useGsapTimeline<T extends Element = HTMLDivElement>(
  build: (tl: gsap.core.Timeline) => void,
  deps: readonly unknown[] = [],
): GsapTimelineRef<T> {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<GsapTimelineRef<T>>(null as unknown as GsapTimelineRef<T>);
  if (ref.current === null) {
    const created = { current: null, timeline: null } as GsapTimelineRef<T>;
    ref.current = created;
  }
  const scope = ref.current;
  // The latest frame, so a timeline built late (deps changed) starts at the right time.
  const now = useRef(0);
  now.current = frame / fps;

  useLayoutEffect(() => {
    const tl = gsap.timeline({ paused: true });
    const ctx = gsap.context(() => {
      build(tl);
    }, scope.current ?? undefined);
    scope.timeline = tl;
    tl.seek(now.current, false);
    return () => {
      ctx.revert();
      tl.kill();
      scope.timeline = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useLayoutEffect(() => {
    scope.timeline?.seek(frame / fps, false);
  }, [frame, fps, scope]);

  return scope;
}

export interface GsapTimelineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Adds the tweens to `tl`. String selectors are looked up inside this component's element. */
  build: (tl: gsap.core.Timeline) => void;
  /** When these change the timeline is built again. */
  deps?: readonly unknown[];
  children?: ReactNode;
}

/**
 * `useGsapTimeline` as a component: a `<div>` that scopes the selectors in `build`.
 *
 * ```tsx
 * <GsapTimeline build={(tl) => tl.from('.word', { y: 40, opacity: 0, stagger: 0.08 })}>
 *   <span className="word">Hello</span> <span className="word">world</span>
 * </GsapTimeline>
 * ```
 */
export function GsapTimeline({ build, deps, children, ...rest }: GsapTimelineProps) {
  const scope = useGsapTimeline<HTMLDivElement>(build, deps);
  return createElement('div', { ...rest, ref: scope }, children);
}
