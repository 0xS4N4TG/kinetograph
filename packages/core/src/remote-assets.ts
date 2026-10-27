// Remote images and videos (an `<img src="https://…">`, a CSS `url(https://…)`, `<Img>`). The CLI downloads the ones it
// finds in the bundle before frame 0 (`prefetchRemoteAssets`) into `~/.cache/kinetograph/assets` and pins each in
// `kinetograph.lock.json` (`lock.ts`); a render then only reads that cache, so a frame is a function of the project.
// A URL that first shows up during a render (built at run time) is downloaded once then, added to the lock, and said so
// in a note. With `--offline` nothing is downloaded: a URL that is not cached is drawn without and noted. A download
// that fails is a note too, and the URL is left as it is for the engine to report. `fetch()` and `new Image().src` of a
// remote URL stay refused: a script cannot wait for the file.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchFileCached, fetchFileCachedSync, fileCachePath, FontDownloadError, type FontDownloadOptions } from './font-files.js';
import { lockMismatch, readLock, recordInLock, sha256Hex, writeLock } from './lock.js';

export function defaultAssetCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'assets');
}

export interface RemoteAssetOptions extends FontDownloadOptions {
  /** The lock file to check the cache against and record in (default: `$KINETOGRAPH_LOCK_FILE`; none when unset). */
  lockFile?: string | null;
  /** Never download (default: `$KINETOGRAPH_OFFLINE` is `1`). */
  offline?: boolean;
}

const lockFileOf = (options: RemoteAssetOptions): string | null => options.lockFile !== undefined ? options.lockFile : (process.env.KINETOGRAPH_LOCK_FILE ?? null);
const isOffline = (options: RemoteAssetOptions): boolean => options.offline ?? process.env.KINETOGRAPH_OFFLINE === '1';

/**
 * Checks the cached file of `url` against the lock (a different hash is an error to stop on), and adds it to the lock when
 * it is not there yet. No lock file, no check.
 */
function checkLock(url: string, file: string, options: RemoteAssetOptions): void {
  const lockFile = lockFileOf(options);
  if (lockFile === null) return;
  const bytes = readFileSync(file);
  const lock = readLock(lockFile);
  const mismatch = lockMismatch(lock, url, bytes);
  if (mismatch !== null) throw new Error(mismatch);
  if (!lock.files[url]) recordInLock(lockFile, url, { sha256: sha256Hex(bytes), size: bytes.length });
}

/**
 * Downloads the remote files of a project before its first frame: the cache is filled, each file is hashed into the lock,
 * and one that is already cached is checked against the lock. Resolves to the URLs that could not be had, with why.
 * `update` downloads again and replaces the lock's entries.
 */
export async function prefetchRemoteAssets(
  urls: Iterable<string>,
  options: RemoteAssetOptions & { update?: boolean } = {},
): Promise<{ fetched: string[]; cached: string[]; failed: { url: string; error: string; mismatch: boolean }[] }> {
  const opts = { cacheDir: defaultAssetCacheDir(), ...options };
  const out = { fetched: [] as string[], cached: [] as string[], failed: [] as { url: string; error: string; mismatch: boolean }[] };
  for (const url of new Set(urls)) {
    const file = fileCachePath(url, opts);
    const wasThere = !options.update && existsSync(file);
    try {
      if (options.update) {
        // Another copy of the bytes replaces the cached ones; the lock then takes their hash.
        const lockFile = lockFileOf(opts);
        if (lockFile !== null) {
          const lock = readLock(lockFile);
          delete lock.files[url];
          writeLock(lockFile, lock);
        }
        rmSync(file, { force: true });
      }
      await fetchFileCached(url, opts);
      try {
        checkLock(url, file, opts);
      } catch (error) {
        out.failed.push({ url, error: error instanceof Error ? error.message : String(error), mismatch: true });
        continue;
      }
      (wasThere ? out.cached : out.fetched).push(url);
    } catch (error) {
      if (!(error instanceof FontDownloadError)) throw error;
      out.failed.push({ url, error: error.message, mismatch: false });
    }
  }
  return out;
}

/**
 * The resolver `setRemoteAssetResolver` takes. `note` hears about each URL that could not be had, once. `options` replace
 * the network and the cache (tests).
 */
export function makeRemoteAssetResolver(
  note: (message: string) => void,
  options: RemoteAssetOptions = {},
): (url: string) => string | null {
  const known = new Map<string, string | null>();
  const opts = { cacheDir: defaultAssetCacheDir(), ...options };
  return (url) => {
    if (known.has(url)) return known.get(url) ?? null;
    let path: string | null = null;
    const cached = fileCachePath(url, opts);
    if (existsSync(cached)) {
      // Throws when the file is not what the lock recorded: the render stops rather than draw another picture.
      checkLock(url, cached, opts);
      path = cached;
    } else if (isOffline(opts)) {
      note(`${url} is not cached and --offline is set, so nothing is downloaded; it is drawn without it (run without --offline once, or \`kinetograph fetch-deps\`)`);
    } else {
      try {
        path = fetchFileCachedSync(url, opts);
        checkLock(url, path, opts);
        note(`${url} was first requested during the render (the pre-download scan of the bundle did not find it): downloaded now and added to the lock`);
      } catch (error) {
        if (!(error instanceof FontDownloadError)) throw error;
        note(`${url} could not be downloaded (${error.message}); it is drawn without it`);
      }
    }
    known.set(url, path);
    return path;
  };
}
