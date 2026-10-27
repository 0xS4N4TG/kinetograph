// The `Skia` factory of RN-Skia (`Skia.Path.Make()`, `Skia.Color('red')`, ...), as far as drawing from a render needs it.

import { getFallbackFont, getFonts } from '../font-registry.js';
import { reportUnsupported } from '../unsupported.js';
import { skiaAddon } from './addon.js';
import {
  AnimatedImageFactory,
  DataFactory,
  FontMgrFactory,
  ImageFactory,
  SkTypefaceFontProvider,
  TypefaceFactory,
  TypefaceFontProviderFactory,
} from './data.js';
import { ColorFilterFactory, ImageFilterFactory, MaskFilterFactory, PathEffectFactory, ShaderFactory, SkRuntimeShaderBuilder } from './factories.js';
import {
  parseSvg,
  registeredFont,
  SkFont,
  SkMatrix,
  SkParagraphBuilder,
  SkPaint,
  SkPath,
  SkPictureRecorder,
  SkRuntimeEffect,
  SkTextBlob,
  SkTypeface,
  type SkRSXform,
  type SkParagraphStyle,
  type SkRRect,
  type SkRect,
} from './objects.js';
import { SurfaceFactory } from './surface.js';
import { toColor } from './values.js';

/** The font a `Skia.Font()` without a typeface uses: the first registered font, else the fallback (no system fonts). */
function defaultFace(): { file: string } {
  const file = Object.values(getFonts())[0] ?? getFallbackFont();
  if (file === undefined || file === null) {
    throw new Error('Skia.Font() needs a font: there are no system fonts, so register one with loadFont() or use useFont()');
  }
  reportUnsupported('SkiaCanvas', 'Skia.Font', null, 'a font without a typeface is the system default in RN-Skia; there are no system fonts, so the first registered font (or the fallback) is used');
  return { file };
}

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
  /** A font of a typeface (`Skia.Typeface.*`, `Skia.FontMgr.System().matchFamilyStyle(...)`) or of another font, at `size`. */
  Font: (typeface?: SkTypeface | SkFont | null, size = 14): SkFont => new SkFont(typeface ? typeface.face : defaultFace(), size),
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
  /** With a `Skia.TypefaceFontProvider`, the paragraph's families are the provider's; else the registered fonts. */
  ParagraphBuilder: {
    Make: (style: SkParagraphStyle = {}, fontProvider?: SkTypefaceFontProvider | null): SkParagraphBuilder =>
      new SkParagraphBuilder(style, fontProvider ? () => fontProvider.paragraphFonts() : undefined),
  },
  Shader: ShaderFactory,
  ColorFilter: ColorFilterFactory,
  ImageFilter: ImageFilterFactory,
  MaskFilter: MaskFilterFactory,
  PathEffect: PathEffectFactory,
  RuntimeShaderBuilder: (effect: SkRuntimeEffect): SkRuntimeShaderBuilder => new SkRuntimeShaderBuilder(effect),
  Data: DataFactory,
  Image: ImageFactory,
  AnimatedImage: AnimatedImageFactory,
  Typeface: TypefaceFactory,
  FontMgr: FontMgrFactory,
  TypefaceFontProvider: TypefaceFontProviderFactory,
  Surface: SurfaceFactory,
};

export { registeredFont };
