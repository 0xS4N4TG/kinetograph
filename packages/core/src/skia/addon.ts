// The optional Skia addon (`@kinetographdev/skia`, packages/cli/skills/kinetograph/references/AUTHORING.md §7.7). Nothing else loads it: it is read the first time
// a project draws a Skia canvas, so a project that never imports `@remotion/skia` or `@shopify/react-native-skia`
// does not need it installed.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDomEnvironment } from '@kinetographdev/compat/dom';

export interface SkiaAddon {
  renderSkia(requestJson: string): string;
  compileEffect(sksl: string): string;
  measureText(requestJson: string): string;
  pathCall(requestJson: string): string;
  imageSize(requestJson: string): string;
  svgSize(requestJson: string): string;
  putData(bytes: Buffer): string;
  measureParagraph(requestJson: string): string;
  imageCall(requestJson: string): string;
  imageBytes(requestJson: string): Buffer;
}

let override: SkiaAddon | null = null;
let loaded: SkiaAddon | undefined;

/** Uses `addon` in place of `@kinetographdev/skia` (tests); null goes back to loading the package. */
export function setSkiaAddon(addon: SkiaAddon | null): void {
  override = addon;
  loaded = undefined;
}

/** Whether `@kinetographdev/skia` can be loaded here. */
export function hasSkiaAddon(): boolean {
  try {
    skiaAddon();
    return true;
  } catch {
    return false;
  }
}

export function skiaAddon(): SkiaAddon {
  if (override) return override;
  if (loaded) return loaded;
  // A bundle lives in the project's cache directory, so the package is looked for from the project and the working
  // directory as well as from here.
  const bases = [import.meta.url, pathToFileURL(`${process.cwd()}/`).href];
  const { baseDir } = getDomEnvironment();
  if (baseDir !== undefined) bases.push(pathToFileURL(`${baseDir}/`).href);
  for (const base of bases) {
    try {
      loaded = createRequire(base)('@kinetographdev/skia') as SkiaAddon;
      return loaded;
    } catch (error) {
      // A missing package is the expected failure; anything else (a binary for another platform) is worth saying.
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(
    'This project draws with React Native Skia (@remotion/skia or @shopify/react-native-skia), which Kinetograph runs ' +
      'on real Skia in an optional addon that is not installed. Install it: npm install @kinetographdev/skia',
  );
}
