// The objects `Skia.*` makes and the hooks hand out, as far as a render needs them: each keeps plain data and
// serialises itself (`toJSON`) into the prop of a node. Geometry that needs Skia (boolean ops, bounds, trimming) asks
// the addon.

import { getDomEnvironment, resolveProjectFile } from '@kinetograph/compat/dom';
import { fontKey } from '@kinetograph/scene';
import { getFonts } from '../font-registry.js';
import { skiaAddon } from './addon.js';
import { toColor, type SkColor } from './values.js';

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

/** `Skia.Paint()`: the paint props of a `<Paint>` node. Shaders and filters are children of the node in this port. */
export class SkPaint {
  private props: Record<string, unknown> = {};
  private rgba: [number, number, number, number] = [0, 0, 0, 1];

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

  toJSON(): { type: 'Paint'; props: Record<string, unknown>; children: [] } {
    return { type: 'Paint', props: this.props, children: [] };
  }
}

// ---- pictures, fonts, effects ----

/** A picture read from a file. */
export class SkImage {
  constructor(
    readonly src: string,
    private readonly size: { width: number; height: number },
  ) {}
  width(): number {
    return this.size.width;
  }
  height(): number {
    return this.size.height;
  }
  toJSON(): { src: string } {
    return { src: this.src };
  }
}

export interface FontMetrics {
  ascent: number;
  descent: number;
  leading: number;
}

/** A font file at a size. */
export class SkFont {
  constructor(
    readonly file: string,
    private size: number,
  ) {}

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
  toJSON(): { file: string; size: number } {
    return { file: this.file, size: this.size };
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
  toJSON(): { sksl: string } {
    return { sksl: this.sksl };
  }
}

// ---- paragraphs ----

export interface SkParagraphStyle {
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  maxLines?: number;
  textStyle?: Record<string, unknown>;
}

/** The registered fonts a paragraph may name: there are no system fonts. */
function paragraphFonts(): { family: string; file: string }[] {
  return Object.entries(getFonts()).map(([key, file]) => ({ family: key.split(':')[0]!, file }));
}

/** `Skia.ParagraphBuilder.Make(style)`: records the operations, which the addon replays with Skia's text layout. */
export class SkParagraphBuilder {
  private ops: Record<string, unknown>[] = [];
  constructor(private style: SkParagraphStyle) {}

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
  build(): SkParagraph {
    return new SkParagraph(paragraphFonts(), { ...this.style, textStyle: this.style.textStyle ? styleOf(this.style.textStyle) : undefined }, [...this.ops]);
  }
}

/** A text style with its colours as the addon reads them. */
function styleOf(style: Record<string, unknown>): Record<string, unknown> {
  const out = { ...style };
  for (const key of ['color', 'decorationColor']) if (out[key] !== undefined) out[key] = toColor(out[key]);
  return out;
}

export class SkParagraph {
  constructor(
    private readonly fonts: { family: string; file: string }[],
    private readonly style: Record<string, unknown>,
    private readonly ops: Record<string, unknown>[],
  ) {}
  /** The layout happens when the paragraph is drawn, at the width of the `<Paragraph>`. */
  layout(_width: number): void {}
  toJSON(): { fonts: { family: string; file: string }[]; style: Record<string, unknown>; ops: Record<string, unknown>[] } {
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
