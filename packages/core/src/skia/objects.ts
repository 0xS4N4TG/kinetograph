// The objects `Skia.*` makes and the hooks hand out, as far as a render needs them: each keeps plain data and
// serialises itself (`toJSON`) into the prop of a node. Geometry that needs Skia (boolean ops, bounds, trimming) asks
// the addon.

import { getDomEnvironment, resolveProjectFile } from '@kinetographdev/compat/dom';
import { fontKey } from '@kinetographdev/scene';
import { getFallbackFont, getFonts } from '../font-registry.js';
import { skiaAddon } from './addon.js';
import { plain, toColor, type SkColor } from './values.js';

export interface SkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SkPoint {
  x: number;
  y: number;
}
export interface SkRRect {
  rect: SkRect;
  rx: number;
  ry: number;
}

// ---- enums: RN-Skia's, as the strings the props take ----

export const BlendMode = {
  Clear: 'clear', Src: 'src', Dst: 'dst', SrcOver: 'srcOver', DstOver: 'dstOver', SrcIn: 'srcIn', DstIn: 'dstIn',
  SrcOut: 'srcOut', DstOut: 'dstOut', SrcATop: 'srcATop', DstATop: 'dstATop', Xor: 'xor', Plus: 'plus',
  Modulate: 'modulate', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten',
  ColorDodge: 'colorDodge', ColorBurn: 'colorBurn', HardLight: 'hardLight', SoftLight: 'softLight',
  Difference: 'difference', Exclusion: 'exclusion', Multiply: 'multiply', Hue: 'hue', Saturation: 'saturation',
  Color: 'color', Luminosity: 'luminosity',
} as const;
export const TileMode = { Clamp: 'clamp', Repeat: 'repeat', Mirror: 'mirror', Decal: 'decal' } as const;
export const PaintStyle = { Fill: 'fill', Stroke: 'stroke' } as const;
export const StrokeCap = { Butt: 'butt', Round: 'round', Square: 'square' } as const;
export const StrokeJoin = { Miter: 'miter', Round: 'round', Bevel: 'bevel' } as const;
export const BlurStyle = { Normal: 'normal', Solid: 'solid', Outer: 'outer', Inner: 'inner' } as const;
export const PathOp = {
  Difference: 'difference', Intersect: 'intersect', Union: 'union', XOR: 'xor', ReverseDifference: 'reverseDifference',
} as const;
export const FillType = { Winding: 'winding', EvenOdd: 'evenOdd', InverseWinding: 'inverseWinding', InverseEvenOdd: 'inverseEvenOdd' } as const;

type FillTypeName = (typeof FillType)[keyof typeof FillType];

// ---- matrices ----

/** A 3 x 3 matrix, row by row (`scaleX, skewX, transX, skewY, scaleY, transY, p0, p1, p2`), as RN-Skia's `Matrix` objects. */
export class SkMatrix {
  constructor(private m: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {}

  get(): number[] {
    return [...this.m];
  }

  identity(): this {
    this.m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return this;
  }

  /** `this = this x other`. */
  private concat(o: number[]): this {
    const a = this.m;
    const out = new Array<number>(9);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        out[row * 3 + col] = a[row * 3]! * o[col]! + a[row * 3 + 1]! * o[3 + col]! + a[row * 3 + 2]! * o[6 + col]!;
      }
    }
    this.m = out;
    return this;
  }

  translate(x: number, y: number): this {
    return this.concat([1, 0, x, 0, 1, y, 0, 0, 1]);
  }

  scale(x: number, y = x): this {
    return this.concat([x, 0, 0, 0, y, 0, 0, 0, 1]);
  }

  rotate(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this.concat([c, -s, 0, s, c, 0, 0, 0, 1]);
  }

  skew(x: number, y: number): this {
    return this.concat([1, x, 0, y, 1, 0, 0, 0, 1]);
  }

  postConcat(other: SkMatrix | number[]): this {
    return this.concat(other instanceof SkMatrix ? other.m : other);
  }

  toJSON(): number[] {
    return this.m;
  }
}

// ---- paths ----

/** A path as SVG data with the operations on it: built here, measured and combined by Skia in the addon. */
export class SkPath {
  private d = '';
  private fill: FillTypeName = 'winding';
  private cx = 0;
  private cy = 0;

  static fromSvg(d: string): SkPath {
    const path = new SkPath();
    path.d = d;
    return path;
  }

  private append(command: string, x?: number, y?: number): this {
    this.d += (this.d === '' ? '' : ' ') + command;
    if (x !== undefined && y !== undefined) {
      this.cx = x;
      this.cy = y;
    }
    return this;
  }

  private call(call: string, extra: Record<string, unknown> = {}): { d: string; fillType: FillTypeName; bounds: SkRect } {
    return JSON.parse(skiaAddon().pathCall(JSON.stringify({ call, path: this.toJSON(), ...extra })));
  }

  /** Replaces this path with the result of a call that answers a path. */
  private become(result: { d: string; fillType: FillTypeName }): this {
    this.d = result.d;
    this.fill = result.fillType;
    return this;
  }

