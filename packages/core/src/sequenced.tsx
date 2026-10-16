// What Remotion's Studio-aware components share (`<Track>`, `<Interactive.*>`, `<Solid>`, `<CanvasImage>`,
// `<AnimatedImage>`, `<HtmlInCanvas>`): the timing props of a `<Sequence>` and the four crop props. Each is a
// `<Sequence layout="none">` around the element, so it shows from `from` for `durationInFrames` and moves time by `from`.
//
// A render never premounts (Remotion's `premountFor` and its styles only act in the preview) and shows no timeline, so
// those props are accepted and left alone. `trimBefore`, `playbackRate` and `loop` change the clock of what is inside,
// which `<Sequence>` here does not do yet; they are accepted and a warning says they are not applied.

import type { CSSProperties, ReactNode } from 'react';
import { warnOnce } from './warn.js';
import { Freeze, Sequence } from './timeline.js';

export interface SequenceTimingProps {
  durationInFrames?: number;
  from?: number;
  trimBefore?: number;
  playbackRate?: number;
  loop?: boolean;
  /** Shows the content as it is at this frame of the sequence, whatever frame it really is. */
  freeze?: number | null;
  hidden?: boolean;
  name?: string;
  showInTimeline?: boolean;
  premountFor?: number;
  postmountFor?: number;
  styleWhilePremounted?: CSSProperties;
  styleWhilePostmounted?: CSSProperties;
}

export interface CropProps {
  /** Fractions of the element, 0 to 1, cut from each side. */
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
}

/** The names of `SequenceTimingProps`, to take them out of a component's props. */
export const TIMING_KEYS = [
  'durationInFrames',
  'from',
  'trimBefore',
  'playbackRate',
  'loop',
  'freeze',
  'hidden',
  'name',
  'showInTimeline',
  'premountFor',
  'postmountFor',
  'styleWhilePremounted',
  'styleWhilePostmounted',
] as const satisfies readonly (keyof SequenceTimingProps)[];

/** The names of `CropProps`. */
export const CROP_KEYS = ['cropLeft', 'cropRight', 'cropTop', 'cropBottom'] as const satisfies readonly (keyof CropProps)[];

function split(props: object, keys: readonly string[]): [Record<string, unknown>, Record<string, unknown>] {
  const picked: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...props };
  for (const key of keys) {
    if (key in rest) {
      picked[key] = rest[key];
      delete rest[key];
    }
  }
  return [picked, rest];
}

/** Splits `props` into the timing props and the rest. */
export function splitTiming<P extends SequenceTimingProps>(props: P): [SequenceTimingProps, Omit<P, (typeof TIMING_KEYS)[number]>] {
  const [timing, rest] = split(props, TIMING_KEYS);
  return [timing, rest as Omit<P, (typeof TIMING_KEYS)[number]>];
}

/** Splits `props` into the crop props and the rest. */
export function splitCrop<P extends CropProps>(props: P): [CropProps, Omit<P, (typeof CROP_KEYS)[number]>] {
  const [crop, rest] = split(props, CROP_KEYS);
  return [crop, rest as Omit<P, (typeof CROP_KEYS)[number]>];
}

/** Shows `children` for the timing `props`; `defaultName` is what the Studio would label it with. */
export function Sequenced({
  timing,
  component,
  defaultName,
  children,
}: {
  timing: SequenceTimingProps;
  component: string;
  defaultName: string;
  children: ReactNode;
}): ReactNode {
  const { from, durationInFrames, name, freeze, hidden, trimBefore, playbackRate, loop } = timing;
  if (trimBefore !== undefined && trimBefore !== 0) warnOnce(`${component}.trimBefore`, `${component} ignores trimBefore: <Sequence> does not trim yet.`);
  if (playbackRate !== undefined && playbackRate !== 1) warnOnce(`${component}.playbackRate`, `${component} ignores playbackRate: <Sequence> does not change speed yet.`);
  if (loop) warnOnce(`${component}.loop`, `${component} ignores loop: <Sequence> does not loop yet (use <Loop>).`);
  if (hidden) return null;
  const content = freeze === undefined || freeze === null ? children : <Freeze frame={freeze}>{children}</Freeze>;
  return (
    <Sequence layout="none" from={from} durationInFrames={durationInFrames} name={name ?? defaultName}>
      {content}
    </Sequence>
  );
}

function clampCrop(value: number | undefined): number {
  return Math.min(1, Math.max(0, value ?? 0));
}

/** One axis: each side clamped to 0..1, and two sides that together cut more than all of it split it evenly. */
function axis(start: number | undefined, end: number | undefined): [number, number] {
  const a = clampCrop(start);
  const b = clampCrop(end);
  return a + b > 1 ? [0.5, 0.5] : [a, b];
}

function radiusText(radius: string | number | undefined): string | undefined {
  return typeof radius === 'number' ? `${radius}px` : radius;
}

/**
 * `style` with the crop applied as a `clip-path: inset(…)`, which keeps the element's `border-radius` as a rounded
 * clip. The style itself when nothing is cropped. A crop must be a finite number of at most 1 (a fraction, not a
 * percentage).
 */
export function croppedStyle(component: string, crop: CropProps, style: CSSProperties | undefined): CSSProperties | undefined {
  for (const [key, value] of Object.entries(crop)) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`The "${key}" prop of ${component} must be a finite number, but got ${String(value)}.`);
    }
    if (value > 100) {
      throw new RangeError(`The "${key}" prop of ${component} must be between 0 and 1, but got ${value}. The crop range is 0 to 1, not 0 to 100.`);
    }
  }
  const [left, right] = axis(crop.cropLeft, crop.cropRight);
  const [top, bottom] = axis(crop.cropTop, crop.cropBottom);
  if (left === 0 && right === 0 && top === 0 && bottom === 0) return style;
  const corners = [style?.borderTopLeftRadius, style?.borderTopRightRadius, style?.borderBottomRightRadius, style?.borderBottomLeftRadius];
  const radius =
    radiusText(style?.borderRadius) ||
    (corners.some((corner) => corner !== undefined) ? corners.map((corner) => radiusText(corner) ?? '0px').join(' ') : undefined);
  const rounded = radius ? ` round ${radius}` : '';
  return { ...style, clipPath: `inset(${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%${rounded})` };
}
