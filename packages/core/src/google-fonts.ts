// `@remotion/google-fonts/<Family>` (docs/AUTHORING.md §7.2). The CLI maps an
// import of `@remotion/google-fonts/PlayfairDisplay` onto
// `makeGoogleFont('PlayfairDisplay')`, which returns what that module exports:
// `fontFamily`, `getInfo()` and `loadFont()`.
//
// `loadFont` asks Google's CSS API for the family (it answers a TrueType link
// per weight and style to clients it does not recognise), downloads each file
// once into `~/.cache/kinetograph/fonts`, and registers it. The registration
// is tracked, so the frame loop waits for it before it measures any text.

import { registerFont, trackFontLoad } from './font-registry.js';
import {
  fetchFileCached,
  fetchTextCached,
  FontDownloadError,
  type FontDownloadOptions,
} from './font-files.js';

export type { FetchLike, FetchResponse, FontDownloadOptions } from './font-files.js';

/**
 * Module names whose family name cannot be recovered from their capitals and
 * digits (the cases the splitting rule below gets wrong).
 */
const FAMILY_EXCEPTIONS: Record<string, string> = {
  ABeeZee: 'ABeeZee',
  BioRhyme: 'BioRhyme',
  BioRhymeExpanded: 'BioRhyme Expanded',
  JetBrainsMono: 'JetBrains Mono',
  LibreBarcode128Text: 'Libre Barcode 128 Text',
  LibreBarcode39Text: 'Libre Barcode 39 Text',
  LibreBarcode39ExtendedText: 'Libre Barcode 39 Extended Text',
  McLaren: 'McLaren',
  MPLUS1: 'M PLUS 1',
  MPLUS1Code: 'M PLUS 1 Code',
  MPLUS1p: 'M PLUS 1p',
  MPLUS2: 'M PLUS 2',
  MPLUSRounded1c: 'M PLUS Rounded 1c',
  PressStart2P: 'Press Start 2P',
  RocknRollOne: 'RocknRoll One',
  UnifrakturCook: 'UnifrakturCook',
  UnifrakturMaguntia: 'UnifrakturMaguntia',
  VT323: 'VT323',
};

/**
 * `PlayfairDisplay` → `Playfair Display`: a space before each capital that
 * follows a lowercase letter or digit, and before a capital that starts a word
 * after a run of capitals (`NotoSansJP` → `Noto Sans JP`, `IBMPlexSans` → `IBM Plex Sans`), and before a
 * trailing number. A name that already has a space is a family.
 */
export function familyFromModuleName(name: string): string {
  if (name.includes(' ')) return name;
  const exception = FAMILY_EXCEPTIONS[name];
  if (exception !== undefined) return exception;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d+)$/g, '$1 $2');
}

export type GoogleFontStyle = 'normal' | 'italic';

export interface GoogleFontLoadOptions {
  /** Weights to load, as strings (`'400'`, `'700'`). Default: every weight the family has. */
  weights?: string[];
  /** Accepted for compatibility; the TrueType files hold the whole font, so subsets make no difference. */
  subsets?: string[];
  ignoreTooManyRequestsWarning?: boolean;
}

export interface GoogleFontLoadResult {
  fontFamily: string;
  /** Resolves when every file is downloaded and registered. */
  waitUntilDone: () => Promise<void>;
}

export interface GoogleFontModule {
  fontFamily: string;
  getInfo: () => { fontFamily: string; importName: string };
  loadFont: (style?: GoogleFontStyle, options?: GoogleFontLoadOptions) => GoogleFontLoadResult;
}

const ALL_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];

/** The CSS API URL for a family in one style and a set of weights. */
export function googleFontsCssUrl(family: string, style: GoogleFontStyle, weights: readonly string[]): string {
  const sorted = [...new Set(weights)].sort((a, b) => Number(a) - Number(b));
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const axis =
    style === 'italic'
      ? `ital,wght@${sorted.map((w) => `1,${w}`).join(';')}`
      : `wght@${sorted.join(';')}`;
  return `https://fonts.googleapis.com/css2?family=${name}:${axis}&display=swap`;
}

export interface FontFace {
  family: string;
  style: GoogleFontStyle;
  weight: string;
  url: string;
}

/** The `@font-face` blocks of a CSS answer. */
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(block)?.[1];
    const style = /font-style:\s*(\w+)/.exec(block)?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
    const url = /src:[^;]*?url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/.exec(block)?.[1];
    if (family && weight && url) {
      faces.push({ family, style: style === 'italic' ? 'italic' : 'normal', weight, url });
    }
  }
  return faces;
}

async function faceList(
  family: string,
  style: GoogleFontStyle,
  weights: readonly string[] | undefined,
  options: FontDownloadOptions,
): Promise<FontFace[]> {
  if (weights !== undefined) {
    return parseFontFaces(await fetchTextCached(googleFontsCssUrl(family, style, weights), options));
  }
  // "Every weight": try them all at once, and if the family lacks some (the API refuses the whole request),
  // ask for them one at a time and keep the ones it has.
  try {
    return parseFontFaces(await fetchTextCached(googleFontsCssUrl(family, style, ALL_WEIGHTS), options));
  } catch (error) {
    if (!(error instanceof FontDownloadError) || error.status !== 400) throw error;
  }
  const faces: FontFace[] = [];
  for (const weight of ALL_WEIGHTS) {
    try {
      faces.push(...parseFontFaces(await fetchTextCached(googleFontsCssUrl(family, style, [weight]), options)));
    } catch (error) {
      if (!(error instanceof FontDownloadError) || error.status !== 400) throw error;
    }
  }
  if (faces.length === 0) {
    throw new Error(`Google Fonts has no "${family}" in the ${style} style (or the family name is wrong)`);
  }
  return faces;
}

/**
 * The module `@remotion/google-fonts/<Family>` exports. `familyName` is the
 * module name (`PlayfairDisplay`) or the family itself (`Playfair Display`).
 * `options.fetch` and `options.cacheDir` replace the network and the cache.
 */
export function makeGoogleFont(familyName: string, options: FontDownloadOptions = {}): GoogleFontModule {
  const family = familyFromModuleName(familyName);
  const loaded = new Map<string, Promise<void>>();

  const loadFont = (style: GoogleFontStyle = 'normal', loadOptions: GoogleFontLoadOptions = {}): GoogleFontLoadResult => {
    const weights = loadOptions.weights?.map(String);
    const key = `${style}:${weights?.join(',') ?? '*'}`;
    let done = loaded.get(key);
    if (!done) {
      done = trackFontLoad(
        (async () => {
          const faces = await faceList(family, style, weights, options);
          for (const face of faces) {
            const path = await fetchFileCached(face.url, options);
            registerFont({ family, path, weight: Number(face.weight), style: face.style });
          }
        })(),
      );
      loaded.set(key, done);
    }
    return { fontFamily: family, waitUntilDone: () => done };
  };

  return {
    fontFamily: family,
    getInfo: () => ({ fontFamily: family, importName: familyName.replace(/\s+/g, '') }),
    loadFont,
  };
}