  moveTo(x: number, y: number): this {
    return this.append(`M${x} ${y}`, x, y);
  }
  lineTo(x: number, y: number): this {
    return this.append(`L${x} ${y}`, x, y);
  }
  quadTo(x1: number, y1: number, x2: number, y2: number): this {
    return this.append(`Q${x1} ${y1} ${x2} ${y2}`, x2, y2);
  }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    return this.append(`C${x1} ${y1} ${x2} ${y2} ${x3} ${y3}`, x3, y3);
  }
  rMoveTo(dx: number, dy: number): this {
    return this.moveTo(this.cx + dx, this.cy + dy);
  }
  rLineTo(dx: number, dy: number): this {
    return this.lineTo(this.cx + dx, this.cy + dy);
  }
  rQuadTo(dx1: number, dy1: number, dx2: number, dy2: number): this {
    const { cx, cy } = this;
    return this.quadTo(cx + dx1, cy + dy1, cx + dx2, cy + dy2);
  }
  rCubicTo(dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number): this {
    const { cx, cy } = this;
    return this.cubicTo(cx + dx1, cy + dy1, cx + dx2, cy + dy2, cx + dx3, cy + dy3);
  }
  close(): this {
    return this.append('Z');
  }

  /** An elliptical arc to (x, y) with the SVG arc's flags: `useSmallArc`, and `isCCW` for the sweep. */
  arcToRotated(rx: number, ry: number, xAxisRotate: number, useSmallArc: boolean, isCCW: boolean, x: number, y: number): this {
    return this.append(`A${rx} ${ry} ${xAxisRotate} ${useSmallArc ? 0 : 1} ${isCCW ? 0 : 1} ${x} ${y}`, x, y);
  }

  /** The arc of the oval from `startAngle` through `sweepAngle` (degrees), joined to the last point by a line unless `forceMoveTo`. */
  arcToOval(oval: SkRect, startAngle: number, sweepAngle: number, forceMoveTo: boolean): this {
    const rx = oval.width / 2;
    const ry = oval.height / 2;
    const centre = { x: oval.x + rx, y: oval.y + ry };
    const at = (degrees: number): [number, number] => [
      centre.x + rx * Math.cos((degrees * Math.PI) / 180),
      centre.y + ry * Math.sin((degrees * Math.PI) / 180),
    ];
    const [sx, sy] = at(startAngle);
    if (forceMoveTo || this.d === '') this.moveTo(sx, sy);
    else this.lineTo(sx, sy);
    // An arc of a full turn or more is two halves: SVG cannot draw the whole ellipse in one arc.
    let swept = 0;
    const total = Math.max(-360, Math.min(360, sweepAngle));
    while (Math.abs(total - swept) > 1e-9) {
      const step = Math.sign(total) * Math.min(180, Math.abs(total - swept));
      const [x, y] = at(startAngle + swept + step);
      this.append(`A${rx} ${ry} 0 ${Math.abs(step) > 180 ? 1 : 0} ${step > 0 ? 1 : 0} ${x} ${y}`, x, y);
      swept += step;
    }
    return this;
  }

  addArc(oval: SkRect, startAngle: number, sweepAngle: number): this {
    return this.arcToOval(oval, startAngle, sweepAngle, true);
  }

  addRect(rect: SkRect): this {
    const { x, y, width, height } = rect;
    return this.moveTo(x, y).lineTo(x + width, y).lineTo(x + width, y + height).lineTo(x, y + height).close();
  }

  addOval(oval: SkRect): this {
    const rx = oval.width / 2;
    const ry = oval.height / 2;
    const cy = oval.y + ry;
    return this.moveTo(oval.x, cy)
      .arcToRotated(rx, ry, 0, true, false, oval.x + oval.width, cy)
      .arcToRotated(rx, ry, 0, true, false, oval.x, cy)
      .close();
  }

  addCircle(x: number, y: number, r: number): this {
    return this.addOval({ x: x - r, y: y - r, width: 2 * r, height: 2 * r });
  }

  addRRect(rrect: SkRRect): this {
    const { rect: { x, y, width, height }, rx, ry } = rrect;
    const right = x + width;
    const bottom = y + height;
    return this.moveTo(x + rx, y)
      .lineTo(right - rx, y)
      .arcToRotated(rx, ry, 0, true, false, right, y + ry)
      .lineTo(right, bottom - ry)
      .arcToRotated(rx, ry, 0, true, false, right - rx, bottom)
      .lineTo(x + rx, bottom)
      .arcToRotated(rx, ry, 0, true, false, x, bottom - ry)
      .lineTo(x, y + ry)
      .arcToRotated(rx, ry, 0, true, false, x + rx, y)
      .close();
  }

  addPath(other: SkPath, matrix?: SkMatrix): this {
    const added = matrix ? other.copy().transform(matrix) : other;
    return this.append(added.d);
  }

  copy(): SkPath {
    const path = SkPath.fromSvg(this.d);
    path.fill = this.fill;
    path.cx = this.cx;
    path.cy = this.cy;
    return path;
  }

  reset(): this {
    this.d = '';
    return this;
  }

  isEmpty(): boolean {
    return this.d === '';
  }

  setFillType(type: FillTypeName): this {
    this.fill = type;
    return this;
  }
  getFillType(): FillTypeName {
    return this.fill;
  }

  transform(matrix: SkMatrix): this {
    return this.become(this.call('transform', { matrix: matrix.toJSON() }));
  }

  simplify(): this {
    return this.become(this.call('simplify'));
  }

  /** Skia's `interpolate`: `weight` 1 is this path, 0 is `end`; null when the two do not have the same verbs and points. */
  interpolate(end: SkPath, weight: number): SkPath | null {
    if (!this.isInterpolatable(end)) return null;
    const made = this.call('interpolate', { other: end.toJSON(), weight });
    const path = SkPath.fromSvg(made.d);
    path.fill = made.fillType;
    return path;
  }

  isInterpolatable(other: SkPath): boolean {
    return JSON.parse(skiaAddon().pathCall(JSON.stringify({ call: 'interpolatable', path: this.toJSON(), other: other.toJSON() }))).interpolatable;
  }

  /** Combines with `other` by `op`, in place. */
  op(other: SkPath, op: (typeof PathOp)[keyof typeof PathOp]): this {
    return this.become(this.call('op', { other: other.toJSON(), op }));
  }

  /** The part from `start` to `end` of the length, each 0 to 1 (`isComplement` keeps the rest). */
  trim(start: number, end: number, isComplement: boolean): this {
    return this.become(this.call('trim', { start, end, complement: isComplement }));
  }

  dash(on: number, off: number, phase: number): this {
    return this.become(this.call('dash', { on, off, phase }));
  }

  /** The outline of the path stroked with `options`, in place. */
  stroke(options: { width?: number; miter_limit?: number; join?: string; cap?: string } = {}): this {
    return this.become(this.call('stroke', { width: options.width, miter: options.miter_limit, join: options.join, cap: options.cap }));
  }

  getBounds(): SkRect {
    return this.call('bounds').bounds;
  }
  computeTightBounds(): SkRect {
    return this.call('bounds').bounds;
  }

  contains(x: number, y: number): boolean {
    return JSON.parse(skiaAddon().pathCall(JSON.stringify({ call: 'contains', path: this.toJSON(), point: { x, y } }))).contains;
  }

  toSVGString(): string {
    return this.d;
  }

  toJSON(): { d: string; fillType: FillTypeName } {
    return { d: this.d, fillType: this.fill };
  }
}

