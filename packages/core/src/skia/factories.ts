// RN-Skia's factories of shaders, colour filters, image filters, mask filters and path effects (`Skia.Shader.*`,
// `Skia.ColorFilter.*`, ...), for a `Skia.Paint()` or a picture. Each object is the declaration node the JSX of the same
// thing makes (`Skia.Shader.MakeLinearGradient(...)` is a `<LinearGradient>`), so the addon draws both the same way;
// an input or an inner filter is the node's child, as nesting does in the JSX.

import { SkMatrix, tileName, type DeclarationNode, type SkDeclaration, type SkPath, type SkPoint, type SkRuntimeEffect } from './objects.js';
import { toColor } from './values.js';

const node = (type: string, props: Record<string, unknown>, children: (SkDeclaration | null | undefined)[] = []): SkDeclaration => {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) if (value !== undefined && value !== null) kept[key] = value;
  const made = children.filter((c): c is SkDeclaration => c !== null && c !== undefined).map((c) => c.toJSON());
  return { toJSON: (): DeclarationNode => ({ type, props: kept, children: made }) };
};

/** `outer` applied to the result of `inner`: the innermost child of `outer` gets `inner` as its child. */
function composed(outer: SkDeclaration, inner: SkDeclaration | null | undefined): SkDeclaration {
  if (!inner) return outer;
  const deepest = (n: DeclarationNode): DeclarationNode =>
    n.children.length === 0 ? { ...n, children: [inner.toJSON()] } : { ...n, children: [...n.children.slice(0, -1), deepest(n.children.at(-1)!)] };
  const made = deepest(outer.toJSON());
  return { toJSON: () => made };
}

const point = (p: SkPoint | number[]): SkPoint => (Array.isArray(p) ? { x: p[0]!, y: p[1]! } : { x: p.x, y: p.y });
const colors = (list: unknown[]): number[][] => list.map(toColor);
const matrix = (m?: SkMatrix | number[] | null): number[] | undefined => (m ? (m instanceof SkMatrix ? m.toJSON() : [...m]) : undefined);
const positions = (p?: ArrayLike<number> | null): number[] | undefined => (p ? Array.from(p) : undefined);

/** RN-Skia's `BlendMode` numbers (`Clear` 0 to `Luminosity` 28), as the names the addon reads. */
const BLEND_MODES = [
  'clear', 'src', 'dst', 'srcOver', 'dstOver', 'srcIn', 'dstIn', 'srcOut', 'dstOut', 'srcATop', 'dstATop', 'xor',
  'plus', 'modulate', 'screen', 'overlay', 'darken', 'lighten', 'colorDodge', 'colorBurn', 'hardLight', 'softLight',
  'difference', 'exclusion', 'multiply', 'hue', 'saturation', 'color', 'luminosity',
];
export const blendName = (mode: unknown): string => (typeof mode === 'number' ? (BLEND_MODES[mode] ?? 'srcOver') : String(mode));

const BLUR_STYLES = ['normal', 'solid', 'outer', 'inner'];
const CHANNELS = ['r', 'g', 'b', 'a'];
const channel = (c: unknown): string => (typeof c === 'number' ? (CHANNELS[c] ?? 'r') : String(c).toLowerCase());

const gradient = (type: string, props: Record<string, unknown>, cs: unknown[], pos: ArrayLike<number> | null | undefined, mode: unknown, local: SkMatrix | null | undefined, flags: number | undefined) =>
  node(type, { ...props, colors: colors(cs), positions: positions(pos), mode: tileName(mode ?? 'clamp'), matrix: matrix(local), flags });

