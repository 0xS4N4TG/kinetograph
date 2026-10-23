// A `CanvasRenderingContext2D` that records instead of rasterising (docs/SCENE.md, "canvas"). It keeps the canvas's
// state, as the browser's does, and writes each drawing call as a command with the state it is drawn in; the renderer
// draws the commands with Skia. Nothing here reads a clock or anything else outside the calls, so what a context
// holds is a function of what it was told.

import { parseCssColor, toCssColor, toSceneColor, type Rgba } from './canvas-color.js';
import { NO_FILTER, parseFilter, type ParsedFilter } from './canvas-filter.js';
import {
  apply,
  domError,
  flattenSegments,
  flattenSubpaths,
  IDENTITY,
  invert,
  isIdentity,
  multiply,
  Path2D,
  pathData,
  PathBuilder,
  type Matrix,
} from './canvas-path.js';
import { fontKey } from './paint.js';
import type { CanvasBlend, CanvasCommand, CanvasLayer, CanvasLine, CanvasPaint, CanvasShadow, CanvasSource, CanvasState } from './types.js';

export { flattenSegments, Path2D } from './canvas-path.js';
export { parseCssColor, toSceneColor } from './canvas-color.js';
export { parseFilter, type ParsedFilter } from './canvas-filter.js';

/** What `drawImage` and `createPattern` read from an image-like object: a picture and its size. */
export interface CanvasPicture {
  source: CanvasSource;
  width: number;
  height: number;
}

/** The method an image-like object (an `<img>`, a canvas, an `ImageData`) answers `drawImage` with. */
export const CANVAS_SOURCE: unique symbol = Symbol.for('kinetograph.canvasSource');

export interface CanvasPictureSource {
  [CANVAS_SOURCE](): CanvasPicture | null;
}

export interface TextMeasure {
  width: number;
  ascent: number;
  descent: number;
}

export interface CanvasContextOptions {
  /** The canvas's size now (it changes with `canvas.width`). */
  size: () => { width: number; height: number };
  /** The registered fonts, by key (`fontKey`): what a `font` is matched against. */
  fonts?: () => Record<string, string>;
  /** The size of `text` laid out in the font with this key, or null when it cannot be measured. */
  measure?: (text: string, font: string, size: number) => TextMeasure | null;
  /** The pixels the commands so far draw in `rect`, RGBA straight alpha, for `getImageData`. */
  readPixels?: (commands: CanvasCommand[], size: { width: number; height: number }, rect: { x: number; y: number; width: number; height: number }) => Uint8ClampedArray;
  /** The element the context draws on (`ctx.canvas`). */
  canvas?: unknown;
}