// ---- paints ----

/** A shader, colour filter, image filter, mask filter or path effect made with `Skia.*`: the declaration node it is. */
export interface SkDeclaration {
  toJSON(): DeclarationNode;
}
export interface DeclarationNode {
  type: string;
  props: Record<string, unknown>;
  children: DeclarationNode[];
}

/** `Skia.Paint()`: the paint props of a `<Paint>` node; a shader or filter set on it is a child of the node. */
export class SkPaint {
  private props: Record<string, unknown> = {};
  private rgba: [number, number, number, number] = [0, 0, 0, 1];
  private declared: Partial<Record<'shader' | 'colorFilter' | 'imageFilter' | 'maskFilter' | 'pathEffect', SkDeclaration | null>> = {};

  /** A paint with the same props and declarations. */
  copy(): SkPaint {
    const paint = new SkPaint();
    paint.props = { ...this.props };
    paint.rgba = [...this.rgba];
    paint.declared = { ...this.declared };
    return paint;
  }
  reset(): void {
    this.props = {};
    this.rgba = [0, 0, 0, 1];
    this.declared = {};
  }
  getColor(): Float32Array {
    return Float32Array.from(this.rgba);
  }
  getAlphaf(): number {
    return this.rgba[3];
  }
  getStrokeWidth(): number {
    return (this.props.strokeWidth as number | undefined) ?? 0;
  }
  getStrokeMiter(): number {
    return (this.props.strokeMiter as number | undefined) ?? 4;
  }
  setShader(shader: SkDeclaration | null): this {
    this.declared.shader = shader;
    return this;
  }
  setColorFilter(filter: SkDeclaration | null): this {
    this.declared.colorFilter = filter;
    return this;
  }
  setImageFilter(filter: SkDeclaration | null): this {
    this.declared.imageFilter = filter;
    return this;
  }
  setMaskFilter(filter: SkDeclaration | null): this {
    this.declared.maskFilter = filter;
    return this;
  }
  setPathEffect(effect: SkDeclaration | null): this {
    this.declared.pathEffect = effect;
    return this;
  }

  setColor(color: SkColor): this {
    this.rgba = toColor(color);
    this.props.color = this.rgba;
    return this;
  }
  setAlphaf(alpha: number): this {
    this.rgba = [this.rgba[0], this.rgba[1], this.rgba[2], alpha];
    this.props.color = this.rgba;
    return this;
  }
  setStrokeWidth(width: number): this {
    this.props.strokeWidth = width;
    return this;
  }
  setStyle(style: (typeof PaintStyle)[keyof typeof PaintStyle]): this {
    this.props.style = style;
    return this;
  }
  setStrokeCap(cap: (typeof StrokeCap)[keyof typeof StrokeCap]): this {
    this.props.strokeCap = cap;
    return this;
  }
  setStrokeJoin(join: (typeof StrokeJoin)[keyof typeof StrokeJoin]): this {
    this.props.strokeJoin = join;
    return this;
  }
  setStrokeMiter(miter: number): this {
    this.props.strokeMiter = miter;
    return this;
  }
  setBlendMode(mode: (typeof BlendMode)[keyof typeof BlendMode]): this {
    this.props.blendMode = mode;
    return this;
  }
  setAntiAlias(on: boolean): this {
    this.props.antiAlias = on;
    return this;
  }
  setDither(on: boolean): this {
    this.props.dither = on;
    return this;
  }

