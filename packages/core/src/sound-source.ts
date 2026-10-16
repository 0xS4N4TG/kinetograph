// Where a sound file for the mix comes from. `<Audio src>` is a path, except for the URLs `@remotion/sfx` exports
// (./sfx.ts): those are downloaded once into `~/.cache/kinetograph/sfx` and read from there after that, so a render
// after the first needs no network and plays the same file every time. Any other URL is left as it is, and the mix
// reports it as a file it cannot read.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchFileCached, FontDownloadError, type FontDownloadOptions } from './font-files.js';
import * as sfx from './sfx.js';

const SFX_URLS: ReadonlySet<string> = new Set(Object.values(sfx));

/** True for the URL of one of `@remotion/sfx`'s sounds. */
export function isSfxUrl(src: string): boolean {
  return SFX_URLS.has(src);
}

export function defaultSoundCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'sfx');
}

/**
 * The file to read for `src`: the cached copy of a sound effect (downloaded first if it is not there yet), else `src`
 * itself. The options are those of the font downloads; the fetch is injectable so tests never touch the network.
 */
export async function resolveSoundSource(src: string, options: FontDownloadOptions = {}): Promise<string> {
  if (!isSfxUrl(src)) return src;
  try {
    return await fetchFileCached(src, { cacheDir: defaultSoundCacheDir(), ...options });
  } catch (error) {
    const why =
      error instanceof FontDownloadError ? `HTTP status ${error.status}` : error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot download the sound effect ${src}: ${why}. ` +
        'It is fetched once and kept in ~/.cache/kinetograph/sfx; Kinetograph renders offline after that.',
      { cause: error },
    );
  }
}
