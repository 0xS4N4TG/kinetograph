// `@remotion/lottie` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5): the native <Lottie> element, and `getLottieMetadata`.

export { Lottie } from '@kinetograph/react';
export type { LottieProps } from '@kinetograph/react';

/** The parsed JSON of a Lottie animation: the fields `getLottieMetadata` reads, and whatever else the file has. */
export type LottieAnimationData = {
  /** Frames per second. */
  fr: number;
  /** Width. */
  w: number;
  /** Height. */
  h: number;
  /** The frame the animation ends at. */
  op: number;
} & Record<string | number | symbol, unknown>;

export interface LottieMetadata {
  fps: number;
  durationInSeconds: number;
  durationInFrames: number;
  width: number;
  height: number;
}

/** The size, frame rate and length of a Lottie animation, or null if the file lacks one of them (or has it as 0). */
export function getLottieMetadata(animationData: LottieAnimationData): LottieMetadata | null {
  const { w: width, h: height, fr: fps, op: end } = animationData;
  if (![width, height, fps, end].every(Boolean)) return null;
  return { durationInFrames: Math.floor(end), durationInSeconds: end / fps, fps, height, width };
}