  toJSON(): { type: 'Paint'; props: Record<string, unknown>; children: DeclarationNode[] } {
    const children = Object.values(this.declared)
      .filter((d): d is SkDeclaration => d !== null && d !== undefined)
      .map((d) => d.toJSON());
    return { type: 'Paint', props: this.props, children };
  }
}

// ---- pictures, fonts, effects ----

/**
 * A picture: a file (`{ src }`), encoded bytes (`{ data }`), raw pixels (`{ pixels, ... }`), a frame of an animated
 * one (`frame`/`time`), a surface's snapshot (`{ picture, width, height }`) or a drawn element (`{ nodes, ... }`); the
 * addon makes it when it is drawn (crates/skia/render/src/draw.rs `image_of`).
 */
export class SkImage {
  constructor(
    private readonly source: Record<string, unknown>,
    private readonly size: { width: number; height: number },
  ) {}
  /** The file of a picture read from one. */
  get src(): string | undefined {
    return typeof this.source.src === 'string' ? this.source.src : undefined;
  }
  width(): number {
    return this.size.width;
  }
  height(): number {
    return this.size.height;
  }
  getImageInfo(): { width: number; height: number; colorType: number; alphaType: number } {
    return { width: this.size.width, height: this.size.height, colorType: 4, alphaType: 3 };
  }
  private bytes(format: 'rgba' | 'png'): Uint8Array {
    return new Uint8Array(skiaAddon().imageBytes(JSON.stringify({ image: this.toJSON(), format, baseDir: getDomEnvironment().baseDir ?? '' })));
  }
  /** The pixels, RGBA with straight alpha, row after row; `srcX`, `srcY` and `imageInfo` choose a part of them. */
  readPixels(srcX = 0, srcY = 0, imageInfo?: { width: number; height: number }): Uint8Array {
    const all = this.bytes('rgba');
    const { width, height } = this.size;
    const w = Math.max(0, Math.min(imageInfo?.width ?? width, width - srcX));
    const h = Math.max(0, Math.min(imageInfo?.height ?? height, height - srcY));
    if (srcX === 0 && srcY === 0 && w === width && h === height) return all;
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row += 1) {
      const from = ((srcY + row) * width + srcX) * 4;
      out.set(all.subarray(from, from + w * 4), row * w * 4);
    }
    return out;
  }
  /** The picture as a PNG (the format RN-Skia uses by default). */
  encodeToBytes(): Uint8Array {
    return this.bytes('png');
  }
  encodeToBase64(): string {
    return Buffer.from(this.encodeToBytes()).toString('base64');
  }
  /** Every picture here is in memory already. */
  makeNonTextureImage(): SkImage {
    return this;
  }
  /** An image shader of this picture: `makeShaderOptions(tx, ty, filterMode, mipmapMode, localMatrix?)`. */
  makeShaderOptions(tx: string, ty: string, filter: unknown, mipmap: unknown, localMatrix?: SkMatrix): SkDeclaration {
    return imageShader(this, tx, ty, { filter: filterName(filter), mipmap: mipmapName(mipmap) }, localMatrix);
  }
  /** An image shader of this picture with cubic sampling `B`, `C`. */
  makeShaderCubic(tx: string, ty: string, B: number, C: number, localMatrix?: SkMatrix): SkDeclaration {
    return imageShader(this, tx, ty, { B, C }, localMatrix);
  }
  toJSON(): Record<string, unknown> {
    return this.source;
  }
}

/** RN-Skia's `FilterMode` and `MipmapMode` as the strings the addon reads (their numbers are accepted too). */
export const FilterMode = { Nearest: 'nearest', Linear: 'linear' } as const;
export const MipmapMode = { None: 'none', Nearest: 'nearest', Linear: 'linear' } as const;
const filterName = (f: unknown): string => (f === 0 || f === 'nearest' ? 'nearest' : 'linear');
const mipmapName = (m: unknown): string => (m === 1 || m === 'nearest' ? 'nearest' : m === 2 || m === 'linear' ? 'linear' : 'none');

function imageShader(image: SkImage, tx: string, ty: string, sampling: Record<string, unknown>, localMatrix?: SkMatrix): SkDeclaration {
  const props: Record<string, unknown> = { image: image.toJSON(), tx: tileName(tx), ty: tileName(ty), sampling };
  if (localMatrix) props.matrix = localMatrix.toJSON();
  return { toJSON: () => ({ type: 'ImageShader', props, children: [] }) };
}

/** RN-Skia's `TileMode` names; its numbers (`Clamp` 0 to `Decal` 3) are accepted too. */
export function tileName(mode: unknown): string {
  if (typeof mode === 'number') return ['clamp', 'repeat', 'mirror', 'decal'][mode] ?? 'clamp';
  return typeof mode === 'string' ? mode : 'clamp';
}

export interface FontMetrics {
  ascent: number;
  descent: number;
  leading: number;
}