export const ShaderFactory = {
  MakeLinearGradient: (start: SkPoint, end: SkPoint, cs: unknown[], pos?: number[] | null, mode?: unknown, local?: SkMatrix | null, flags?: number) =>
    gradient('LinearGradient', { start: point(start), end: point(end) }, cs, pos, mode, local, flags),
  MakeRadialGradient: (center: SkPoint, r: number, cs: unknown[], pos?: number[] | null, mode?: unknown, local?: SkMatrix | null, flags?: number) =>
    gradient('RadialGradient', { c: point(center), r }, cs, pos, mode, local, flags),
  MakeTwoPointConicalGradient: (
    start: SkPoint, startR: number, end: SkPoint, endR: number, cs: unknown[], pos?: number[] | null, mode?: unknown, local?: SkMatrix | null, flags?: number,
  ) => gradient('TwoPointConicalGradient', { start: point(start), startR, end: point(end), endR }, cs, pos, mode, local, flags),
  MakeSweepGradient: (
    cx: number, cy: number, cs: unknown[], pos?: number[] | null, mode?: unknown, local?: SkMatrix | null, flags?: number, startAngle?: number, endAngle?: number,
  ) => gradient('SweepGradient', { c: { x: cx, y: cy }, start: startAngle, end: endAngle }, cs, pos, mode, local, flags),
  MakeTurbulence: (freqX: number, freqY: number, octaves: number, seed: number, tileWidth: number, tileHeight: number) =>
    node('Turbulence', { freqX, freqY, octaves, seed, tileWidth, tileHeight }),
  MakeFractalNoise: (freqX: number, freqY: number, octaves: number, seed: number, tileWidth: number, tileHeight: number) =>
    node('FractalNoise', { freqX, freqY, octaves, seed, tileWidth, tileHeight }),
  /** `dst` and `src` combined by `mode`. */
  MakeBlend: (mode: unknown, dst: SkDeclaration, src: SkDeclaration) => node('Blend', { mode: blendName(mode) }, [dst, src]),
  MakeColor: (color: unknown) => node('ColorShader', { color: toColor(color) }),
};

export const ColorFilterFactory = {
  /** A 4 x 5 colour matrix, row by row. */
  MakeMatrix: (m: ArrayLike<number>) => node('MatrixColorFilter', { matrix: Array.from(m) }),
  MakeBlend: (color: unknown, mode: unknown) => node('BlendColorFilter', { color: toColor(color), mode: blendName(mode) }),
  /** `outer` applied to what `inner` makes. */
  MakeCompose: (outer: SkDeclaration, inner: SkDeclaration) => composed(outer, inner),
  /** `dst` at 0 to `src` at 1. */
  MakeLerp: (t: number, dst: SkDeclaration, src: SkDeclaration) => node('LerpColorFilter', { t }, [dst, src]),
  MakeLinearToSRGBGamma: () => node('LinearToSRGBGammaColorFilter', {}),
  MakeSRGBToLinearGamma: () => node('SRGBToLinearGammaColorFilter', {}),
  MakeLumaColorFilter: () => node('LumaColorFilter', {}),
};

/** The shader an image filter of a shader holds (what `MakeDisplacementMap` displaces by). */
function shaderOf(filter: SkDeclaration | null | undefined): SkDeclaration | null {
  const made = filter?.toJSON();
  if (made?.type !== 'ShaderImageFilter' || !made.children[0]) return null;
  const shader = made.children[0];
  return { toJSON: () => shader };
}

/** `Skia.RuntimeShaderBuilder(effect)`: the effect with its uniforms set one by one, for `MakeRuntimeShader`. */
export class SkRuntimeShaderBuilder {
  readonly uniforms: Record<string, number[]> = {};
  constructor(readonly effect: SkRuntimeEffect) {}
  setUniform(name: string, value: ArrayLike<number> | number): void {
    this.uniforms[name] = typeof value === 'number' ? [value] : Array.from(value);
  }
  getEffect(): SkRuntimeEffect {
    return this.effect;
  }
}

