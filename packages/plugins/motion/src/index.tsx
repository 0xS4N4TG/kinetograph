// Motion for a frame-driven render. Motion runs its own frame loop (requestAnimationFrame and the clock), and an
// animation started by `<motion.div animate>`, `animate()` or `useSpring` is a function of how long ago it started. A
// render that begins at frame 30 (a lone frame, a parallel chunk) would start it 30 frames late.
//
// Motion 14.6 has a documented way to drive its loop from a timeline you own: `MotionGlobalConfig.useManualTiming`
// and `processFrame(timestamp)`. `<MotionFrame>` uses exactly that, with no patch to Motion: children mount at
// time 0, then Motion's loop is run to the frame's time in a layout effect. Motion's springs and keyframes are
// closed-form in the elapsed time, so the state at frame N is the same alone and in sequence.
//
// What this does not make pure: an animation that depends on the history of its inputs. A `useSpring` that follows a
// value that changes, or `animate` props that change from frame to frame, start from the velocity they had, so they
// give a different frame alone than in sequence. Drive those from the frame with `useMotionTime` + `useTransform`,
// or with `springAt` below.

import { Fragment, createElement, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { MotionGlobalConfig, frameData, motionValue, processFrame, spring, time, type MotionValue } from 'motion';

export interface MotionFrameProps {
  children?: ReactNode;
}

/**
 * Ties Motion's clock to the composition's frame. Put it around everything that uses Motion.
 *
 * Children mount at Motion time 0; every frame, Motion's loop runs to `frame / fps` seconds. Needs `motion` 14.6 or
 * later (`processFrame`).
 *
 * ```tsx
 * <MotionFrame>
 *   <motion.div initial={{ x: 0 }} animate={{ x: 600 }} transition={{ type: 'spring', stiffness: 80, damping: 12 }} />
 * </MotionFrame>
 * ```
 */
export function MotionFrame({ children }: MotionFrameProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame * 1000) / fps;
  const started = useRef(false);
  const before = useRef(false);

  if (!started.current) {
    // Before the children mount, so that what they start is started at time 0.
    started.current = true;
    before.current = MotionGlobalConfig.useManualTiming === true;
    MotionGlobalConfig.useManualTiming = true;
    frameData.timestamp = 0;
    frameData.delta = 0;
    time.set(0);
  }

  // Runs after the children's layout effects (they start their animations there), and on every frame.
  useLayoutEffect(() => {
    processFrame(0);
    if (ms > 0) processFrame(ms);
  }, [ms]);
  useLayoutEffect(
    () => () => {
      MotionGlobalConfig.useManualTiming = before.current;
    },
    [],
  );

  return createElement(Fragment, null, children);
}

/**
 * The frame's time in milliseconds, as a MotionValue: `useTime()` that the frame drives. Feed it to `useTransform`.
 *
 * ```tsx
 * const t = useMotionTime();
 * const x = useTransform(t, [0, 1000], [0, 400]);
 * ```
 */
export function useMotionTime(): MotionValue<number> {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame * 1000) / fps;
  const ref = useRef<MotionValue<number> | null>(null);
  if (ref.current === null) ref.current = motionValue(ms);
  ref.current.set(ms);
  return ref.current;
}

export interface SpringAtOptions {
  from?: number;
  to: number;
  stiffness?: number;
  damping?: number;
  mass?: number;
  /** Frame at which the spring starts. Default 0. */
  delay?: number;
}

/**
 * Motion's spring evaluated at the current frame: a pure function of the frame, with no state and no frame loop. Use
 * it for a spring whose start frame you know (a state that changes on a frame).
 *
 * ```tsx
 * const x = useSpringAt({ to: 600, stiffness: 80, damping: 12, delay: 30 });
 * ```
 */
export function useSpringAt({ from = 0, to, stiffness = 100, damping = 10, mass = 1, delay = 0 }: SpringAtOptions): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = Math.max(0, ((frame - delay) * 1000) / fps);
  const generator = spring({ keyframes: [from, to], stiffness, damping, mass });
  return generator.next(t).value as number;
}