/** Where a typeface comes from: a font file, or font bytes kept with `Skia.Data`. */
export type FontFace = { file: string } | { data: string };

/** A typeface: `Skia.Typeface.MakeFreeTypeFaceFromData`, or a registered font (`Skia.FontMgr.System().matchFamilyStyle`). */
export class SkTypeface {
  constructor(
    readonly face: FontFace,
    readonly familyName = '',
  ) {}
  getFamilyName(): string {
    return this.familyName;
  }
  toJSON(): FontFace {
    return this.face;
  }
}

/** A font file (or font data) at a size. */
export class SkFont {
  readonly face: FontFace;
  constructor(
    face: string | FontFace,
    private size: number,
  ) {
    this.face = typeof face === 'string' ? { file: face } : face;
  }
  /** The font file, for a font read from one. */
  get file(): string | undefined {
    return 'file' in this.face ? this.face.file : undefined;
  }
  getTypeface(): SkTypeface {
    return new SkTypeface(this.face);
  }

  private measured(text: string) {
    return JSON.parse(
      skiaAddon().measureText(JSON.stringify({ font: this.toJSON(), text, baseDir: getDomEnvironment().baseDir ?? '' })),
    ) as { width: number; bounds: [number, number, number, number]; metrics: FontMetrics; glyphIds: number[]; glyphWidths: number[] };
  }

  getSize(): number {
    return this.size;
  }
  setSize(size: number): void {
    this.size = size;
  }
  measureText(text: string): SkRect & { width: number } {
    const { bounds: [x, y, width, height] } = this.measured(text);
    return { x, y, width, height };
  }
  getTextWidth(text: string): number {
    return this.measured(text).width;
  }
  getGlyphIDs(text: string): number[] {
    return this.measured(text).glyphIds;
  }
  getGlyphWidths(text: string): number[] {
    return this.measured(text).glyphWidths;
  }
  getMetrics(): FontMetrics {
    return this.measured('').metrics;
  }
  toJSON(): FontFace & { size: number } {
    return { ...this.face, size: this.size };
  }
}

/** The result of `Skia.RuntimeEffect.Make`. */
export class SkRuntimeEffect {
  constructor(
    readonly sksl: string,
    private readonly info: { uniforms: [string, number][]; children: string[] },
  ) {}
  getUniformCount(): number {
    return this.info.uniforms.length;
  }
  getUniformFloatCount(): number {
    return this.info.uniforms.reduce((sum, [, floats]) => sum + floats, 0);
  }
  getUniformName(index: number): string {
    return this.info.uniforms[index]![0];
  }
  /** The flat list of uniform floats, in the order the SkSL declares them, as the named values a `<Shader>` takes. */
  namedUniforms(values: ArrayLike<number>): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    let at = 0;
    for (const [name, floats] of this.info.uniforms) {
      out[name] = Array.from({ length: floats }, (_, i) => Number(values[at + i] ?? 0));
      at += floats;
    }
    return out;
  }
  /** `effect.makeShader(uniforms, localMatrix?)`: the effect as a shader. */
  makeShader(uniforms: ArrayLike<number> = [], localMatrix?: SkMatrix): SkDeclaration {
    return this.makeShaderWithChildren(uniforms, [], localMatrix);
  }
  /** `effect.makeShaderWithChildren(uniforms, children, localMatrix?)`: with the child shaders the SkSL names. */
  makeShaderWithChildren(uniforms: ArrayLike<number>, children: SkDeclaration[], localMatrix?: SkMatrix): SkDeclaration {
    const props: Record<string, unknown> = { source: this.toJSON(), uniforms: this.namedUniforms(uniforms) };
    if (localMatrix) props.matrix = localMatrix.toJSON();
    return { toJSON: () => ({ type: 'Shader', props, children: children.map((c) => c.toJSON()) }) };
  }
  toJSON(): { sksl: string } {
    return { sksl: this.sksl };
  }
}

// ---- text blobs, pictures, SVGs ----

/** A rotation/scale/translation in four numbers, as RN-Skia's `Skia.RSXform`: the matrix `[scos -ssin tx; ssin scos ty]`. */
export interface SkRSXform {
  scos: number;
  ssin: number;
  tx: number;
  ty: number;
}

/** `Skia.TextBlob.Make*`: the glyphs of a text (or the glyph ids) in a font, laid out by its advances or by one transform each. */
export class SkTextBlob {
  constructor(
    private readonly shape: { text?: string; glyphs?: number[]; xforms?: SkRSXform[] },
    private readonly font: SkFont,
  ) {}
  toJSON(): Record<string, unknown> {
    return { ...this.shape, font: this.font.toJSON() };
  }
}

export const PointMode = { Points: 'points', Lines: 'lines', Polygon: 'polygon' } as const;
export const ClipOp = { Difference: 'difference', Intersect: 'intersect' } as const;

/** What is kept of an argument when it is recorded, so that changing a paint or a path afterwards does not change the picture. */
const snapshot = <T,>(value: T): T => JSON.parse(JSON.stringify(plain(value))) as T;

/** The canvas `Skia.PictureRecorder().beginRecording()` hands out: RN-Skia's `SkCanvas` calls, written down as operations. */
export class SkRecordingCanvas {
  readonly ops: Record<string, unknown>[] = [];

