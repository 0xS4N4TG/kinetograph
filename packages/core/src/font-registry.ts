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
  /** The top of the weight range of a variable face (`font-weight: 300 1000`); `weight` is the bottom. */
  weightMax?: number | string;
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
  fonts.set(fontKey(font.family, font.weight, font.style, font.weightMax), resolve(font.path));
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

/** The file of the built-in fallback font, or null when the host gave none. */
export function getFallbackFont(): string | null {
  return fallbackPath;
}

/** fontKey → absolute path, every font registered (the built-in fallback alone when there is none). */
export function getFonts(): Record<string, string> {
  if (fonts.size === 0 && fallbackPath !== null) return { [FALLBACK_FONT_KEY]: fallbackPath };
  return Object.fromEntries(fonts);
}

interface ParsedKey {
  family: string;
  /** The weight, or the bottom of a variable face's range. */
  weight: number;
  weightMax: number;
  italic: boolean;
}

/** A `fontKey` taken apart: `Inter`, `Inter:700`, `Inter:400i`, `Inter:100-900`. */
function parseFontKey(key: string): ParsedKey {
  const match = /^(.*):(\d+)(?:-(\d+))?(i)?$/.exec(key);
  if (match === null) return { family: key, weight: 400, weightMax: 400, italic: false };
  const weight = Number(match[2]);
  return { family: match[1]!, weight, weightMax: match[3] === undefined ? weight : Number(match[3]), italic: match[4] === 'i' };
}

/**
 * The registered key a request for `key` is set in, by CSS font matching (CSS Fonts 4 §5.2): the same family (any case)
 * and style, then the other style; within that, the weight itself, else for 400 to 500 the next heavier up to 500, then
 * lighter, then heavier; for under 400 lighter then heavier; for over 500 heavier then lighter. A face with a weight range
 * counts as the weight in its range nearest the request. Null when the family has no registered face.
 */
export function matchFontKey(registered: Iterable<string>, key: string): string | null {
  const wanted = parseFontKey(key);
  const faces = [...registered]
    .map((name) => ({ name, ...parseFontKey(name) }))
    .filter((face) => face.family.toLowerCase() === wanted.family.toLowerCase());
  const sameStyle = faces.filter((face) => face.italic === wanted.italic);
  const pool = sameStyle.length > 0 ? sameStyle : faces;
  const w = wanted.weight;
  // The weight each face is drawn at for this request.
  const drawnAt = (face: { weight: number; weightMax: number }): number => Math.min(Math.max(w, face.weight), face.weightMax);
  const order = (list: typeof pool, ascending: boolean) =>
    [...list].sort((a, b) => (ascending ? drawnAt(a) - drawnAt(b) : drawnAt(b) - drawnAt(a)));
  const exact = pool.find((face) => drawnAt(face) === w);
  if (exact) return exact.name;
  const heavier = pool.filter((face) => drawnAt(face) > w);
  const lighter = pool.filter((face) => drawnAt(face) < w);
  let candidates: typeof pool;
  if (w >= 400 && w <= 500) {
    candidates = [...order(heavier.filter((f) => drawnAt(f) <= 500), true), ...order(lighter, false), ...order(heavier.filter((f) => drawnAt(f) > 500), true)];
  } else if (w < 400) {
    candidates = [...order(lighter, false), ...order(heavier, true)];
  } else {
    candidates = [...order(heavier, true), ...order(lighter, false)];
  }
  return candidates[0]?.name ?? null;
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
