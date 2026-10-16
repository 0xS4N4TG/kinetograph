// The `Skia` factory of RN-Skia (`Skia.Path.Make()`, `Skia.Color('red')`, ...), as far as drawing from a render needs it.

import { skiaAddon } from './addon.js';
import { registeredFont, SkFont, SkMatrix, SkParagraphBuilder, SkPaint, SkPath, SkRuntimeEffect, type SkParagraphStyle, type SkRRect, type SkRect } from './objects.js';
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
  ParagraphBuilder: {
    Make: (style: SkParagraphStyle = {}): SkParagraphBuilder => new SkParagraphBuilder(style),
  },
};

export { registeredFont };