  private record(op: string, args: Record<string, unknown> = {}): this {
    this.ops.push(snapshot({ op, ...args }));
    return this;
  }

  save(): this {
    return this.record('save');
  }
  restore(): this {
    return this.record('restore');
  }
  translate(x: number, y: number): this {
    return this.record('translate', { x, y });
  }
  scale(x: number, y = x): this {
    return this.record('scale', { x, y });
  }
  /** `rotate(degrees, rx, ry)` about (rx, ry), else about the origin. */
  rotate(degrees: number, rx?: number, ry?: number): this {
    return this.record('rotate', { degrees, x: rx, y: ry });
  }
  skew(x: number, y: number): this {
    return this.record('skew', { x, y });
  }
  concat(matrix: SkMatrix | number[]): this {
    return this.record('concat', { matrix });
  }
  clipRect(rect: SkRect, clipOp: (typeof ClipOp)[keyof typeof ClipOp] = 'intersect', antiAlias = true): this {
    return this.record('clipRect', { shape: rect, clipOp, antiAlias });
  }
  clipRRect(rrect: SkRRect, clipOp: (typeof ClipOp)[keyof typeof ClipOp] = 'intersect', antiAlias = true): this {
    return this.record('clipRRect', { shape: rrect, clipOp, antiAlias });
  }
  clipPath(path: SkPath, clipOp: (typeof ClipOp)[keyof typeof ClipOp] = 'intersect', antiAlias = true): this {
    return this.record('clipPath', { shape: path, clipOp, antiAlias });
  }
  drawPaint(paint: SkPaint): this {
    return this.record('drawPaint', { paint });
  }
  drawColor(color: SkColor, blendMode?: (typeof BlendMode)[keyof typeof BlendMode]): this {
    return this.record('drawColor', { color: toColor(color), blendMode });
  }
  drawRect(rect: SkRect, paint: SkPaint): this {
    return this.record('drawRect', { rect, paint });
  }
  drawRRect(rrect: SkRRect, paint: SkPaint): this {
    return this.record('drawRRect', { rrect, paint });
  }
  drawOval(rect: SkRect, paint: SkPaint): this {
    return this.record('drawOval', { rect, paint });
  }
  drawCircle(x: number, y: number, r: number, paint: SkPaint): this {
    return this.record('drawCircle', { x, y, r, paint });
  }
  drawLine(x0: number, y0: number, x1: number, y1: number, paint: SkPaint): this {
    return this.record('drawLine', { x0, y0, x1, y1, paint });
  }
  drawPath(path: SkPath, paint: SkPaint): this {
    return this.record('drawPath', { path, paint });
  }
  drawPoints(mode: (typeof PointMode)[keyof typeof PointMode], points: SkPoint[], paint: SkPaint): this {
    return this.record('drawPoints', { mode, points, paint });
  }
  drawImage(image: SkImage, x: number, y: number, paint?: SkPaint | null): this {
    return this.record('drawImage', { image, x, y, paint: paint ?? undefined });
  }
  drawImageRect(image: SkImage, src: SkRect, dest: SkRect, paint: SkPaint): this {
    return this.record('drawImageRect', { image, src, dest, paint });
  }
  drawText(text: string, x: number, y: number, paint: SkPaint, font: SkFont): this {
    return this.record('drawText', { text, x, y, paint, font });
  }
  drawTextBlob(blob: SkTextBlob, x: number, y: number, paint: SkPaint): this {
    return this.record('drawTextBlob', { blob, x, y, paint });
  }
  drawGlyphs(glyphs: number[], positions: SkPoint[], x: number, y: number, font: SkFont, paint: SkPaint): this {
    return this.record('drawGlyphs', { glyphs, positions, x, y, font, paint });
  }
  drawPicture(picture: SkPicture): this {
    return this.record('drawPicture', { picture });
  }
  drawParagraph(paragraph: SkParagraph, x: number, y: number): this {
    const width = paragraph.getLayoutWidth();
    return this.record('drawParagraph', { paragraph, x, y, ...(Number.isFinite(width) ? { width } : {}) });
  }
  /** The canvas's transform and clip are its own: nothing reads them back here. */
  getSaveCount(): number {
    return this.ops.filter((o) => o.op === 'save').length - this.ops.filter((o) => o.op === 'restore').length + 1;
  }
  clear(color: SkColor): this {
    return this.drawColor(color, 'src');
  }
  drawAtlas(
    image: SkImage,
    sprites: SkRect[],
    transforms: SkRSXform[],
    paint: SkPaint,
    blendMode?: (typeof BlendMode)[keyof typeof BlendMode],
    colors?: SkColor[],
    sampling?: unknown,
  ): this {
    return this.record('drawAtlas', {
      image,
      sprites,
      transforms,
      paint,
      colorBlendMode: blendMode,
      colors: colors?.map(toColor),
      sampling,
    });
  }
  /** The 12 points of the four cubics, clockwise from the top left (Skia's `drawPatch`). */
  drawPatch(
    cubics: SkPoint[],
    colors: SkColor[] | null | undefined,
    texs: SkPoint[] | null | undefined,
    blendMode: (typeof BlendMode)[keyof typeof BlendMode] | null | undefined,
    paint: SkPaint,
  ): this {
    return this.record('drawPatch', {
      points: cubics,
      colors: colors?.map(toColor),
      texs: texs ?? undefined,
      blendMode: blendMode ?? undefined,
      paint,
    });
  }
}

