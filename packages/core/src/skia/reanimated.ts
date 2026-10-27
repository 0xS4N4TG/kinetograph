// `react-native-reanimated`, as far as a Skia scene uses it: shared values (`useSharedValue`, `useDerivedValue`) that
// RN-Skia takes as props, its `interpolate`, `interpolateColor` and `Easing`. Reanimated runs animations on the wall
// clock (`withTiming`, `withSpring`, ...), which a render must not read: an animation jumps to its end value and is
// reported (a warning; `--strict` fails). Drive the value from `useCurrentFrame()` instead.

import { useEffect, useRef } from 'react';
import { useTimeline } from '@kinetographdev/react';
import { Easing } from '../easing.js';
import { interpolate as remotionInterpolate } from '../interpolate.js';
import { interpolateColors } from '../interpolate-colors.js';
import { reportUnsupported } from '../unsupported.js';
import { isSharedValue, makeMutable, useDerived, type SharedValue } from './shared-value.js';

export { Easing, isSharedValue, makeMutable, type SharedValue };

/** A value for this render of the frame, set from `initial`. */
export function useSharedValue<T>(initial: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  ref.current ??= makeMutable(initial);
  return ref.current;
}

/** A value worked out from others each time it is read. */
export function useDerivedValue<T>(derive: () => T, _deps?: unknown[]): SharedValue<T> {
  return useDerived(derive);
}

/** Runs `react` with what `prepare` answers, after the render, and again when that changes. */
export function useAnimatedReaction<T>(prepare: () => T, react: (current: T, previous: T | null) => void, deps?: unknown[]): void {
  const previous = useRef<T | null>(null);
  useEffect(() => {
    const current = prepare();
    if (!Object.is(current, previous.current)) react(current, previous.current);
    previous.current = current;
  }, deps);
}

export interface FrameInfo {
  timestamp: number;
  timeSincePreviousFrame: number | null;
  timeSinceFirstFrame: number;
}

/** Calls `callback` once for the frame being rendered, with its time from the frame number (milliseconds). */
export function useFrameCallback(callback: (info: FrameInfo) => void, autostart = true): { setActive(on: boolean): void; isActive: boolean; callbackId: number } {
  const { frame, config } = useTimeline();
  const ms = (frame / config.fps) * 1000;
  useEffect(() => {
    if (autostart) callback({ timestamp: ms, timeSincePreviousFrame: frame > 0 ? 1000 / config.fps : null, timeSinceFirstFrame: ms });
  });
  return { setActive: () => {}, isActive: autostart, callbackId: 0 };
}

export const runOnJS = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => fn;
export const runOnUI = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => fn;
export function cancelAnimation(_value: SharedValue): void {}

/** An animation of Reanimated: it runs on the wall clock, so here it is its end value, and it is reported. */
function clockAnimation<T>(name: string, to: T, callback?: (finished: boolean) => void): T {
  reportUnsupported(
    'react-native-reanimated',
    name,
    null,
    `${name} runs on the wall clock, which a render does not read: the value jumps to its end. Work it out from useCurrentFrame() (interpolate, spring) instead`,
  );
  callback?.(true);
  return to;
}

export const withTiming = <T>(to: T, _config?: unknown, callback?: (finished: boolean) => void): T => clockAnimation('withTiming', to, callback);
export const withSpring = <T>(to: T, _config?: unknown, callback?: (finished: boolean) => void): T => clockAnimation('withSpring', to, callback);
export const withDecay = (config: { velocity?: number; clamp?: [number, number] } = {}, callback?: (finished: boolean) => void): number =>
  clockAnimation('withDecay', config.clamp?.[1] ?? 0, callback);
export const withDelay = <T>(_ms: number, animation: T): T => clockAnimation('withDelay', animation);
export const withRepeat = <T>(animation: T, _times?: number, _reverse?: boolean, callback?: (finished: boolean) => void): T =>
  clockAnimation('withRepeat', animation, callback);
export const withSequence = <T>(...animations: T[]): T => clockAnimation('withSequence', animations.at(-1) as T);
export const withClamp = <T>(_config: unknown, animation: T): T => animation;

export const Extrapolation = { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' } as const;
/** The old name of `Extrapolation`. */
export const Extrapolate = Extrapolation;
type ExtrapolationType = (typeof Extrapolation)[keyof typeof Extrapolation];

/** Reanimated's `interpolate`: `x` mapped from `input` to `output`, extended past the ends unless told otherwise. */
export function interpolate(
  x: number,
  input: readonly number[],
  output: readonly number[],
  extrapolation?: ExtrapolationType | { extrapolateLeft?: ExtrapolationType; extrapolateRight?: ExtrapolationType },
): number {
  const left = typeof extrapolation === 'object' ? extrapolation.extrapolateLeft : extrapolation;
  const right = typeof extrapolation === 'object' ? extrapolation.extrapolateRight : extrapolation;
  return remotionInterpolate(x, input, output, { extrapolateLeft: left ?? 'extend', extrapolateRight: right ?? 'extend' });
}

/** Reanimated's `interpolateColor`: the colour at `x` between the colours of `output`, as `rgba(...)`. */
export function interpolateColor(x: number, input: readonly number[], output: readonly string[]): string {
  return interpolateColors(x, input, output);
}

/** Reanimated's `clamp`. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** `Animated` components are React Native views: there are none outside React Native. */
const Animated = {};
export default Animated;
