// Remote images and videos (an `<img src="https://…">`, a CSS `url(https://…)`, `<Img>`): each is downloaded once into
// `~/.cache/kinetograph/assets` and read from there, so a render after the first is offline and a frame stays a function
// of the project. A download that fails is a note (`doctor` and `lint` print it), and the URL is left as it is for the
// engine to report. `fetch()` and `new Image().src` of a remote URL stay refused: a script cannot wait for the file.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchFileCachedSync, FontDownloadError, type FontDownloadOptions } from './font-files.js';

export function defaultAssetCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'assets');
}

/**
 * The resolver `setRemoteAssetResolver` takes. `note` hears about each URL that could not be had, once. `options` replace
 * the network and the cache (tests).
 */
export function makeRemoteAssetResolver(
  note: (message: string) => void,
  options: FontDownloadOptions = {},
): (url: string) => string | null {
  const known = new Map<string, string | null>();
  return (url) => {
    if (known.has(url)) return known.get(url) ?? null;
    let path: string | null = null;
    try {
      path = fetchFileCachedSync(url, { cacheDir: defaultAssetCacheDir(), ...options });
    } catch (error) {
      if (!(error instanceof FontDownloadError)) throw error;
      note(`${url} could not be downloaded (${error.message}); it is drawn without it`);
    }
    known.set(url, path);
    return path;
  };
}