/** A recorded picture: the operations, replayed by the addon through Skia's own recorder when it is drawn. */
export class SkPicture {
  constructor(
    private readonly ops: Record<string, unknown>[],
    private readonly bounds?: SkRect,
  ) {}
  toJSON(): { ops: Record<string, unknown>[]; bounds?: SkRect } {
    return { ops: this.ops, bounds: this.bounds };
  }
}

/** `Skia.PictureRecorder()`. */
export class SkPictureRecorder {
  private canvas: SkRecordingCanvas | null = null;
  private bounds: SkRect | undefined;

  beginRecording(bounds?: SkRect): SkRecordingCanvas {
    this.bounds = bounds;
    this.canvas = new SkRecordingCanvas();
    return this.canvas;
  }
  finishRecordingAsPicture(): SkPicture {
    if (this.canvas === null) throw new Error('finishRecordingAsPicture() needs beginRecording() first');
    const picture = new SkPicture(this.canvas.ops, this.bounds);
    this.canvas = null;
    return picture;
  }
}

/** RN-Skia's `createPicture(cb, size?)`: what `cb` draws on the canvas it is given, as a picture. */
export function createPicture(cb: (canvas: SkRecordingCanvas) => void, size?: { width: number; height: number }): SkPicture {
  const recorder = new SkPictureRecorder();
  const canvas = recorder.beginRecording(size ? { x: 0, y: 0, ...size } : undefined);
  cb(canvas);
  return recorder.finishRecordingAsPicture();
}

/** An SVG from `Skia.SVG.MakeFromString` or `useSVG`; the addon parses and draws it. */
export class SkSVG {
  constructor(
    private readonly source: string,
    private readonly size: { width: number; height: number },
  ) {}
  width(): number {
    return this.size.width;
  }
  height(): number {
    return this.size.height;
  }
  /** The SVG, with the fonts its text may use: the registered ones and the fallback (there are no system fonts). */
  toJSON(): { svg: string; fonts?: { family: string; file: string }[]; fallback?: { file: string } } {
    if (!this.source.includes('<text')) return { svg: this.source };
    const fallback = getFallbackFont();
    return { svg: this.source, fonts: paragraphFonts(), ...(fallback !== null ? { fallback: { file: fallback } } : {}) };
  }
}

/** The SVG in `source`, or null when it does not parse. */
export function parseSvg(source: string): SkSVG | null {
  try {
    return new SkSVG(source, JSON.parse(skiaAddon().svgSize(JSON.stringify({ svg: source }))));
  } catch {
    return null;
  }
}

// ---- paragraphs ----

export interface SkParagraphStyle {
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end' | number;
  maxLines?: number;
  ellipsis?: string;
  textStyle?: Record<string, unknown>;
}

/** The registered fonts a paragraph may name: there are no system fonts. */
function paragraphFonts(): { family: string; file: string }[] {
  return Object.entries(getFonts()).map(([key, file]) => ({ family: key.split(':')[0]!, file }));
}

/** RN-Skia's `TextAlign` numbers (`Left` 0 to `End` 5), as the names the addon reads. */
const TEXT_ALIGN = ['left', 'right', 'center', 'justify', 'start', 'end'];

/** A paragraph font: a family and the file (or font data) of one of its faces. */
export type ParagraphFont = { family: string } & FontFace;

/** `Skia.ParagraphBuilder.Make(style, fontProvider?)`: records the operations, which the addon replays with Skia's text layout. */
export class SkParagraphBuilder {
  private ops: Record<string, unknown>[] = [];
  constructor(
    private style: SkParagraphStyle,
    private readonly fonts?: () => ParagraphFont[],
  ) {}

  pushStyle(style: Record<string, unknown>): this {
    this.ops.push({ type: 'pushStyle', style: styleOf(style) });
    return this;
  }
  addText(text: string): this {
    this.ops.push({ type: 'addText', text });
    return this;
  }
  pop(): this {
    this.ops.push({ type: 'pop' });
    return this;
  }
  addPlaceholder(): this {
    return this;
  }
  reset(): void {
    this.ops = [];
  }
  build(): SkParagraph {
    const style: Record<string, unknown> = { ...this.style, textStyle: this.style.textStyle ? styleOf(this.style.textStyle) : undefined };
    if (typeof style.textAlign === 'number') style.textAlign = TEXT_ALIGN[style.textAlign] ?? 'left';
    return new SkParagraph(this.fonts ? this.fonts() : paragraphFonts(), style, [...this.ops]);
  }
}

/** RN-Skia's `TextDecoration` numbers (`Underline` 1, `Overline` 2, `LineThrough` 4) as the names the addon reads. */
const DECORATION: Record<number, string> = { 0: 'none', 1: 'underline', 2: 'overline', 4: 'lineThrough' };

