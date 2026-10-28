// RN-Skia's `Skia.Data`, `Skia.Image`, `Skia.Typeface`, `Skia.FontMgr`, `Skia.TypefaceFontProvider` and
// `Skia.AnimatedImage` factories. Bytes are handed to the addon once (`putData`) and named by their content, so a tree
// carries the name; there are no system fonts, so a font manager's families are the registered fonts.

import { readFileSync } from 'node:fs';
import { getDomEnvironment } from '@kinetographdev/compat/dom';
import { getFonts } from '../font-registry.js';
import { skiaAddon } from './addon.js';
import { projectFile, SkImage, SkTypeface, type FontFace, type ParagraphFont } from './objects.js';

/** `SkData`: bytes the addon keeps, by the name it gave them. */
export class SkData {
  constructor(
    readonly id: string,
    private readonly length: number,
  ) {}
  size(): number {
    return this.length;
  }
  toJSON(): { data: string } {
    return { data: this.id };
  }
}

function keep(bytes: Uint8Array): SkData {
  return new SkData(skiaAddon().putData(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)), bytes.byteLength);
}

/** The bytes at `uri`: a project file (`staticFile('a.png')`, a path) or a `data:` URI. */
function readUri(uri: string): Uint8Array {
  const data = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (data) return data[1] ? Buffer.from(data[2]!, 'base64') : Buffer.from(decodeURIComponent(data[2]!));
  if (/^https?:\/\//.test(uri)) {
    throw new Error(`Skia.Data.fromURI("${uri}"): a render reads only files of the project; download it into public/ and use staticFile()`);
  }
  return readFileSync(projectFile(uri, 'file'));
}

export const DataFactory = {
  fromBytes: (bytes: Uint8Array): SkData => keep(bytes),
  fromBase64: (base64: string): SkData => keep(Buffer.from(base64, 'base64')),
  /** The file is read at once; the promise is settled when it returns. */
  fromURI: (uri: string): Promise<SkData> => {
    try {
      return Promise.resolve(keep(readUri(uri)));
    } catch (error) {
      return Promise.reject(error);
    }
  },
};

/** RN-Skia's `ColorType` and `AlphaType` numbers, for `Skia.Image.MakeImage`. */
export const ColorType = { Alpha_8: 1, RGBA_8888: 4, BGRA_8888: 6, Gray_8: 11, RGBA_F16: 13, RGBA_F32: 14 } as const;
export const AlphaType = { Opaque: 1, Premul: 2, Unpremul: 3 } as const;
const COLOR_TYPES: Record<number, string> = { 1: 'alpha8', 4: 'rgba8888', 6: 'bgra8888', 11: 'gray8', 13: 'rgbaf16', 14: 'rgbaf32' };
const ALPHA_TYPES: Record<number, string> = { 1: 'opaque', 2: 'premul', 3: 'unpremul' };

export interface ImageInfo {
  width: number;
  height: number;
  colorType: number;
  alphaType: number;
}

/** The size the addon reads for a picture. */
function sizeOf(source: Record<string, unknown>): { width: number; height: number } {
  return JSON.parse(skiaAddon().imageCall(JSON.stringify({ image: source, call: 'size', baseDir: getDomEnvironment().baseDir ?? '' })));
}

export const ImageFactory = {
  /** The picture in encoded bytes (PNG, JPEG, WebP, GIF), or null if they are not one. */
  MakeImageFromEncoded: (data: SkData): SkImage | null => {
    try {
      const source = { data: data.id };
      return new SkImage(source, sizeOf(source));
    } catch {
      return null;
    }
  },
  /** A picture of raw pixels: `info` gives the size and the layout, `bytesPerRow` the stride. */
  MakeImage: (info: ImageInfo, data: SkData, bytesPerRow?: number): SkImage | null => {
    const colorType = COLOR_TYPES[info.colorType];
    const alphaType = ALPHA_TYPES[info.alphaType];
    if (colorType === undefined || alphaType === undefined) return null;
    const source = { pixels: data.id, width: info.width, height: info.height, colorType, alphaType, ...(bytesPerRow ? { rowBytes: bytesPerRow } : {}) };
    try {
      return new SkImage(source, sizeOf(source));
    } catch {
      return null;
    }
  },
};

// ---- typefaces and font managers ----

export interface FontStyle {
  weight?: number;
  width?: number;
  slant?: number | 'upright' | 'italic' | 'oblique';
}

const weightOf = (key: string): number => {
  const m = /:(\d+)i?$/.exec(key);
  return m ? Number(m[1]) : 400;
};
const italicOf = (key: string): boolean => key.endsWith('i') && key.includes(':');

/** The registered faces, by family. */
function registeredFaces(): { family: string; file: string; weight: number; italic: boolean }[] {
  return Object.entries(getFonts()).map(([key, file]) => ({ family: key.split(':')[0]!, file, weight: weightOf(key), italic: italicOf(key) }));
}