export const ImageFilterFactory = {
  MakeBlur: (sigmaX: number, sigmaY: number, mode: unknown, input?: SkDeclaration | null) =>
    node('BlurImageFilter', { blur: { x: sigmaX, y: sigmaY }, mode: tileName(mode ?? 'decal') }, [input]),
  MakeOffset: (dx: number, dy: number, input?: SkDeclaration | null) => node('OffsetImageFilter', { x: dx, y: dy }, [input]),
  /** The addon blurs a shadow by one sigma: `sigmaX` (RN-Skia's `<Shadow>` has one `blur` too). */
  MakeDropShadow: (dx: number, dy: number, sigmaX: number, _sigmaY: number, color: unknown, input?: SkDeclaration | null) =>
    node('DropShadowImageFilter', { dx, dy, blur: sigmaX, color: toColor(color) }, [input]),
  MakeDropShadowOnly: (dx: number, dy: number, sigmaX: number, _sigmaY: number, color: unknown, input?: SkDeclaration | null) =>
    node('DropShadowImageFilter', { dx, dy, blur: sigmaX, color: toColor(color), shadowOnly: true }, [input]),
  MakeErode: (rx: number, ry: number, input?: SkDeclaration | null) =>
    node('MorphologyImageFilter', { radius: { x: rx, y: ry }, operator: 'erode' }, [input]),
  MakeDilate: (rx: number, ry: number, input?: SkDeclaration | null) =>
    node('MorphologyImageFilter', { radius: { x: rx, y: ry }, operator: 'dilate' }, [input]),
  MakeColorFilter: (filter: SkDeclaration, input?: SkDeclaration | null) => node('ColorFilterImageFilter', {}, [filter, input]),
  MakeShader: (shader: SkDeclaration) => node('ShaderImageFilter', {}, [shader]),
  /** `outer` applied to what `inner` makes. */
  MakeCompose: (outer: SkDeclaration, inner: SkDeclaration) => composed(outer, inner),
  MakeBlend: (mode: unknown, background: SkDeclaration, foreground?: SkDeclaration | null) =>
    node('BlendImageFilter', { mode: blendName(mode) }, [background, foreground]),
  /** What is drawn, moved by the channels of `displacement` (an image filter of a shader, `MakeShader`). */
  MakeDisplacementMap: (channelX: unknown, channelY: unknown, scale: number, displacement: SkDeclaration, input?: SkDeclaration | null) => {
    const shader = shaderOf(displacement);
    if (shader === null) throw new Error('Skia.ImageFilter.MakeDisplacementMap needs the displacement as Skia.ImageFilter.MakeShader(shader)');
    return node('DisplacementMapImageFilter', { channelX: channel(channelX), channelY: channel(channelY), scale }, [shader, input]);
  },
  MakeRuntimeShader: (builder: SkRuntimeShaderBuilder, _childName?: string | null, input?: SkDeclaration | null) =>
    node('RuntimeShaderImageFilter', { source: builder.effect.toJSON(), uniforms: { ...builder.uniforms } }, [input]),
};

export const MaskFilterFactory = {
  MakeBlur: (style: unknown, sigma: number, respectCTM = true) =>
    node('BlurMaskFilter', { style: typeof style === 'number' ? (BLUR_STYLES[style] ?? 'normal') : style, blur: sigma, respectCTM }),
};

const PATH_1D_STYLES = ['translate', 'rotate', 'morph'];

export const PathEffectFactory = {
  MakeCorner: (r: number) => node('CornerPathEffect', { r }),
  MakeDash: (intervals: ArrayLike<number>, phase = 0) => node('DashPathEffect', { intervals: Array.from(intervals), phase }),
  MakeDiscrete: (length: number, deviation: number, seed = 0) => node('DiscretePathEffect', { length, deviation, seed }),
  /** `outer` applied to the path `inner` makes. */
  MakeCompose: (outer: SkDeclaration, inner: SkDeclaration) => composed(outer, inner),
  /** Both effects, each drawn. */
  MakeSum: (first: SkDeclaration, second: SkDeclaration) => node('SumPathEffect', {}, [first, second]),
  MakeLine2D: (width: number, m: SkMatrix) => node('Line2DPathEffect', { width, matrix: matrix(m) }),
  MakePath1D: (path: SkPath, advance: number, phase: number, style: unknown) =>
    node('Path1DPathEffect', { path: path.toJSON(), advance, phase, style: typeof style === 'number' ? PATH_1D_STYLES[style] : style }),
  MakePath2D: (m: SkMatrix, path: SkPath) => node('Path2DPathEffect', { matrix: matrix(m), path: path.toJSON() }),
};
