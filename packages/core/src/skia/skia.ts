// The `Skia` factory of RN-Skia (`Skia.Path.Make()`, `Skia.Color('red')`, ...), as far as drawing from a render needs it.

import { skiaAddon } from './addon.js';
import { parseSvg, registeredFont, SkFont, SkMatrix, SkParagraphBuilder, SkPaint, SkPath, SkPictureRecorder, SkRuntimeEffect, SkTextBlob, type SkRSXform, type SkParagraphStyle, type SkRRect, type SkRect } from './objects.js';
import { toColor } from './values.js';

export const Skia = {
  /** A colour as four floats from 0 to 1, from a CSS colour string, `0xAARRGGBB`, or floats. */
  Color: (color: unknown): Float32Array => Float32Array.from(toColor(color)),
  XYWHRect: (x: number, y: number, width: number, height: number): SkRect => ({ x, y, width, height }),
  RRectXY: (rect: SkRect, rx: number, ry: number): SkRRect => ({ rect, rx, ry }),
  Point: (x: number, y: number) => ({ x, y }),
  Matrix: (matrix?: number[]): SkMatrix => new SkMatrix(matrix),
  Paint: (): SkPaint => new SkPaint(),
  Path: {
    Make: (): SkPath => new SkPath(),
    MakeFromSVGString: (d: string): SkPath | null => SkPath.fromSvg(d),
    MakeFromOp: (one: SkPath, two: SkPath, op: Parameters<SkPath['op']>[1]): SkPath => one.copy().op(two, op),
  },
  /** The compiled effect, or null if the SkSL does not compile (Skia's message is logged, as RN-Skia does). */
  RuntimeEffect: {
    Make: (sksl: string): SkRuntimeEffect | null => {
      try {
        return new SkRuntimeEffect(sksl, JSON.parse(skiaAddon().compileEffect(sksl)));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
  },
  /** A font from a registered family: `Skia.Font(Skia.FontMgr.System().matchFamilyStyle(...), size)` is `matchFont`. */
  Font: (font: SkFont | null, size = 14): SkFont => {
    if (font === null) throw new Error('Skia.Font() needs a font: there are no system fonts, so use matchFont() or useFont()');
    return new SkFont(font.file, size);
  },
  /** An `SkRSXform`: the matrix `[scos -ssin tx; ssin scos ty]`. */
  RSXform: (scos: number, ssin: number, tx: number, ty: number): SkRSXform => ({ scos, ssin, tx, ty }),
  /** An `SkRSXform` that scales by `scale`, rotates by `radians` about (px, py) and then translates by (tx, ty). */
  RSXformFromRadians: (scale: number, radians: number, tx: number, ty: number, px: number, py: number): SkRSXform => {
    const s = Math.sin(radians) * scale;
    const c = Math.cos(radians) * scale;
    return { scos: c, ssin: s, tx: tx + -c * px + s * py, ty: ty + -s * px - c * py };
  },
  TextBlob: {
    MakeFromText: (text: string, font: SkFont): SkTextBlob => new SkTextBlob({ text }, font),
    MakeFromGlyphs: (glyphs: number[], font: SkFont): SkTextBlob => new SkTextBlob({ glyphs }, font),
    MakeFromRSXform: (text: string, xforms: SkRSXform[], font: SkFont): SkTextBlob => new SkTextBlob({ text, xforms }, font),
    MakeFromRSXformGlyphs: (glyphs: number[], xforms: SkRSXform[], font: SkFont): SkTextBlob =>
      new SkTextBlob({ glyphs, xforms }, font),
  },
  PictureRecorder: (): SkPictureRecorder => new SkPictureRecorder(),
  SVG: {
    /** The parsed SVG, or null if it does not parse. */
    MakeFromString: (svg: string) => parseSvg(svg),
  },
  ParagraphBuilder: {
    Make: (style: SkParagraphStyle = {}): SkParagraphBuilder => new SkParagraphBuilder(style),
  },
};

export { registeredFont };