function toBase64(bytes: Uint8ClampedArray): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Pixels, as `ImageData` holds them: width, height and straight-alpha RGBA8. */
export class ImageData implements CanvasPictureSource {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = 'srgb';
  constructor(width: number, height: number, settings?: unknown);
  constructor(data: Uint8ClampedArray, width: number, height?: number, settings?: unknown);
  constructor(first: number | Uint8ClampedArray, second: number, third?: number | unknown) {
    if (typeof first === 'number') {
      if (!(first > 0) || !(second > 0)) throw domError('The source width and height must be greater than zero.', 'IndexSizeError');
      this.width = Math.floor(first);
      this.height = Math.floor(second);
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    if (!(first instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    if (first.length % 4 !== 0 || !(second > 0)) throw domError('The input data length is not a multiple of 4.', 'InvalidStateError');
    const width = Math.floor(second);
    const height = typeof third === 'number' ? Math.floor(third) : first.length / 4 / width;
    if (width * height * 4 !== first.length) throw domError('The input data length does not match the width and height.', 'IndexSizeError');
    this.data = first;
    this.width = width;
    this.height = height;
  }
  [CANVAS_SOURCE](): CanvasPicture {
    return { source: { kind: 'pixels', width: this.width, height: this.height, data: toBase64(this.data) }, width: this.width, height: this.height };
  }
}

/** The picture an image-like object stands for, or null when it is not one. */
export function pictureOf(image: unknown): CanvasPicture | null {
  const read = (image as Partial<CanvasPictureSource> | null | undefined)?.[CANVAS_SOURCE];
  return typeof read === 'function' ? read.call(image) : null;
}

type StopList = [number, string][];

abstract class Painted {
  abstract paint(): CanvasPaint;
}

/** `createLinearGradient`, `createRadialGradient` and `createConicGradient`. */
export class CanvasGradient extends Painted {
  private readonly stops: StopList = [];
  constructor(private readonly shape: { type: 'linear'; x0: number; y0: number; x1: number; y1: number } | { type: 'radial'; x0: number; y0: number; r0: number; x1: number; y1: number; r1: number } | { type: 'conic'; x: number; y: number; angle: number }) {
    super();
  }
  addColorStop(offset: number, color: string): void {
    const at = Number(offset);
    if (!(at >= 0 && at <= 1)) throw domError('The provided value is outside the range (0 to 1).', 'IndexSizeError');
    const parsed = parseCssColor(String(color));
    if (parsed === null) throw domError(`The value provided ('${color}') could not be parsed as a color.`, 'SyntaxError');
    this.stops.push([at, toSceneColor(parsed)]);
  }
  paint(): CanvasPaint {
    // Stops in order of offset; those at one offset stay in the order they were added.
    const stops = this.stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop[0] - b.stop[0] || a.index - b.index).map(({ stop }) => stop);
    return { ...this.shape, stops } as CanvasPaint;
  }
}

/** `createPattern`. */
export class CanvasPattern extends Painted {
  private m: Matrix = IDENTITY;
  constructor(private readonly picture: CanvasPicture, private readonly repeatX: boolean, private readonly repeatY: boolean) {
    super();
  }
  setTransform(transform?: unknown): void {
    if (transform === undefined) {
      this.m = IDENTITY;
      return;
    }
    if (typeof transform !== 'object' || transform === null) throw new TypeError("Failed to execute 'setTransform' on 'CanvasPattern': parameter 1 is not of type 'DOMMatrix2DInit'.");
    const m = matrixFrom([transform]);
    if (m === null) throw new TypeError("Failed to execute 'setTransform' on 'CanvasPattern': matrix contains non-finite values.");
    this.m = m;
  }
  paint(): CanvasPaint {
    return {
      type: 'pattern',
      source: this.picture.source,
      repeatX: this.repeatX,
      repeatY: this.repeatY,
      ...(isIdentity(this.m) ? {} : { m: [...this.m] as Matrix }),
    };
  }
}

type PaintSpec = { color: Rgba; css: string } | CanvasGradient | CanvasPattern;

interface FontSpec {
  /** As assigned. */
  css: string;
  families: string[];
  size: number;
  weight: number;
  style: 'normal' | 'italic';
}

const DEFAULT_FONT: FontSpec = { css: '10px sans-serif', families: ['sans-serif'], size: 10, weight: 400, style: 'normal' };

const SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};
const WEIGHT_KEYWORDS: Record<string, number> = { normal: 400, bold: 700, bolder: 700, lighter: 300 };

/** A CSS `font` shorthand as `ctx.font` takes it, or null when it is not one. */
function parseFont(value: string): FontSpec | null {
  const text = value.trim();
  const tokens = text.split(/\s+/);
  let style: 'normal' | 'italic' = 'normal';
  let weight = 400;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    const size = /^(\d*\.?\d+)(px|pt|em|rem|%)(?:\/\S+)?$/.exec(lower);
    if (size || lower in SIZE_KEYWORDS) {
      const amount = size ? Number(size[1]) : SIZE_KEYWORDS[lower]!;
      const px = !size ? amount : size[2] === 'px' ? amount : size[2] === 'pt' ? (amount * 4) / 3 : size[2] === '%' ? (amount / 100) * 16 : amount * 16;
      const families = tokens
        .slice(i + 1)
        .join(' ')
        .split(',')
        .map((family) => family.trim().replace(/^(["'])(.*)\1$/, '$2'))
        .filter((family) => family !== '');
      if (families.length === 0 || !(px > 0)) return null;
      return { css: text, families, size: px, weight, style };
    }
    if (lower === 'italic' || lower === 'oblique') style = 'italic';
    else if (lower in WEIGHT_KEYWORDS) weight = WEIGHT_KEYWORDS[lower]!;
    else if (/^\d+$/.test(lower) && Number(lower) >= 1 && Number(lower) <= 1000) weight = Number(lower);
    else if (lower === 'small-caps' || /^(ultra|extra|semi)?-?(condensed|expanded)$/.test(lower)) continue;
    else return null;
  }
  return null;
}

/** The key of the registered font that serves `spec`: the first family that has one, the nearest weight of it. */
function fontOf(spec: FontSpec, fonts: Record<string, string>): string {
  const keys = Object.keys(fonts);
  for (const family of spec.families) {
    const own = keys
      .map((key) => {
        const m = /^(.*?)(?::(\d+)(i?))?$/.exec(key)!;
        return { key, family: m[1]!, weight: m[2] ? Number(m[2]) : 400, style: m[3] ? 'italic' : 'normal' };
      })
      .filter((face) => face.family === family);
    if (own.length === 0) continue;
    const rank = (face: (typeof own)[number]): number => (face.style === spec.style ? 0 : 10000) + Math.abs(face.weight - spec.weight);
    return own.reduce((best, face) => (rank(face) < rank(best) ? face : best)).key;
  }
  return fontKey(spec.families[0]!, spec.weight, spec.style);
}

interface State {
  ctm: Matrix;
  fill: PaintSpec;
  stroke: PaintSpec;
  alpha: number;
  blend: CanvasBlend;
  lineWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  font: FontSpec;
  textAlign: 'start' | 'end' | 'left' | 'right' | 'center';
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';
  smoothing: boolean;
  /** `filter` as `parseFilter` read it. */
  filter: ParsedFilter;
  /** Properties that are kept as set: the shadow's, `filter`'s text, and the finer text settings, which draw nothing. */
  plain: Record<string, unknown>;
  /** How many `clip` commands are open in the log. */
  clips: number;
}

const BLACK: PaintSpec = { color: { r: 0, g: 0, b: 0, a: 1 }, css: '#000000' };

const PLAIN_DEFAULTS: Record<string, unknown> = {
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  filter: 'none',
  direction: 'ltr',
  letterSpacing: '0px',
  wordSpacing: '0px',
  fontKerning: 'auto',
  fontStretch: 'normal',
  fontVariantCaps: 'normal',
  textRendering: 'auto',
  imageSmoothingQuality: 'low',
  lang: 'inherit',
};

function initial(): State {
  return {
    ctm: IDENTITY,
    fill: BLACK,
    stroke: BLACK,
    alpha: 1,
    blend: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
    font: DEFAULT_FONT,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    smoothing: true,
    filter: NO_FILTER,
    plain: { ...PLAIN_DEFAULTS },
    clips: 0,
  };
}

const BLENDS = new Set<string>([
  'source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out',
  'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge',
  'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

const oneOf = <T extends string>(allowed: readonly T[]) => (value: unknown): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };

function matrixFrom(args: unknown[]): Matrix | null {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const m = first as Partial<Matrix2D>;
    const out: Matrix = [m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0];
    return out.every(Number.isFinite) ? out : null;
  }
  const out = args.slice(0, 6).map(Number);
  return out.length === 6 && out.every(Number.isFinite) ? (out as Matrix) : null;
}

/** The canvas's current path: points are kept in canvas space, taken through the transform in force when each was added. */
class ContextPath extends PathBuilder {
  clear(): void {
    this.segments = [];
    this.current = null;
    this.begin = null;
  }
}

/**
 * The `CanvasRenderingContext2D` of a canvas, drawing into a list of commands (`commands`). One lives as long as its
 * canvas; `reset()` (or a new `width` or `height` on the canvas) empties it. A project that redraws every frame
 * clears and paints the whole canvas, which drops the commands before it, so the list stays as long as a frame's
 * drawing.
 */
export class CanvasContext2D {
  /** The element this draws on. */
  readonly canvas: unknown;
  private state: State = initial();
  private readonly saved: State[] = [];
  private readonly path = new ContextPath();
  private log: CanvasCommand[] = [];

  constructor(private readonly options: CanvasContextOptions) {
    this.canvas = options.canvas;
  }

  /** The drawing so far, in order: what a canvas layer's `commands` holds. */
  get commands(): CanvasCommand[] {
    return this.log;
  }

  // ---- state ----

  save(): void {
    this.saved.push({ ...this.state, dash: [...this.state.dash], plain: { ...this.state.plain } });
  }

  restore(): void {
    const back = this.saved.pop();
    if (!back) return;
    for (let i = this.state.clips; i > back.clips; i -= 1) this.log.push({ op: 'unclip' });
    this.state = back;
  }

  /**
   * Ends a frame's drawing: the state goes back to a new canvas's (the clips still open are closed), and what is
   * drawn stays. A canvas that is redrawn each frame is then drawn from the same state whichever frame came before.
   */
  resetState(): void {
    for (let i = this.state.clips; i > 0; i -= 1) this.log.push({ op: 'unclip' });
    this.saved.length = 0;
    this.state = initial();
    this.path.clear();
  }

  reset(): void {
    this.log = [];
    this.saved.length = 0;
    this.state = initial();
    this.path.clear();
  }

  isContextLost(): boolean {
    return false;
  }

  getContextAttributes() {
    return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false };
  }

  get globalAlpha(): number {
    return this.state.alpha;
  }
  set globalAlpha(value: number) {
    const v = Number(value);
    if (v >= 0 && v <= 1) this.state.alpha = v;
  }

  get globalCompositeOperation(): string {
    return this.state.blend;
  }
  set globalCompositeOperation(value: string) {
    if (BLENDS.has(value)) this.state.blend = value as CanvasBlend;
  }

  get imageSmoothingEnabled(): boolean {
    return this.state.smoothing;
  }
  set imageSmoothingEnabled(value: boolean) {
    this.state.smoothing = Boolean(value);
  }

  private plainProperty<T>(name: string, accept: (value: unknown) => T | undefined): { get(): T; set(value: unknown): void } {
    return {
      get: () => this.state.plain[name] as T,
      set: (value) => {
        const checked = accept(value);
        if (checked !== undefined) this.state.plain[name] = checked;
      },
    };
  }

  // ---- styles ----

  private styleOf(value: unknown, current: PaintSpec): PaintSpec {
    if (value instanceof CanvasGradient || value instanceof CanvasPattern) return value;
    if (typeof value !== 'string') return current;
    const color = parseCssColor(value);
    return color === null ? current : { color, css: toCssColor(color) };
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    const f = this.state.fill;
    return 'css' in f ? f.css : f;
  }
  set fillStyle(value: unknown) {
    this.state.fill = this.styleOf(value, this.state.fill);
  }

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    const s = this.state.stroke;
    return 'css' in s ? s.css : s;
  }
  set strokeStyle(value: unknown) {
    this.state.stroke = this.styleOf(value, this.state.stroke);
  }

  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    const v = Number(value);
    if (Number.isFinite(v) && v > 0) this.state.lineWidth = v;
  }

  get lineCap(): string {
    return this.state.lineCap;
  }
  set lineCap(value: string) {
    this.state.lineCap = oneOf(['butt', 'round', 'square'] as const)(value) ?? this.state.lineCap;
  }

  get lineJoin(): string {
    return this.state.lineJoin;
  }
  set lineJoin(value: string) {
    this.state.lineJoin = oneOf(['miter', 'round', 'bevel'] as const)(value) ?? this.state.lineJoin;
  }

  get miterLimit(): number {
    return this.state.miterLimit;
  }
  set miterLimit(value: number) {
    const v = Number(value);
    if (Number.isFinite(v) && v > 0) this.state.miterLimit = v;
  }

  get lineDashOffset(): number {
    return this.state.dashOffset;
  }
  set lineDashOffset(value: number) {
    const v = Number(value);
    if (Number.isFinite(v)) this.state.dashOffset = v;
  }

  setLineDash(segments: Iterable<number>): void {
    const list = [...segments].map(Number);
    if (list.some((v) => !Number.isFinite(v) || v < 0)) return;
    this.state.dash = list.length % 2 === 1 ? [...list, ...list] : list;
  }

  getLineDash(): number[] {
    return [...this.state.dash];
  }

  get font(): string {
    return this.state.font.css;
  }
  set font(value: string) {
    const spec = parseFont(String(value));
    if (spec !== null) this.state.font = spec;
  }

  get textAlign(): string {
    return this.state.textAlign;
  }
  set textAlign(value: string) {
    this.state.textAlign = oneOf(['start', 'end', 'left', 'right', 'center'] as const)(value) ?? this.state.textAlign;
  }

  get textBaseline(): string {
    return this.state.textBaseline;
  }
  set textBaseline(value: string) {
    this.state.textBaseline = oneOf(['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'] as const)(value) ?? this.state.textBaseline;
  }

  // The shadow's four properties are kept as set, and `drawn()` writes them on a command when they make a shadow.
  get shadowBlur(): number { return this.plainProperty('shadowBlur', nonNegative).get(); }
  set shadowBlur(value: number) { this.plainProperty('shadowBlur', nonNegative).set(value); }
  get shadowOffsetX(): number { return this.plainProperty('shadowOffsetX', finite).get(); }
  set shadowOffsetX(value: number) { this.plainProperty('shadowOffsetX', finite).set(value); }
  get shadowOffsetY(): number { return this.plainProperty('shadowOffsetY', finite).get(); }
  set shadowOffsetY(value: number) { this.plainProperty('shadowOffsetY', finite).set(value); }
  get shadowColor(): string { return this.plainProperty('shadowColor', colorText).get(); }
  set shadowColor(value: string) { this.plainProperty('shadowColor', colorText).set(value); }
  get filter(): string { return this.plainProperty('filter', text).get(); }
  set filter(value: string) {
    // A value that is not a filter list is ignored, as a context ignores it.
    const parsed = typeof value === 'string' ? parseFilter(value) : null;
    if (parsed === null) return;
    this.state.filter = parsed;
    this.plainProperty('filter', text).set(value);
  }
  get direction(): string { return this.plainProperty('direction', oneOf(['ltr', 'rtl', 'inherit'] as const)).get(); }
  set direction(value: string) { this.plainProperty('direction', oneOf(['ltr', 'rtl', 'inherit'] as const)).set(value); }
  get letterSpacing(): string { return this.plainProperty('letterSpacing', lengthText).get(); }
  set letterSpacing(value: string) { this.plainProperty('letterSpacing', lengthText).set(value); }
  get wordSpacing(): string { return this.plainProperty('wordSpacing', lengthText).get(); }
  set wordSpacing(value: string) { this.plainProperty('wordSpacing', lengthText).set(value); }
  get fontKerning(): string { return this.plainProperty('fontKerning', text).get(); }
  set fontKerning(value: string) { this.plainProperty('fontKerning', text).set(value); }
  get fontStretch(): string { return this.plainProperty('fontStretch', text).get(); }
  set fontStretch(value: string) { this.plainProperty('fontStretch', text).set(value); }
  get fontVariantCaps(): string { return this.plainProperty('fontVariantCaps', text).get(); }
  set fontVariantCaps(value: string) { this.plainProperty('fontVariantCaps', text).set(value); }
  get textRendering(): string { return this.plainProperty('textRendering', text).get(); }
  set textRendering(value: string) { this.plainProperty('textRendering', text).set(value); }
  get imageSmoothingQuality(): string { return this.plainProperty('imageSmoothingQuality', oneOf(['low', 'medium', 'high'] as const)).get(); }
  set imageSmoothingQuality(value: string) { this.plainProperty('imageSmoothingQuality', oneOf(['low', 'medium', 'high'] as const)).set(value); }
  get lang(): string { return this.plainProperty('lang', text).get(); }
  set lang(value: string) { this.plainProperty('lang', text).set(value); }

  // ---- transform ----

  private setCtm(ctm: Matrix): void {
    this.state.ctm = ctm;
  }

  scale(x: number, y: number): void {
    if (![x, y].every(Number.isFinite)) return;
    this.setCtm(multiply(this.state.ctm, [x, 0, 0, y, 0, 0]));
  }

  rotate(angle: number): void {
    if (!Number.isFinite(angle)) return;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    this.setCtm(multiply(this.state.ctm, [c, s, -s, c, 0, 0]));
  }

  translate(x: number, y: number): void {
    if (![x, y].every(Number.isFinite)) return;
    this.setCtm(multiply(this.state.ctm, [1, 0, 0, 1, x, y]));
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = matrixFrom([a, b, c, d, e, f]);
    if (m) this.setCtm(multiply(this.state.ctm, m));
  }

  setTransform(...args: unknown[]): void {
    const m = matrixFrom(args);
    if (m) this.setCtm(m);
  }

  resetTransform(): void {
    this.setCtm(IDENTITY);
  }

  /** A `DOMMatrix` when the environment has one, else an object with the same 2D fields. */
  getTransform(): Matrix2D & { is2D: true; isIdentity: boolean } {
    const [a, b, c, d, e, f] = this.state.ctm;
    const Native = (globalThis as { DOMMatrix?: new (init: number[]) => Matrix2D & { is2D: true; isIdentity: boolean } }).DOMMatrix;
    return Native ? new Native([a, b, c, d, e, f]) : { a, b, c, d, e, f, is2D: true, isIdentity: isIdentity(this.state.ctm) };
  }

  // ---- path ----

  beginPath(): void {
    this.path.clear();
  }
  closePath(): void {
    this.path.space = this.state.ctm;
    this.path.closePath();
  }
  moveTo(x: number, y: number): void {
    this.path.space = this.state.ctm;
    this.path.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.path.space = this.state.ctm;
    this.path.lineTo(x, y);
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.path.space = this.state.ctm;
    this.path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.path.space = this.state.ctm;
    this.path.quadraticCurveTo(cx, cy, x, y);
  }
  arc(x: number, y: number, radius: number, start: number, end: number, counterclockwise?: boolean): void {
    this.path.space = this.state.ctm;
    this.path.arc(x, y, radius, start, end, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.path.space = this.state.ctm;
    this.path.arcTo(x1, y1, x2, y2, radius);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, counterclockwise?: boolean): void {
    this.path.space = this.state.ctm;
    this.path.ellipse(x, y, rx, ry, rotation, start, end, counterclockwise);
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.path.space = this.state.ctm;
    this.path.rect(x, y, width, height);
  }
  roundRect(x: number, y: number, width: number, height: number, radii?: unknown): void {
    this.path.space = this.state.ctm;
    this.path.roundRect(x, y, width, height, radii);
  }

  // ---- drawing ----

  /** `globalAlpha` with the `opacity()` of the filter in it: what a command is composited with. */
  private alpha(): number {
    return this.state.alpha * this.state.filter.opacity;
  }

  /** The shadow the properties make, or null when it does not show: no colour, or neither a blur nor an offset. */
  private shadow(): CanvasShadow | null {
    const { plain } = this.state;
    const color = parseCssColor(plain.shadowColor as string);
    const [blur, x, y] = [plain.shadowBlur, plain.shadowOffsetX, plain.shadowOffsetY] as number[];
    if (color === null || color.a === 0 || (blur === 0 && x === 0 && y === 0)) return null;
    return { color: toSceneColor(color), ...(blur !== 0 && { blur }), ...(x !== 0 && { x }), ...(y !== 0 && { y }) };
  }

  /** What every command is drawn with, and the matrix `m` that takes its coordinates to the canvas. */
  private drawn(m: Matrix = this.state.ctm): CanvasState {
    const out: CanvasState = {};
    if (!isIdentity(m)) out.m = [...m] as Matrix;
    const alpha = this.alpha();
    if (alpha !== 1) out.a = alpha;
    if (this.state.blend !== 'source-over') out.blend = this.state.blend;
    const shadow = this.shadow();
    if (shadow !== null) out.shadow = shadow;
    const { fns, unsupported } = this.state.filter;
    if (fns.length > 0) out.filter = fns;
    if (unsupported.length > 0) out.unsupportedFilter = unsupported.join(' ');
    return out;
  }

  private paintOf(spec: PaintSpec): CanvasPaint {
    return 'css' in spec ? { type: 'color', color: toSceneColor(spec.color) } : spec.paint();
  }

  private lineOf(): CanvasLine {
    const s = this.state;
    const line: CanvasLine = {};
    if (s.lineWidth !== 1) line.width = s.lineWidth;
    if (s.lineCap !== 'butt') line.cap = s.lineCap;
    if (s.lineJoin !== 'miter') line.join = s.lineJoin;
    if (s.miterLimit !== 10) line.miterLimit = s.miterLimit;
    if (s.dash.length > 0) {
      line.dash = [...s.dash];
      if (s.dashOffset !== 0) line.dashOffset = s.dashOffset;
    }
    return line;
  }

  /** The path data and matrix to draw `path` with: the context's own path is kept in canvas space, so it goes back through the transform. */
  private geometry(path?: Path2D): { d: string; m: Matrix } | null {
    const ctm = this.state.ctm;
    if (path !== undefined) return { d: pathData(path.segments), m: ctm };
    const back = invert(ctm);
    if (back === null) return null;
    return { d: pathData(this.path.segments, isIdentity(ctm) ? undefined : back), m: ctm };
  }

  private ruleArgs(args: unknown[]): { path?: Path2D; rule: 'nonzero' | 'evenodd' } {
    const [first, second] = args;
    const path = first instanceof Path2D ? first : undefined;
    const rule = (path ? second : first) === 'evenodd' ? 'evenodd' : 'nonzero';
    return { path, rule };
  }

  fill(...args: unknown[]): void {
    const { path, rule } = this.ruleArgs(args);
    const shape = this.geometry(path);
    if (shape === null || (path ?? this.path).segments.length === 0) return;
    const command: CanvasCommand = { op: 'fill', path: shape.d, paint: this.paintOf(this.state.fill), ...this.drawn(shape.m) };
    if (rule === 'evenodd') command.rule = 'evenodd';
    this.log.push(command);
  }

  stroke(path?: Path2D): void {
    const shape = this.geometry(path);
    if (shape === null || (path ?? this.path).segments.length === 0) return;
    this.log.push({ op: 'stroke', path: shape.d, paint: this.paintOf(this.state.stroke), ...this.lineOf(), ...this.drawn(shape.m) });
  }

  clip(...args: unknown[]): void {
    const { path, rule } = this.ruleArgs(args);
    const shape = this.geometry(path);
    if (shape === null) return;
    const command: CanvasCommand = { op: 'clip', path: shape.d };
    if (rule === 'evenodd') command.rule = 'evenodd';
    if (!isIdentity(shape.m)) command.m = [...shape.m] as Matrix;
    this.log.push(command);
    this.state.clips += 1;
  }

  /** Whether `x, y`, `width` by `height` under the transform covers the whole canvas (an axis-aligned transform only). */
  private coversCanvas(x: number, y: number, width: number, height: number): boolean {
    const [a, b, c, d] = this.state.ctm;
    if (b !== 0 || c !== 0 || a <= 0 || d <= 0) return false;
    const [x0, y0] = apply(this.state.ctm, x, y);
    const [x1, y1] = apply(this.state.ctm, x + width, y + height);
    const size = this.options.size();
    return x0 <= 0 && y0 <= 0 && x1 >= size.width && y1 >= size.height;
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    if (![x, y, width, height].every(Number.isFinite) || width === 0 || height === 0) return;
    const fill = this.state.fill;
    // An opaque rectangle over the whole canvas hides everything drawn before it.
    if (this.state.clips === 0 && this.alpha() === 1 && this.state.filter.fns.length === 0 && this.state.blend === 'source-over' && 'css' in fill && fill.color.a === 1 && this.coversCanvas(x, y, width, height)) {
      this.log = [];
    }
    this.log.push({ op: 'fill', path: pathData([['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height], ['Z']]), paint: this.paintOf(fill), ...this.drawn() });
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    if (![x, y, width, height].every(Number.isFinite)) return;
    if (width === 0 && height === 0) return;
    const d = pathData(width === 0 || height === 0 ? [['M', x, y], ['L', x + width, y + height]] : [['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height], ['Z']]);
    this.log.push({ op: 'stroke', path: d, paint: this.paintOf(this.state.stroke), ...this.lineOf(), ...this.drawn() });
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    if (![x, y, width, height].every(Number.isFinite) || width === 0 || height === 0) return;
    if (this.state.clips === 0 && this.coversCanvas(Math.min(x, x + width), Math.min(y, y + height), Math.abs(width), Math.abs(height))) {
      this.log = [];
      return;
    }
    this.log.push({
      op: 'fill',
      path: pathData([['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height], ['Z']]),
      paint: { type: 'color', color: '#000000' },
      ...(isIdentity(this.state.ctm) ? {} : { m: [...this.state.ctm] as Matrix }),
      blend: 'clear',
    });
  }

  // ---- text ----

  private fontKeyNow(): string {
    return fontOf(this.state.font, this.options.fonts?.() ?? {});
  }

  private textCommand(text: string, x: number, y: number, maxWidth: number | undefined, stroke: boolean): void {
    if (![x, y].every(Number.isFinite) || (maxWidth !== undefined && !(maxWidth > 0))) return;
    const s = this.state;
    const shown = String(text).replace(/[\t\n\r\f\v]/g, ' ');
    if (shown === '') return;
    const command: CanvasCommand = { op: 'text', text: shown, font: this.fontKeyNow(), size: s.font.size, x, y, paint: this.paintOf(stroke ? s.stroke : s.fill), ...this.drawn() };
    const align = s.plain.direction === 'rtl' && (s.textAlign === 'start' || s.textAlign === 'end') ? (s.textAlign === 'start' ? 'right' : 'left') : s.textAlign;
    if (align !== 'start') command.align = align;
    if (s.textBaseline !== 'alphabetic') command.baseline = s.textBaseline;
    if (maxWidth !== undefined) command.maxWidth = maxWidth;
    const letterSpacing = parseSpacing(s.plain.letterSpacing as string, s.font.size);
    if (letterSpacing !== 0) command.letterSpacing = letterSpacing;
    const wordSpacing = parseSpacing(s.plain.wordSpacing as string, s.font.size);
    if (wordSpacing !== 0) command.wordSpacing = wordSpacing;
    if (stroke) command.line = this.lineOf();
    this.log.push(command);
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.textCommand(text, x, y, maxWidth, false);
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.textCommand(text, x, y, maxWidth, true);
  }

  measureText(text: string) {
    const { size } = this.state.font;
    const shown = String(text).replace(/[\t\n\r\f\v]/g, ' ');
    const measured = this.options.measure?.(shown, this.fontKeyNow(), size) ?? null;
    // Without a text engine to ask, an average glyph is half the size.
    const width = measured?.width ?? shown.length * size * 0.5;
    const ascent = measured?.ascent ?? size * 0.8;
    const descent = measured?.descent ?? size * 0.2;
    const align = this.state.textAlign;
    const left = align === 'center' ? width / 2 : align === 'right' || align === 'end' ? width : 0;
    const base = { alphabetic: 0, top: ascent, hanging: ascent * 0.8, middle: (ascent - descent) / 2, ideographic: -descent, bottom: -descent }[this.state.textBaseline];
    return {
      width,
      actualBoundingBoxLeft: left,
      actualBoundingBoxRight: width - left,
      actualBoundingBoxAscent: ascent - base,
      actualBoundingBoxDescent: descent + base,
      fontBoundingBoxAscent: ascent - base,
      fontBoundingBoxDescent: descent + base,
      emHeightAscent: ascent - base,
      emHeightDescent: descent + base,
      hangingBaseline: ascent * 0.8 - base,
      alphabeticBaseline: -base,
      ideographicBaseline: -descent - base,
    };
  }

  // ---- pictures ----

  drawImage(image: unknown, ...args: number[]): void {
    const picture = pictureOf(image);
    if (picture === null) throw new TypeError("Failed to execute 'drawImage': the image is not a picture this canvas can draw (an <img>, a canvas or ImageData)");
    if (!args.every(Number.isFinite)) return;
    if (!(picture.width > 0 && picture.height > 0)) return;
    let rect: { sx?: number; sy?: number; sw?: number; sh?: number; dx: number; dy: number; dw: number; dh: number };
    if (args.length === 2) rect = { dx: args[0]!, dy: args[1]!, dw: picture.width, dh: picture.height };
    else if (args.length === 4) rect = { dx: args[0]!, dy: args[1]!, dw: args[2]!, dh: args[3]! };
    else if (args.length === 8) rect = { sx: args[0], sy: args[1], sw: args[2], sh: args[3], dx: args[4]!, dy: args[5]!, dw: args[6]!, dh: args[7]! };
    else throw new TypeError(`Failed to execute 'drawImage': ${args.length + 1} arguments is not valid`);
    if (rect.dw === 0 || rect.dh === 0 || rect.sw === 0 || rect.sh === 0) return;
    const command: CanvasCommand = { op: 'image', source: picture.source, ...rect, ...this.drawn() };
    if (!this.state.smoothing) command.smooth = false;
    this.log.push(command);
  }

  /**
   * HTML in Canvas's `drawElementImage(elementImage, dx, dy[, dw, dh])`: `drawImage` of the picture of an element. The
   * same forms as `drawImage` are read.
   */
  drawElementImage(elementImage: unknown, ...args: number[]): void {
    this.drawImage(elementImage, ...args);
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new TypeError('createLinearGradient: the coordinates must be finite numbers');
    return new CanvasGradient({ type: 'linear', x0, y0, x1, y1 });
  }

  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    if (![x0, y0, r0, x1, y1, r1].every(Number.isFinite)) throw new TypeError('createRadialGradient: the coordinates must be finite numbers');
    if (r0 < 0 || r1 < 0) throw domError('The radius provided is negative.', 'IndexSizeError');
    return new CanvasGradient({ type: 'radial', x0, y0, r0, x1, y1, r1 });
  }

  createConicGradient(angle: number, x: number, y: number): CanvasGradient {
    if (![angle, x, y].every(Number.isFinite)) throw new TypeError('createConicGradient: the arguments must be finite numbers');
    return new CanvasGradient({ type: 'conic', x, y, angle });
  }

  createPattern(image: unknown, repetition: string | null = 'repeat'): CanvasPattern | null {
    const picture = pictureOf(image);
    if (picture === null) throw new TypeError("Failed to execute 'createPattern': the image is not a picture this canvas can draw");
    const how = repetition === null || repetition === '' ? 'repeat' : repetition;
    if (!['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(how)) throw domError(`The provided type ('${how}') is not valid.`, 'SyntaxError');
    return new CanvasPattern(picture, how === 'repeat' || how === 'repeat-x', how === 'repeat' || how === 'repeat-y');
  }

  // ---- pixels ----

  createImageData(first: number | ImageData, second?: number): ImageData {
    return typeof first === 'number' ? new ImageData(Math.abs(first), Math.abs(second ?? NaN)) : new ImageData(first.width, first.height);
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    if (![sx, sy, sw, sh].every(Number.isFinite)) throw new TypeError('getImageData: the rectangle must be finite numbers');
    if (sw === 0 || sh === 0) throw domError('The source width and height must be nonzero.', 'IndexSizeError');
    if (this.options.readPixels === undefined) {
      throw new Error('getImageData is not available here: nothing can draw this canvas to pixels (the native addon is not loaded)');
    }
    const [x, y, width, height] = [sw < 0 ? sx + sw : sx, sh < 0 ? sy + sh : sy, Math.abs(Math.floor(sw)), Math.abs(Math.floor(sh))];
    const pixels = this.options.readPixels(this.log, this.options.size(), { x: Math.floor(x), y: Math.floor(y), width, height });
    return new ImageData(pixels, width, height);
  }

  putImageData(image: ImageData, dx: number, dy: number, dirtyX = 0, dirtyY = 0, dirtyWidth = image.width, dirtyHeight = image.height): void {
    if (![dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight].every(Number.isFinite)) return;
    if (dirtyWidth < 0) { dirtyX += dirtyWidth; dirtyWidth = -dirtyWidth; }
    if (dirtyHeight < 0) { dirtyY += dirtyHeight; dirtyHeight = -dirtyHeight; }
    const x0 = Math.max(0, dirtyX);
    const y0 = Math.max(0, dirtyY);
    const w = Math.min(image.width, dirtyX + dirtyWidth) - x0;
    const h = Math.min(image.height, dirtyY + dirtyHeight) - y0;
    if (!(w > 0 && h > 0)) return;
    // The pixels replace what is under them: the transform, alpha and composite operation do not apply.
    const [at, to] = [dx + x0, dy + y0];
    this.log.push({ op: 'fill', path: pathData([['M', at, to], ['L', at + w, to], ['L', at + w, to + h], ['L', at, to + h], ['Z']]), paint: { type: 'color', color: '#000000' }, blend: 'clear' });
    this.log.push({ op: 'image', source: image[CANVAS_SOURCE]().source, sx: x0, sy: y0, sw: w, sh: h, dx: at, dy: to, dw: w, dh: h, smooth: false });
  }

  // ---- hit testing, focus ----

  isPointInPath(x: number, y: number, fillRule?: 'nonzero' | 'evenodd'): boolean;
  isPointInPath(path: Path2D, x: number, y: number, fillRule?: 'nonzero' | 'evenodd'): boolean;
  isPointInPath(...args: unknown[]): boolean {
    const path = args[0] instanceof Path2D ? args[0] : undefined;
    const offset = path ? 1 : 0;
    const x = Number(args[offset]);
    const y = Number(args[offset + 1]);
    const rawRule = args[offset + 2];
    let rule: 'nonzero' | 'evenodd' = 'nonzero';
    if (rawRule !== undefined) {
      const str = String(rawRule);
      if (str !== 'nonzero' && str !== 'evenodd') {
        throw new TypeError(`The provided value '${str}' is not a valid enum value of type CanvasFillRule.`);
      }
      rule = str;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rings = path ? flattenSegments(path.segments, this.state.ctm) : flattenSegments(this.path.segments);
    let winding = 0;
    for (const pts of rings) {
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const [x0, y0, x1, y1] = [pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!];
        if (y0 <= y) {
          if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) winding += 1;
        } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) {
          winding -= 1;
        }
      }
    }
    return rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0;
  }

  /** Hit-tests the stroke by distance to the flattened segments; caps, joins and dashes are not modelled. */
  isPointInStroke(x: number, y: number): boolean;
  isPointInStroke(path: Path2D, x: number, y: number): boolean;
  isPointInStroke(...args: unknown[]): boolean {
    const path = args[0] instanceof Path2D ? args[0] : undefined;
    const offset = path ? 1 : 0;
    const x = Number(args[offset]);
    const y = Number(args[offset + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const [a, b, c, d] = this.state.ctm;
    const det = Math.abs(a * d - b * c);
    if (!Number.isFinite(det) || det === 0) return false;
    const half = (this.state.lineWidth / 2) * Math.sqrt(det);
    const r2 = half * half;
    const subpaths = path ? flattenSubpaths(path.segments, this.state.ctm) : flattenSubpaths(this.path.segments);
    for (const sub of subpaths) {
      const pts = sub.points;
      const count = pts.length;
      if (count < 2) continue;
      for (let i = 0; i + 3 < count; i += 2) {
        if (distToSegmentSq(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!) <= r2) return true;
      }
      if (sub.closed && count >= 2) {
        if (distToSegmentSq(x, y, pts[count - 2]!, pts[count - 1]!, pts[0]!, pts[1]!) <= r2) return true;
      }
    }
    return false;
  }
  drawFocusIfNeeded(): void {}
  scrollPathIntoView(): void {}
}

function distToSegmentSq(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (px - x0) ** 2 + (py - y0) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  const qx = x0 + t * dx;
  const qy = y0 + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

const SPACING_LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|em|rem|pt)?$/i;

function parseSpacing(value: string, fontSize: number): number {
  const match = SPACING_LENGTH.exec(value.trim());
  if (!match) return 0;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = match[2]?.toLowerCase();
  if (unit === undefined) return num === 0 ? 0 : NaN;
  if (num === 0) return 0;
  return unit === 'px' ? num : unit === 'em' ? num * fontSize : unit === 'rem' ? num * 16 : (num * 4) / 3;
}

function lengthText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const match = SPACING_LENGTH.exec(trimmed);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || (match[2] === undefined && num !== 0)) return undefined;
  return trimmed;
}

function finite(value: unknown): number | undefined {
  const v = Number(value);
  return Number.isFinite(v) ? v : undefined;
}
function nonNegative(value: unknown): number | undefined {
  const v = finite(value);
  return v !== undefined && v >= 0 ? v : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function colorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = parseCssColor(value);
  return color === null ? undefined : toCssColor(color);
}

export function createCanvasContext(options: CanvasContextOptions): CanvasContext2D {
  return new CanvasContext2D(options);
}

/** The `url()` filters among `commands` (and the canvases they draw), which are not drawn, each once. */
export function unsupportedFilters(commands: readonly CanvasCommand[]): string[] {
  const found = new Set<string>();
  const visit = (list: readonly CanvasCommand[]): void => {
    for (const command of list) {
      if (command.op === 'clip' || command.op === 'unclip') continue;
      if (command.unsupportedFilter !== undefined) found.add(command.unsupportedFilter);
      if (command.op === 'image' && command.source.kind === 'canvas') visit(command.source.commands);
    }
  };
  visit(commands);
  return [...found];
}

/** The scene layer for a context's drawing: its commands in a box of `width` by `height`. */
export function canvasLayer(context: CanvasContext2D, layer: Omit<CanvasLayer, 'type' | 'commands'>): CanvasLayer {
  return { ...layer, type: 'canvas', commands: context.commands };
}
