// RN-Skia's hooks for files and fonts. A render is synchronous, so a file is read when the hook runs and the result is
// there on the first frame; a file that is missing throws, with its name.

import { existsSync, readFileSync } from 'node:fs';
import { getDomEnvironment } from '@kinetographdev/compat/dom';
import { skiaAddon } from './addon.js';
import { SkTypefaceFontProvider } from './data.js';
import { parseSvg, projectFile, registeredFont, SkFont, SkImage, SkTypeface, type SkSVG } from './objects.js';

/** The picture in a project file (`staticFile('a.png')`, or a path or an import the bundle resolves), or null for null. */
export function useImage(source: string | null | undefined): SkImage | null {
  if (source === null || source === undefined) return null;
  const src = projectFile(source, 'picture');
  const size = JSON.parse(skiaAddon().imageSize(JSON.stringify({ src, baseDir: getDomEnvironment().baseDir ?? '' })));
  return new SkImage({ src }, size);
}

/** The SVG in a project file (`staticFile('a.svg')`), or null for null; a file that is not an SVG gives null as RN-Skia's does. */
export function useSVG(source: string | null | undefined): SkSVG | null {
  if (source === null || source === undefined) return null;
  return parseSvg(readFileSync(projectFile(source, 'SVG file'), 'utf8'));
}

/** The font file at `source` (a project file) at `size`, or null for null. */
export function useFont(source: string | null | undefined, size = 14): SkFont | null {
  if (source === null || source === undefined) return null;
  return new SkFont(projectFile(source, 'font file'), size);
}

export interface FontStyleDescription {
  fontFamily: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic';
}

/** The font registered for the family, weight and style (there are no system fonts to match from). */
export function matchFont({ fontFamily, fontSize = 14, fontWeight, fontStyle }: FontStyleDescription): SkFont {
  const file = registeredFont(fontFamily, fontWeight, fontStyle === 'italic' ? 'italic' : 'normal');
  if (!existsSync(file)) throw new Error(`The font file ${file} of "${fontFamily}" does not exist`);
  return new SkFont(file, fontSize);
}

/** The typeface in a project's font file, or null for null. */
export function useTypeface(source: string | null | undefined): SkTypeface | null {
  if (source === null || source === undefined) return null;
  return new SkTypeface({ file: projectFile(source, 'font file') });
}

/** RN-Skia's `useFonts({ Family: [files] })`: a font provider with those faces, for `Skia.ParagraphBuilder.Make(style, provider)`. */
export function useFonts(sources: Record<string, string[]>): SkTypefaceFontProvider {
  const provider = new SkTypefaceFontProvider();
  for (const [family, files] of Object.entries(sources)) {
    for (const file of files) provider.registerFont(new SkTypeface({ file: projectFile(file, 'font file') }), family);
  }
  return provider;
}