/** A text style with its colours and enums as the addon reads them. */
function styleOf(style: Record<string, unknown>): Record<string, unknown> {
  const out = { ...style };
  for (const key of ['color', 'decorationColor']) if (out[key] !== undefined) out[key] = toColor(out[key]);
  if (typeof out.decoration === 'number') out.decoration = DECORATION[out.decoration] ?? 'none';
  if (out.fontStyle && typeof out.fontStyle === 'object') {
    const fs = out.fontStyle as Record<string, unknown>;
    out.fontStyle = { ...fs, ...(typeof fs.slant === 'number' ? { slant: ['upright', 'italic', 'oblique'][fs.slant] } : {}) };
  }
  return out;
}

/** One line of a laid-out paragraph, as `getLineMetrics()` answers. */
export interface LineMetrics {
  startIndex: number;
  endIndex: number;
  endExcludingWhitespaces: number;
  endIncludingNewline: number;
  isHardBreak: boolean;
  ascent: number;
  descent: number;
  height: number;
  width: number;
  left: number;
  baseline: number;
  lineNumber: number;
}

interface ParagraphLayout {
  height: number;
  maxWidth: number;
  longestLine: number;
  minIntrinsicWidth: number;
  maxIntrinsicWidth: number;
  alphabeticBaseline: number;
  ideographicBaseline: number;
  didExceedMaxLines: boolean;
  lines: LineMetrics[];
  ranges: (SkRect & { direction: 'ltr' | 'rtl' })[][];
  points: { position: number; affinity: 'upstream' | 'downstream' }[];
  placeholders: SkRect[];
}

/**
 * A built paragraph. `layout(width)` lays it out as Skia's text layout does when it is drawn, and the measurements
 * (`getHeight()`, `getLineMetrics()`, ...) are Skia's for that width, with the registered fonts.
 */
export class SkParagraph {
  private width = Infinity;
  private measured: ParagraphLayout | null = null;
  constructor(
    private readonly fonts: ParagraphFont[],
    private readonly style: Record<string, unknown>,
    private readonly ops: Record<string, unknown>[],
  ) {}

  private measure(extra: { ranges?: [number, number][]; points?: SkPoint[] } = {}): ParagraphLayout {
    const width = Number.isFinite(this.width) ? this.width : 1e9;
    return JSON.parse(
      skiaAddon().measureParagraph(JSON.stringify({ paragraph: this.toJSON(), width, baseDir: getDomEnvironment().baseDir ?? '', ...extra })),
    ) as ParagraphLayout;
  }
  private get layoutResult(): ParagraphLayout {
    this.measured ??= this.measure();
    return this.measured;
  }

  layout(width: number): void {
    if (width !== this.width) this.measured = null;
    this.width = width;
  }
  /** The width it was laid out at (what a `<Paragraph>` without `width` uses). */
  getLayoutWidth(): number {
    return this.width;
  }
  getHeight(): number {
    return this.layoutResult.height;
  }
  getMaxWidth(): number {
    return this.layoutResult.maxWidth;
  }
  getLongestLine(): number {
    return this.layoutResult.longestLine;
  }
  getMinIntrinsicWidth(): number {
    return this.layoutResult.minIntrinsicWidth;
  }
  getMaxIntrinsicWidth(): number {
    return this.layoutResult.maxIntrinsicWidth;
  }
  getAlphabeticBaseline(): number {
    return this.layoutResult.alphabeticBaseline;
  }
  getIdeographicBaseline(): number {
    return this.layoutResult.ideographicBaseline;
  }
  didExceedMaxLines(): boolean {
    return this.layoutResult.didExceedMaxLines;
  }
  getLineMetrics(): LineMetrics[] {
    return this.layoutResult.lines;
  }
  /** The boxes of the text from `start` to `end` (UTF-16 offsets). */
  getRectsForRange(start: number, end: number): (SkRect & { direction: 'ltr' | 'rtl' })[] {
    return this.measure({ ranges: [[start, end]] }).ranges[0] ?? [];
  }
  /** The text offset nearest to (x, y). */
  getGlyphPositionAtCoordinate(x: number, y: number): number {
    return this.measure({ points: [{ x, y }] }).points[0]?.position ?? 0;
  }
  getRectsForPlaceholders(): SkRect[] {
    return this.layoutResult.placeholders;
  }
  /** Draws it on a recording canvas (`Skia.PictureRecorder`, a surface) at (x, y), at the width it was laid out at. */
  paint(canvas: SkRecordingCanvas, x: number, y: number): void {
    canvas.drawParagraph(this, x, y);
  }
  toJSON(): { fonts: ParagraphFont[]; style: Record<string, unknown>; ops: Record<string, unknown>[] } {
    return { fonts: this.fonts, style: this.style, ops: this.ops };
  }
}

// ---- files ----

/** The path of a file a project names, as a registered font or a picture: it must exist. */
export function projectFile(source: string, what: string): string {
  const file = resolveProjectFile(source);
  if (file === null) throw new Error(`The ${what} ${JSON.stringify(source)} was not found in the project or its public directory`);
  return file;
}

/** The font file registered for a family, weight and style (`registerFont`, `@remotion/fonts`, `@remotion/google-fonts`). */
export function registeredFont(family: string, weight?: number | string, style?: 'normal' | 'italic'): string {
  const key = fontKey(family, weight, style);
  const file = getFonts()[key];
  if (file === undefined) {
    throw new Error(`No font is registered as "${key}": register it with loadFont() or registerFont() before drawing text; there are no system fonts`);
  }
  return file;
}
