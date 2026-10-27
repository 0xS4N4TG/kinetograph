// Effect helpers (AUTHORING.md §5.2). Each returns the plain SCENE.md effect
// object; the ones with one required number also take it bare.

import type {
  BackdropBlurEffect,
  BlurEffect,
  BrightnessEffect,
  ChromaticAberrationEffect,
  ColorGradeEffect,
  ColorString,
  ContrastEffect,
  CornerPinEffect,
  DisplaceEffect,
  DitherEffect,
  DotMatrixEffect,
  DropShadowEffect,
  GlowEffect,
  GradientMapEffect,
  GrainEffect,
  GrayscaleEffect,
  HalftoneEffect,
  HueRotateEffect,
  InsetShadowEffect,
  InvertEffect,
  LutEffect,
  Num,
  SaturateEffect,
  SepiaEffect,
  ShaderEffect,
} from './types.js';
import { compact, isFields } from './util.js';

type Fields<E extends { type: string }, Taken extends string = never> = Omit<E, 'type' | Taken>;

/** `blur(24)` or `blur({ radius: 24 })`. */
export function blur(radius: Num | { radius: Num }): BlurEffect {
  return { type: 'blur', ...(isFields(radius) ? compact(radius) : { radius }) } as BlurEffect;
}
export function backdropBlur(radius: Num | { radius: Num }): BackdropBlurEffect {
  return { type: 'backdropBlur', ...(isFields(radius) ? compact(radius) : { radius }) } as BackdropBlurEffect;
}
export function glow(radius: Num | { radius: Num; color?: ColorString; intensity?: Num }): GlowEffect {
  return { type: 'glow', ...(isFields(radius) ? compact(radius) : { radius }) } as GlowEffect;
}
export function chromaticAberration(amount: Num | { amount: Num; angle?: Num }): ChromaticAberrationEffect {
  return {
    type: 'chromaticAberration',
    ...(isFields(amount) ? compact(amount) : { amount }),
  } as ChromaticAberrationEffect;
}
export function dropShadow(fields: Fields<DropShadowEffect> = {}): DropShadowEffect {
  return { type: 'dropShadow', ...compact(fields) };
}
export function insetShadow(fields: Fields<InsetShadowEffect> = {}): InsetShadowEffect {
  return { type: 'insetShadow', ...compact(fields) };
}

/** The colour filters take `amount` bare, as an object, or not at all (SCENE.md's default of 1 then applies). */
function amountOf(amount: Num | { amount: Num } | undefined): { amount?: Num } {
  if (amount === undefined) return {};
  return isFields(amount) ? compact(amount as { amount: Num }) : { amount };
}

export function saturate(amount?: Num | { amount: Num }): SaturateEffect {
  return { type: 'saturate', ...amountOf(amount) };
}
export function contrast(amount?: Num | { amount: Num }): ContrastEffect {
  return { type: 'contrast', ...amountOf(amount) };
}
export function brightness(amount?: Num | { amount: Num }): BrightnessEffect {
  return { type: 'brightness', ...amountOf(amount) };
}
export function grayscale(amount?: Num | { amount: Num }): GrayscaleEffect {
  return { type: 'grayscale', ...amountOf(amount) };
}
export function sepia(amount?: Num | { amount: Num }): SepiaEffect {
  return { type: 'sepia', ...amountOf(amount) };
}
export function invert(amount?: Num | { amount: Num }): InvertEffect {
  return { type: 'invert', ...amountOf(amount) };
}
/** `hueRotate(90)` or `hueRotate({ angle: 90 })`; `angle` is in degrees. */
export function hueRotate(angle?: Num | { angle: Num }): HueRotateEffect {
  if (angle === undefined) return { type: 'hueRotate' };
  return { type: 'hueRotate', ...(isFields(angle) ? compact(angle) : { angle }) } as HueRotateEffect;
}

export function gradientMap(fields: Fields<GradientMapEffect>): GradientMapEffect {
  return { type: 'gradientMap', ...compact(fields) };
}
export function lut(fields: Fields<LutEffect>): LutEffect {
  return { type: 'lut', ...compact(fields) };
}
/** `colorGrade({ effects: { halftone: 0.9, halftoneSize: 0.4 } })`: HyperFrames' colour grade and look effects. */
export function colorGrade(fields: Fields<ColorGradeEffect> = {}): ColorGradeEffect {
  return { type: 'colorGrade', ...compact(fields) };
}
/** `grain(0.15, { seed: 7 })`: the amount first, then the rest. */
export function grain(amount: Num, fields: Fields<GrainEffect, 'amount'>): GrainEffect {
  return { type: 'grain', amount, ...compact(fields) };
}
/** `dither(4, { mode: 'random', seed: 3 })`: the levels first, then the rest. */
export function dither(levels?: Num, fields: Fields<DitherEffect, 'levels'> = {}): DitherEffect {
  return { type: 'dither', ...(levels === undefined ? {} : { levels }), ...compact(fields) };
}
export function halftone(fields: Fields<HalftoneEffect> = {}): HalftoneEffect {
  return { type: 'halftone', ...compact(fields) };
}
export function dotMatrix(fields: Fields<DotMatrixEffect>): DotMatrixEffect {
  return { type: 'dotMatrix', ...compact(fields) };
}
export function displace(fields: Fields<DisplaceEffect>): DisplaceEffect {
  return { type: 'displace', ...compact(fields) };
}
export function cornerPin(fields: Fields<CornerPinEffect> = {}): CornerPinEffect {
  return { type: 'cornerPin', ...compact(fields) };
}
export function shader(fields: Fields<ShaderEffect>): ShaderEffect {
  return { type: 'shader', ...compact(fields) };
}

/** A marker for an `effects` array; the reconciler moves it to the layer's `motionBlur`. */
export interface MotionBlurMarker {
  type: 'motionBlur';
  samples?: number;
  shutter?: Num;
}
export function motionBlur(options: { samples?: number; shutter?: Num } = {}): MotionBlurMarker {
  return { type: 'motionBlur', ...compact(options) };
}
