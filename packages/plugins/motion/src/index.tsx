// Motion for a frame-driven render. Motion runs its own frame loop (requestAnimationFrame and the clock), and an
// animation started by `<motion.div animate>`, `animate()` or `useSpring` is a function of how long ago it started. A
// render that begins at frame 30 (a lone frame, a parallel chunk) would start it 30 frames late.
//
// Motion 14.6 has a documented way to drive its loop from a timeline you own: `MotionGlobalConfig.useManualTiming`
// and `processFrame(timestamp)`. `<MotionFrame>` uses exactly that, with no patch to Motion: children mount at
// time 0, then Motion's loop is run to the frame's time in a layout effect. Motion's springs and keyframes are
// closed-form in the elapsed time, so the state at frame N is the same alone and in sequence.
//
// Kinetograph's own engine already runs requestAnimationFrame on the virtual clock and catches it up over skipped
// frames, so Motion's loop gives the same frame alone and in sequence there with or without this package (checked:
// the output is identical). What this package adds is the same behaviour under Remotion's real-time Chrome, an
// explicit time base, and `useAnimateAt`, which does not depend on a frame loop at all.
//
// An animation that depends on the history of its inputs (a `useSpring` that follows a changing value) is only as
// pure as the frames the renderer has visited. Drive those from the frame with `useMotionTime` + `useTransform`, or
// with `useSpringAt`.

import { Fragment, createElement, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import * as motionNs from 'motion';
import { MotionGlobalConfig, frameData, motionValue, spring, time, type AnimationPlaybackControls, type MotionValue } from 'motion';

// `processFrame` is new in Motion 14.6. Without it MotionFrame does nothing (and says so once); the engine's own
// frame-pure requestAnimationFrame still drives Motion, and the other exports work on Motion 12 and later.
const processFrame = (motionNs as unknown as { processFrame?: (timestamp?: number) => void }).processFrame;
let warnedOld = false;

export interface MotionFrameProps {
  children?: ReactNode;
}

/**
 * Ties Motion's clock to the composition's frame. Put it around everything that uses Motion.
 *
 * Children mount at Motion time 0; every frame, Motion's loop runs to `frame / fps` seconds. `processFrame` needs `motion` 14.6
 * or later; on an older Motion this does nothing.
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

  const drive = processFrame !== undefined;
  if (!drive && !warnedOld) {
    warnedOld = true;
    console.warn('MotionFrame: this version of motion has no processFrame (added in 14.6), so MotionFrame does nothing.');
  }
  if (drive && !started.current) {
    // Before the children mount, so that what they start is started at time 0.
    started.current = true;
    before.current = MotionGlobalConfig.useManualTiming === true;
    MotionGlobalConfig.useManualTiming = true;
    frameData.timestamp = 0;
    frameData.delta = 0;
    time.set(0);
  }

  // A passive effect, because Motion starts a component's animations in its passive effect and a parent's passive
  // effect runs after its children's. Runs on every frame.
  useEffect(() => {
    if (!processFrame) return;
    processFrame(0);
    if (ms > 0) processFrame(ms);
  }, [ms]);
  useLayoutEffect(
    () => () => {
      if (drive) MotionGlobalConfig.useManualTiming = before.current;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/**
 * `animate()` seeked to the frame: `start` is called once after mount (and again when `deps` change) and returns the
 * controls of what it started; they are paused and `controls.time` is set to `frame / fps` seconds every frame. No
 * frame loop is involved, so the state at frame N does not depend on how Motion was clocked before it.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * useAnimateAt(() => animate(ref.current!, { x: [0, 400], rotate: 360 }, { duration: 1.5, ease: 'easeInOut' }));
 * ```
 */
export function useAnimateAt(start: () => AnimationPlaybackControls, deps: readonly unknown[] = []): void {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const controls = useRef<AnimationPlaybackControls | null>(null);
  const seconds = useRef(0);
  seconds.current = frame / fps;

  useLayoutEffect(() => {
    const c = start();
    c.pause();
    c.time = seconds.current;
    controls.current = c;
    return () => {
      c.stop();
      controls.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useLayoutEffect(() => {
    if (controls.current) controls.current.time = frame / fps;
  }, [frame, fps]);
}
