// The font registry (packages/cli/skills/kinetograph/references/AUTHORING.md §7.2): which font file serves which
// `font` key of the scene. Text must never be measured before its fonts are
// registered, so fonts that are still downloading are tracked here and the
// frame loop waits for them before the first frame.

import { resolve } from 'node:path';
import { fontKey } from '@kinetographdev/scene';

export interface FontRegistration {
  family: string;
  path: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
}

const fonts = new Map<string, string>();
let generation = 0;

/** Changes whenever the registered fonts do, so a cache of anything measured with them knows to drop it. */
export function fontGeneration(): number {
  return generation;
}

/** Registers a font file under the key `<Text font weight fontStyle>` resolves to (`fontKey`). */
export function registerFont(font: FontRegistration): void {
  if (typeof font?.family !== 'string' || font.family === '') {
    throw new TypeError('registerFont() needs a font family name');
  }
  if (typeof font.path !== 'string' || font.path === '') {
    throw new TypeError(`registerFont() needs the path of the font file for "${font.family}"`);
  }
  fonts.set(fontKey(font.family, font.weight, font.style), resolve(font.path));
  generation++;
}

/** The key the built-in fallback font is registered under; the same one the DOM engine reports text set in it by. */
export const FALLBACK_FONT_KEY = 'Kinetograph Fallback';
let fallbackPath: string | null = null;

/**
 * The font file the host ships for text when the project registered no font. Kinetograph reads no system fonts, so
 * without one such text would not be drawn at all; with it, the text is drawn and reported as approximated.
 */
export function setFallbackFont(path: string | null): void {
  fallbackPath = path === null ? null : resolve(path);
  generation++;
}

/** fontKey → absolute path, every font registered (the built-in fallback alone when there is none). */
export function getFonts(): Record<string, string> {
  if (fonts.size === 0 && fallbackPath !== null) return { [FALLBACK_FONT_KEY]: fallbackPath };
  return Object.fromEntries(fonts);
}

/** Forgets every registered font (tests). */
export function clearFonts(): void {
  fonts.clear();
  generation++;
}

// ---- fonts still loading ----

const pending = new Set<Promise<unknown>>();
// What finishes a pending download with the thread blocked, for the ones that have it.
const finishers = new Map<Promise<unknown>, () => void>();
let loadError: Error | null = null;

/**
 * Marks a font download as part of the frame loop's wait. A failed download fails the next wait. `finishSync` does
 * the same work with the thread blocked (download, then register): `finishFontLoadsSync` runs it where text is
 * measured at once and cannot wait, as at a module's top level.
 */
export function trackFontLoad<T>(load: Promise<T>, finishSync?: () => void): Promise<T> {
  pending.add(load);
  if (finishSync) finishers.set(load, finishSync);
  const done = () => {
    pending.delete(load);
    finishers.delete(load);
  };
  load.then(done, (error: unknown) => {
    done();
    loadError ??= error instanceof Error ? error : new Error(String(error));
  });
  return load;
}

/**
 * Finishes every pending download that can be finished without waiting, so that the font is registered when this
 * returns. A failure is thrown. Downloads without a synchronous way stay pending.
 */
export function finishFontLoadsSync(): void {
  for (const [load, finish] of [...finishers]) {
    finish();
    pending.delete(load);
    finishers.delete(load);
  }
}

// ---- fonts that could not be had ----

type ProblemHandler = (message: string) => void;
let problemHandler: ProblemHandler | null = null;

/** Where `noteFontProblem` goes (the DOM shim's stylesheet notes, which `doctor` and `lint` print). Default: a console warning. */
export function setFontProblemHandler(handler: ProblemHandler | null): void {
  problemHandler = handler;
}

/**
 * A font that could not be had and does not stop the project from loading (a remote face that did not download). The
 * text that uses it is reported as a missing font; this says why.
 */
export function noteFontProblem(message: string): void {
  if (problemHandler) problemHandler(message);
  else console.warn(message);
}

/** Resolves when every tracked font download is done; rejects if one failed. */
export async function waitForFonts(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  if (loadError) {
    const error = loadError;
    loadError = null;
    throw error;
  }
}

export function pendingFontLoads(): number {
  return pending.size;
}
