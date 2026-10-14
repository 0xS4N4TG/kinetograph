// The font registry (docs/AUTHORING.md §7.2): which font file serves which
// `font` key of the scene. Text must never be measured before its fonts are
// registered, so fonts that are still downloading are tracked here and the
// frame loop waits for them before the first frame.

import { resolve } from 'node:path';
import { fontKey } from '@kinetograph/scene';

export interface FontRegistration {
  family: string;
  path: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
}

const fonts = new Map<string, string>();

/** Registers a font file under the key `<Text font weight fontStyle>` resolves to (`fontKey`). */
export function registerFont(font: FontRegistration): void {
  if (typeof font?.family !== 'string' || font.family === '') {
    throw new TypeError('registerFont() needs a font family name');
  }
  if (typeof font.path !== 'string' || font.path === '') {
    throw new TypeError(`registerFont() needs the path of the font file for "${font.family}"`);
  }
  fonts.set(fontKey(font.family, font.weight, font.style), resolve(font.path));
}

/** fontKey → absolute path, every font registered. */
export function getFonts(): Record<string, string> {
  return Object.fromEntries(fonts);
}

/** Forgets every registered font (tests). */
export function clearFonts(): void {
  fonts.clear();
}

// ---- fonts still loading ----

const pending = new Set<Promise<unknown>>();
let loadError: Error | null = null;

/** Marks a font download as part of the frame loop's wait. A failed download fails the next wait. */
export function trackFontLoad<T>(load: Promise<T>): Promise<T> {
  pending.add(load);
  const done = () => {
    pending.delete(load);
  };
  load.then(done, (error: unknown) => {
    pending.delete(load);
    loadError ??= error instanceof Error ? error : new Error(String(error));
  });
  return load;
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
