// `@remotion/layout-utils`: `measureText`, `fitText` and `fillTextBox`.
//
// Remotion measures text in the browser; here the renderer's own text engine
// does it (`layoutText` in `@kinetograph/native`), so a measurement is what the
// renderer will draw. The fonts are the ones registered (`getFonts()`), and text
// is never measured before they are: a font that is not registered, or one still
// downloading, is an error rather than a measurement with a stand-in font.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { TextLayout, TextLayoutRequest } from '@kinetograph/native';
import { fontKey } from '@kinetograph/scene';
import { getFonts, pendingFontLoads } from './font-registry.js';

type LayoutText = (request: TextLayoutRequest) => TextLayout;

let layoutOverride: LayoutText | null = null;
let layoutNative: LayoutText | null = null;

/** Replaces the text engine (tests; pass `null` to go back to the addon). */
export function setLayoutText(fn: LayoutText | null): void {
  layoutOverride = fn;
}

/**
 * The addon's `layoutText`, found when first needed (a project that never measures text does not need the
 * addon): from here, then from the working directory. A bundle in a project's cache may sit where neither
 * reaches it; the host then calls `setLayoutText(native.layoutText)`.
 */
function loadNative(): LayoutText {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return (createRequire(base)('@kinetograph/native') as { layoutText: LayoutText }).layoutText;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `Text cannot be measured: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its layoutText to setLayoutText() from @kinetograph/core/layout-utils.',
  );
}

function layoutText(request: TextLayoutRequest): TextLayout {
  if (layoutOverride) return layoutOverride(request);
  layoutNative ??= loadNative();
  return layoutNative(request);
}

export interface MeasureTextOptions {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: string | number;
  fontStyle?: 'normal' | 'italic';
  letterSpacing?: string | number;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Accepted for compatibility; the font must be registered either way. */
  validateFontIsLoaded?: boolean;
  fontVariantNumeric?: string;
  additionalStyles?: Record<string, unknown>;
}

export interface TextMetrics {
  width: number;
  height: number;
}

function transformed(text: string, how: MeasureTextOptions['textTransform']): string {
  if (how === 'uppercase') return text.toUpperCase();
  if (how === 'lowercase') return text.toLowerCase();
  if (how === 'capitalize') return text.replace(/(^|\s)(\S)/g, (_m, space: string, ch: string) => space + ch.toUpperCase());
  return text;
}

function pixels(value: string | number | undefined, fontSize: number): number {
  if (value === undefined || value === 'normal') return 0;
  if (typeof value === 'number') return value;
  const match = /^\s*(-?\d*\.?\d+)(px|em)?\s*$/.exec(value);
  if (!match) return 0;
  return match[2] === 'em' ? Number(match[1]) * fontSize : Number(match[1]);
}

function layoutOf(options: MeasureTextOptions, text: string, maxWidth?: number): TextLayout {
  const { fontFamily, fontSize, fontWeight, fontStyle } = options;
  if (typeof fontSize !== 'number' || !(fontSize > 0)) {
    throw new TypeError(`fontSize must be a positive number, but got ${JSON.stringify(fontSize)}`);
  }
  const key = fontKey(fontFamily, fontWeight, fontStyle);
  if (pendingFontLoads() > 0) {
    throw new Error(
      `Text was measured while a font is still downloading. Wait for it (loadFont(...).waitUntilDone()) before measuring "${text}" in ${key}.`,
    );
  }
  const fonts = getFonts();
  if (!(key in fonts)) {
    const known = Object.keys(fonts);
    throw new Error(
      `Cannot measure text in the font "${key}": it is not registered. Register it with registerFont(), loadFont() or a Google Fonts module first.${
        known.length > 0 ? ` Registered: ${known.map((k) => `"${k}"`).join(', ')}.` : ' No fonts are registered.'
      }`,
    );
  }
  return layoutText({ text, font: key, size: fontSize, fonts, ...(maxWidth === undefined ? {} : { maxWidth }) });
}

/** The size of `text` in one font, as the renderer lays it out. A newline starts another line. */
export function measureText(options: MeasureTextOptions): TextMetrics {
  const { text, fontSize, letterSpacing, textTransform } = options;
  const shown = transformed(text, textTransform);
  // Space at either end counts (CSS `white-space: pre`); the engine trims it, so measure with a marker either side.
  const padded = /^\s|\s$/.test(shown);
  const layout = layoutOf(options, padded ? `|${shown}|` : shown);
  let width = layout.width;
  if (padded) width -= layoutOf(options, '||').width;
  const spacing = pixels(letterSpacing, fontSize);
  if (spacing !== 0) width += spacing * Array.from(shown.replace(/\n/g, '')).length;
  return { width, height: layout.height };
}

export interface FitTextOptions extends Omit<MeasureTextOptions, 'fontSize'> {
  withinWidth: number;
}

/** The largest font size at which `text` is no wider than `withinWidth`. */
export function fitText(options: FitTextOptions): { fontSize: number } {
  const { withinWidth, ...rest } = options;
  if (typeof withinWidth !== 'number' || !(withinWidth > 0)) {
    throw new TypeError(`withinWidth must be a positive number, but got ${JSON.stringify(withinWidth)}`);
  }
  // Text is as wide as it is big, so one measurement at a round size is enough.
  const reference = 100;
  const { width } = measureText({ ...rest, fontSize: reference });
  return { fontSize: (withinWidth / width) * reference };
}

export interface FillTextBoxOptions {
  maxBoxWidth: number;
  maxLines: number;
}

export interface FillTextBoxAdd extends Omit<MeasureTextOptions, 'text'> {
  text: string;
}

/**
 * Fills a box with text piece by piece. `add` reports whether the piece began a
 * new line and whether the box is now overfull (too many lines, or a piece wider
 * than the box).
 */
export function fillTextBox({ maxBoxWidth, maxLines }: FillTextBoxOptions): {
  add: (piece: FillTextBoxAdd) => { exceedsBox: boolean; newLine: boolean };
} {
  let lines = 1;
  let lineWidth = 0;
  return {
    add(piece) {
      const { width } = measureText(piece);
      let newLine = false;
      if (lineWidth > 0 && lineWidth + width > maxBoxWidth) {
        newLine = true;
        lines++;
        lineWidth = width;
      } else {
        lineWidth += width;
      }
      return { exceedsBox: lines > maxLines || width > maxBoxWidth, newLine };
    },
  };
}
