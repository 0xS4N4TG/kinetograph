// `@remotion/layout-utils`: `measureText`, `fitText`, `fillTextBox` and `fitTextOnNLines`.
//
// Remotion measures text in the browser; here the renderer's own text engine
// does it (`layoutText` in `@kinetograph/native`), so a measurement is what the
// renderer will draw. The fonts are the ones registered (`getFonts()`), and text
// is never measured before they are: a font that is not registered, or one still
// downloading, is an error rather than a measurement with a stand-in font. A download in flight is finished first
// with the thread blocked (`finishFontLoadsSync`), which is how a `measureText` at module load gets its font.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { TextLayout, TextLayoutRequest } from '@kinetograph/native';
import { fontKey } from '@kinetograph/scene';
import { finishFontLoadsSync, fontGeneration, getFonts, pendingFontLoads } from './font-registry.js';

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

/** Checks the size and that the font is registered and loaded; returns the font key. */
function checkedFont(options: MeasureTextOptions, text: string): string {
  const { fontFamily, fontSize, fontWeight, fontStyle } = options;
  if (typeof fontSize !== 'number' || !(fontSize > 0)) {
    throw new TypeError(`fontSize must be a positive number, but got ${JSON.stringify(fontSize)}`);
  }
  const key = fontKey(fontFamily, fontWeight, fontStyle);
  // Measuring cannot wait (at a module's top level nothing is awaited), so the downloads that can be finished here are.
  if (pendingFontLoads() > 0) finishFontLoadsSync();
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
  return key;
}

function layoutOf(options: MeasureTextOptions, text: string, maxWidth?: number): TextLayout {
  const key = checkedFont(options, text);
  return layoutText({ text, font: key, size: options.fontSize, fonts: getFonts(), ...(maxWidth === undefined ? {} : { maxWidth }) });
}

/**
 * Measures text as the DOM engine lays out a `span` (packages/cli/skills/kinetograph/references/ENGINE.md §10): the node bundle installs this, so that
 * `measureText` and `fitText` give what `getBoundingClientRect` gives in Chrome, with `letterSpacing`, `textTransform`
 * and `additionalStyles` applied by CSS. It returns null where the DOM engine is not there; the text engine's own
 * measure (`layoutText`) answers then.
 */
export type DomTextMeasure = (options: MeasureTextOptions, fonts: Record<string, string>) => TextMetrics | null;

let domMeasure: DomTextMeasure | null = null;

export function setDomTextMeasure(fn: DomTextMeasure | null): void {
  domMeasure = fn;
  measured.clear();
}

// `measureText` is a pure function of its options and the registered fonts, and the DOM engine builds a whole
// document per call, so the answers are kept: keyed on every option and the font generation, oldest out first.
const MEASURE_CACHE_SIZE = 2048;
const measured = new Map<string, TextMetrics>();
let measuredGeneration = -1;

/** The size of `text` in one font, as the renderer lays it out. A newline starts another line. */
export function measureText(options: MeasureTextOptions): TextMetrics {
  let key: string | undefined;
  try {
    key = JSON.stringify(options);
  } catch {
    key = undefined; // not serialisable (a cycle): measure it every time
  }
  if (key === undefined) return measureTextUncached(options);
  if (measuredGeneration !== fontGeneration()) {
    measured.clear();
    measuredGeneration = fontGeneration();
  }
  const hit = measured.get(key);
  if (hit !== undefined) return { ...hit };
  const metrics = measureTextUncached(options);
  // A measurement that registered a font (a download finishing) is stale already.
  if (measuredGeneration === fontGeneration()) {
    if (measured.size >= MEASURE_CACHE_SIZE) measured.delete(measured.keys().next().value as string);
    measured.set(key, { ...metrics });
  }
  return metrics;
}

