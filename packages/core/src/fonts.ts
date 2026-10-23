// `@remotion/fonts` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.2): `loadFont({ family, url, weight, style })`.
// Here `url` is a path (what `staticFile()` returns), a `file://` URL, or an
// http(s) URL, which is downloaded once into the font cache. The font is
// registered under the key a `<Text font weight fontStyle>` resolves to.

import { fileURLToPath } from 'node:url';
import { fetchFileCached, fetchFileCachedSync, type FontDownloadOptions } from './font-files.js';
import { registerFont, trackFontLoad } from './font-registry.js';

export interface LoadFontOptions {
  family: string;
  url: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
  /** Accepted for compatibility with `@remotion/fonts`; the renderer reads the file as it is. */
  format?: string;
  display?: string;
}

/** Registers the font file; resolves when it is registered (immediately for a local file). */
export function loadFont(options: LoadFontOptions, download: FontDownloadOptions = {}): Promise<void> {
  const { family, url, weight, style } = options;
  if (typeof url !== 'string' || url === '') throw new TypeError(`loadFont() needs the "url" of the font file for "${family}"`);
  if (/^https?:\/\//i.test(url)) {
    return trackFontLoad(
      fetchFileCached(url, download).then((path) => {
        registerFont({ family, path, weight: firstWeight(weight), style });
      }),
      () => registerFont({ family, path: fetchFileCachedSync(url, download), weight: firstWeight(weight), style }),
    );
  }
  const path = url.startsWith('file://') ? fileURLToPath(url) : url;
  registerFont({ family, path, weight: firstWeight(weight), style });
  return Promise.resolve();
}

/** A weight range such as `'400 700'` registers at its first value. */
function firstWeight(weight: number | string | undefined): number | string | undefined {
  if (typeof weight === 'string' && /\s/.test(weight.trim())) return weight.trim().split(/\s+/)[0];
  return weight;
}
