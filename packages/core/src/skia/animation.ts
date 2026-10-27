// RN-Skia's animation hooks, on shared values (shared-value.ts). Time is the frame's: `useClock()` is the time of the
// frame being rendered, and an animated picture shows the frame for that time, so a frame is a pure function of the
// frame number.

import { useTimeline } from '@kinetographdev/react';
import { interpolate } from './reanimated.js';
import { AnimatedImageFactory, SkAnimatedImage, type SkData } from './data.js';
import { projectFile, SkPath, type SkImage, type SkPoint, type SkRect } from './objects.js';
import { unwrap, useDerived, type SharedValue } from './shared-value.js';

type Extrapolate = 'clamp' | 'extend' | 'identity';

/** The milliseconds from the start of the composition to the frame being rendered. */
export function useClock(): SharedValue<number> {
  const { frame, config } = useTimeline();
  const ms = (frame / config.fps) * 1000;
  return useDerived(() => ms);
}

/** The segment of `input` that `x` falls in, and how far along it (clamped or extended as asked). */
function segment(x: number, input: readonly number[], extrapolate: Extrapolate = 'clamp'): [number, number] {
  let i = 0;
  while (i < input.length - 2 && x > input[i + 1]!) i += 1;
  const t = interpolate(x, [input[i]!, input[i + 1]!], [0, 1], extrapolate);
  return [i, t];
}

/** The path between those of `outputRange` at `value` (the paths need the same verbs and points). */
export function usePathInterpolation(
  value: SharedValue<number> | number,
  input: number[],
  outputRange: SkPath[],
  extrapolate?: Extrapolate,
): SharedValue<SkPath> {
  return useDerived(() => {
    const [i, t] = segment(unwrap(value) as number, input, extrapolate);
    const [from, to] = [outputRange[i]!, outputRange[i + 1] ?? outputRange[i]!];
    if (t <= 0) return from;
    if (t >= 1) return to;
    return to.interpolate(from, t) ?? from;
  });
}

/** The vector between those of `outputRange` at `value`. */
export function useVectorInterpolation(
  value: SharedValue<number> | number,
  input: number[],
  outputRange: SkPoint[],
  extrapolate?: Extrapolate,
): SharedValue<SkPoint> {
  return useDerived(() => {
    const x = unwrap(value) as number;
    return {
      x: interpolate(x, input, outputRange.map((p) => p.x), extrapolate),
      y: interpolate(x, input, outputRange.map((p) => p.y), extrapolate),
    };
  });
}

/** A path made by `build` on a copy of `init` (or an empty path) each time it is read. */
export function usePathValue(build: (path: SkPath) => void, init?: SkPath): SharedValue<SkPath> {
  return useDerived(() => {
    const path = init ? init.copy() : new SkPath();
    build(path);
    return path;
  });
}

/** A mutable rect, as the rects of `useRectBuffer` are. */
class MutableRect implements SkRect {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  setXYWH(x: number, y: number, width: number, height: number): void {
    Object.assign(this, { x, y, width, height });
  }
  toJSON(): SkRect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

/** A mutable RSXform, as those of `useRSXformBuffer` are. */
class MutableRSXform {
  scos = 1;
  ssin = 0;
  tx = 0;
  ty = 0;
  set(scos: number, ssin: number, tx: number, ty: number): void {
    Object.assign(this, { scos, ssin, tx, ty });
  }
  toJSON() {
    return { scos: this.scos, ssin: this.ssin, tx: this.tx, ty: this.ty };
  }
}

/** `size` rects, each set by `modifier(rect, index)` whenever the value is read (an `<Atlas>`'s sprites). */
export function useRectBuffer(size: number, modifier: (rect: MutableRect, index: number) => void): SharedValue<MutableRect[]> {
  return useDerived(() =>
    Array.from({ length: size }, (_, i) => {
      const rect = new MutableRect();
      modifier(rect, i);
      return rect;
    }),
  );
}

/** `size` RSXforms, each set by `modifier(xform, index)` whenever the value is read (an `<Atlas>`'s transforms). */
export function useRSXformBuffer(size: number, modifier: (xform: MutableRSXform, index: number) => void): SharedValue<MutableRSXform[]> {
  return useDerived(() =>
    Array.from({ length: size }, (_, i) => {
      const xform = new MutableRSXform();
      modifier(xform, i);
      return xform;
    }),
  );
}

/** The animated GIF or WebP in a project file (or in data), or null for null. */
export function useAnimatedImage(source: string | SkData | null | undefined): SkAnimatedImage | null {
  if (source === null || source === undefined) return null;
  if (typeof source === 'string') return new SkAnimatedImage({ src: projectFile(source, 'animated picture') });
  return AnimatedImageFactory.MakeAnimatedImageFromEncoded(source);
}

/**
 * The frame of an animated picture for the time of the frame being rendered, looping: RN-Skia's player steps through
 * the frames by their durations from the start, and so does this, from the frame number. While `paused` is true it
 * shows the first frame.
 */
export function useAnimatedImageValue(
  source: string | SkData | null | undefined,
  paused?: SharedValue<boolean> | boolean,
): SharedValue<SkImage | null> {
  const { frame, config } = useTimeline();
  const image = useAnimatedImage(source);
  const ms = (frame / config.fps) * 1000;
  return useDerived(() => (image === null ? null : image.frameAtTime(unwrap(paused) === true ? 0 : ms)));
}