function measureTextUncached(options: MeasureTextOptions): TextMetrics {
  const { text, fontSize, letterSpacing, textTransform } = options;
  if (domMeasure !== null) {
    checkedFont(options, text);
    const measured = domMeasure(options, getFonts());
    if (measured !== null) return measured;
  }
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

export type FillTextBoxAdd = MeasureTextOptions;

/**
 * Fills a box with text piece by piece, as Remotion's does. `add` puts a piece on the current line if the line,
 * measured piece by piece and rounded up, still fits `maxBoxWidth`; if not, on the next line (`newLine`, its leading
 * space dropped) unless that is past `maxLines` or the piece alone is wider than the box (`exceedsBox`, and the box
 * is unchanged).
 */
export function fillTextBox({ maxBoxWidth, maxLines }: FillTextBoxOptions): {
  add: (piece: FillTextBoxAdd) => { exceedsBox: boolean; newLine: boolean };
} {
  const lines: FillTextBoxAdd[][] = Array.from({ length: maxLines }, () => []);
  // The same piece is measured on every `add` of its line, and its answer does not change.
  const widths = new Map<string, number>();
  const widthOf = (piece: FillTextBoxAdd): number => {
    const key = JSON.stringify([piece.text, piece.fontFamily, piece.fontWeight, piece.fontStyle, piece.fontSize, piece.letterSpacing, piece.textTransform, piece.fontVariantNumeric, piece.additionalStyles]);
    let width = widths.get(key);
    if (width === undefined) widths.set(key, (width = measureText(piece).width));
    return width;
  };
  return {
    add(piece) {
      // The current line is the last one that holds anything.
      const current = Math.max(0, lines.findLastIndex((line) => line.length > 0));
      const line = lines[current]!;
      const total = [...line, piece].reduce((sum, entry) => sum + widthOf(entry), 0);
      if (Math.ceil(total) <= maxBoxWidth) {
        line.push(line.length === 0 ? { ...piece, text: piece.text.trimStart() } : piece);
        return { exceedsBox: false, newLine: false };
      }
      if (current === maxLines - 1) return { exceedsBox: true, newLine: false };
      const first = { ...piece, text: piece.text.trimStart() };
      if (Math.ceil(widthOf(first)) > maxBoxWidth) return { exceedsBox: true, newLine: false };
      lines[current + 1] = [first];
      return { exceedsBox: false, newLine: true };
    },
  };
}

export interface FitTextOnNLinesOptions extends Omit<MeasureTextOptions, 'text' | 'fontSize'> {
  text: string;
  maxLines: number;
  maxBoxWidth: number;
  /** The largest size tried. Default 2000. */
  maxFontSize?: number;
}

/** Sizes are searched in hundredths of a pixel. */
const FIT_PRECISION = 100;
const FIT_MIN_FONT_SIZE = 0.1;

/**
 * The largest font size (to a hundredth) at which `text`, broken at its spaces, fits in at most `maxLines` lines of
 * `maxBoxWidth`, and the lines it breaks into. Found by bisection on the size, filling a box at each; the text is
 * the smallest size, on one line, when nothing fits.
 */
export function fitTextOnNLines({ text, maxLines, maxBoxWidth, maxFontSize, ...style }: FitTextOnNLinesOptions): { fontSize: number; lines: string[] } {
  let low = Math.floor(FIT_MIN_FONT_SIZE * FIT_PRECISION);
  let high = Math.floor((maxFontSize ?? 2000) * FIT_PRECISION);
  let fontSize = FIT_MIN_FONT_SIZE;
  let best: string[] = [];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const size = middle / FIT_PRECISION;
    const box = fillTextBox({ maxBoxWidth, maxLines });
    const lines = [''];
    let exceedsBox = false;
    for (const word of text.split(' ')) {
      const current = lines.length - 1;
      const result = box.add({ ...style, text: lines[current]!.length === 0 ? word : ` ${word}`, fontSize: size });
      if (result.exceedsBox) {
        exceedsBox = true;
        break;
      }
      if (result.newLine) lines.push('');
      lines[lines.length - 1] += `${word} `;
    }
    if (!exceedsBox && lines.length - 1 < maxLines) {
      fontSize = size;
      best = lines;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { fontSize, lines: best.map((line) => line.trimEnd()) };
}