/** The face of `faces` nearest to `style`, as CSS matching picks: the same slant first, then the nearest weight. */
function nearest<T extends { weight: number; italic: boolean }>(faces: T[], style: FontStyle = {}): T | undefined {
  const italic = style.slant === 1 || style.slant === 2 || style.slant === 'italic' || style.slant === 'oblique';
  const weight = style.weight ?? 400;
  return [...faces].sort((a, b) => Number(a.italic !== italic) - Number(b.italic !== italic) || Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];
}

/** `Skia.FontMgr.System()`: the registered fonts (there are no system fonts). */
export class SkFontMgr {
  private families(): string[] {
    return [...new Set(registeredFaces().map((f) => f.family))];
  }
  countFamilies(): number {
    return this.families().length;
  }
  getFamilyName(index: number): string {
    return this.families()[index] ?? '';
  }
  /** The registered face of `family` nearest to `style`, or null when the family is not registered. */
  matchFamilyStyle(family: string, style?: FontStyle): SkTypeface | null {
    const face = nearest(registeredFaces().filter((f) => f.family.toLowerCase() === family.toLowerCase()), style);
    return face ? new SkTypeface({ file: face.file }, face.family) : null;
  }
}

/** `Skia.TypefaceFontProvider.Make()`: typefaces under family names, for `Skia.ParagraphBuilder.Make(style, provider)`. */
export class SkTypefaceFontProvider {
  private readonly faces: ParagraphFont[] = [];
  registerFont(typeface: SkTypeface, familyName: string): void {
    this.faces.push({ family: familyName, ...typeface.face });
  }
  countFamilies(): number {
    return new Set(this.faces.map((f) => f.family)).size;
  }
  getFamilyName(index: number): string {
    return [...new Set(this.faces.map((f) => f.family))][index] ?? '';
  }
  matchFamilyStyle(family: string): SkTypeface | null {
    const face = this.faces.find((f) => f.family === family);
    if (!face) return null;
    const { family: name, ...rest } = face;
    return new SkTypeface(rest as FontFace, name);
  }
  /** The fonts a paragraph built with this provider uses. */
  paragraphFonts(): ParagraphFont[] {
    return [...this.faces];
  }
}

export const TypefaceFactory = {
  /** The typeface in font bytes, or null if they are not a font (the addon checks when it draws). */
  MakeFreeTypeFaceFromData: (data: SkData): SkTypeface | null => new SkTypeface({ data: data.id }),
};

export const FontMgrFactory = {
  System: (): SkFontMgr => new SkFontMgr(),
  RefDefault: (): SkFontMgr => new SkFontMgr(),
};

export const TypefaceFontProviderFactory = {
  Make: (): SkTypefaceFontProvider => new SkTypefaceFontProvider(),
};

// ---- animated pictures ----

/**
 * `SkAnimatedImage`: the frames of an animated GIF or WebP. `decodeNextFrame()` steps through them as RN-Skia's does;
 * nothing here runs on the clock, so a frame of the film picks its picture by time (`useAnimatedImageValue`).
 */
export class SkAnimatedImage {
  private index = 0;
  private info: { count: number; durations: number[] } | null = null;
  constructor(private readonly source: { src: string } | { data: string }) {}

  private frames(): { count: number; durations: number[] } {
    this.info ??= JSON.parse(skiaAddon().imageCall(JSON.stringify({ image: this.source, call: 'frames', baseDir: getDomEnvironment().baseDir ?? '' })));
    return this.info!;
  }
  getFrameCount(): number {
    return this.frames().count;
  }
  /** How long the current frame is shown, in milliseconds. */
  currentFrameDuration(): number {
    return this.frames().durations[this.index] ?? 0;
  }
  /** Moves to the next frame, looping, and answers how long it is shown. */
  decodeNextFrame(): number {
    this.index = (this.index + 1) % Math.max(1, this.getFrameCount());
    return this.currentFrameDuration();
  }
  getCurrentFrame(): SkImage | null {
    return this.frameAt({ frame: this.index });
  }
  /** The frame shown `ms` milliseconds after the start, looping. */
  frameAtTime(ms: number): SkImage | null {
    return this.frameAt({ time: ms });
  }
  /** The duration of one loop, in milliseconds. */
  duration(): number {
    return this.frames().durations.reduce((a, b) => a + b, 0);
  }
  private frameAt(which: { frame: number } | { time: number }): SkImage | null {
    const source = { ...this.source, ...which };
    try {
      return new SkImage(source, sizeOf(source));
    } catch {
      return null;
    }
  }
  dispose(): void {}
}

export const AnimatedImageFactory = {
  MakeAnimatedImageFromEncoded: (data: SkData): SkAnimatedImage | null => {
    const image = new SkAnimatedImage({ data: data.id });
    try {
      image.getFrameCount();
      return image;
    } catch {
      return null;
    }
  },
};
