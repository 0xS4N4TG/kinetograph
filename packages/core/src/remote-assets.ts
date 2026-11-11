// Remote images and videos (an `<img src="https://…">`, a CSS `url(https://…)`, `<Img>`). The CLI downloads the ones it
// finds in the bundle before frame 0 (`prefetchRemoteAssets`) into `~/.cache/kinetograph/assets` and pins each in
// `kinetograph.lock.json` (`lock.ts`); a render then only reads that cache, so a frame is a function of the project.
// A URL that first shows up during a render (built at run time) is downloaded once then, added to the lock, and said so
// in a note. With `--offline` nothing is downloaded: a URL that is not cached is drawn without and noted. A download
// that fails is a note too, and the URL is left as it is for the engine to report. `fetch()` of a remote URL reads the same
// cache; `new Image().src` of a remote URL stays refused.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_REMOTE_IMPORTS, parseRemoteSheet } from '@kinetographdev/compat/dom';
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

/** Options of `makeRemoteAssetResolver` only. */
export interface RemoteResolverOptions extends RemoteAssetOptions {
  /**
   * Answer only with a file that is already cached and, when there is a lock, in it (what `fetch-deps` made): never download
   * during a render, and say what to run when the file is not there.
   */
  cachedOnly?: boolean;
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

function forgetInLock(lockFile: string, url: string): void {
  const lock = readLock(lockFile);
  delete lock.files[url];
  writeLock(lockFile, lock);
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
        if (lockFile !== null) forgetInLock(lockFile, url);
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
 * Whether the file cached for `url` is what the lock pinned, when the lock has it: a font a render reads is checked the way
 * a picture is. Throws with the lock's message on a mismatch; nothing when there is no lock or no entry.
 */
export function verifyLocked(url: string, file: string, options: RemoteAssetOptions = {}): void {
  const lockFile = lockFileOf(options);
  if (lockFile === null) return;
  const mismatch = lockMismatch(readLock(lockFile), url, readFileSync(file));
  if (mismatch !== null) throw new Error(mismatch);
}

/**
 * The cached file of a font a remote stylesheet names, for a render: only one that `prefetchStylesheetFonts` downloaded and
 * locked (null when it is not cached, or the lock has no entry), checked against the lock; never a download.
 */
export function lockedFontFile(url: string, options: RemoteAssetOptions & { fontCacheDir?: string } = {}): string | null {
  const file = fileCachePath(url, { ...options, cacheDir: options.fontCacheDir });
  if (!existsSync(file)) return null;
  const lockFile = lockFileOf(options);
  if (lockFile !== null) {
    if (!readLock(lockFile).files[url]) return null;
    verifyLocked(url, file, options);
  }
  return file;
}

/**
 * The font files the stylesheets at `stylesheetUrls` name (`prefetchRemoteAssets` has downloaded them: Google Fonts'
 * `css2` answers with `@font-face` rules that point at `fonts.gstatic.com`), into the font cache, where a render
 * reads them, and pinned in the lock like every other download. Stylesheets they import are downloaded and locked
 * too (a few, once each); only https URLs are followed. Resolves to the files that could not be had, with why.
 */
export async function prefetchStylesheetFonts(
  stylesheetUrls: Iterable<string>,
  options: RemoteAssetOptions & { fontCacheDir?: string; update?: boolean } = {},
): Promise<{ fetched: number; failed: { url: string; error: string }[] }> {
  const assets = { cacheDir: defaultAssetCacheDir(), ...options };
  const fonts = { ...options, cacheDir: options.fontCacheDir };
  const out = { fetched: 0, failed: [] as { url: string; error: string }[] };
  const queue = [...new Set(stylesheetUrls)];
  const seen = new Set<string>(queue);
  for (let i = 0; i < queue.length; i++) {
    const sheet = queue[i]!;
    const file = fileCachePath(sheet, assets);
    if (!existsSync(file)) continue;
    const parsed = parseRemoteSheet(readFileSync(file, 'utf8'), sheet);
    for (const nested of parsed.imports) {
      if (seen.has(nested) || seen.size >= MAX_REMOTE_IMPORTS) continue;
      seen.add(nested);
      queue.push(nested);
      const got = await prefetchRemoteAssets([nested], options);
      for (const f of got.failed) out.failed.push({ url: f.url, error: f.error });
    }
    for (const face of parsed.faces) {
      try {
        const path = await fetchFileCached(face.url, fonts);
        const lockFile = lockFileOf(options);
        if (lockFile !== null) {
          if (options.update) forgetInLock(lockFile, face.url);
          const bytes = readFileSync(path);
          const lock = readLock(lockFile);
          const mismatch = lockMismatch(lock, face.url, bytes);
          if (mismatch !== null) {
            out.failed.push({ url: face.url, error: mismatch });
            continue;
          }
          if (!lock.files[face.url]) recordInLock(lockFile, face.url, { sha256: sha256Hex(bytes), size: bytes.length });
        }
        out.fetched++;
      } catch (error) {
        if (!(error instanceof FontDownloadError)) throw error;
        out.failed.push({ url: face.url, error: error.message });
      }
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
  options: RemoteResolverOptions = {},
): (url: string) => string | null {
  const known = new Map<string, string | null>();
  const opts = { cacheDir: defaultAssetCacheDir(), ...options };
  return (url) => {
    if (known.has(url)) return known.get(url) ?? null;
    let path: string | null = null;
    const cached = fileCachePath(url, opts);
    const lockFile = lockFileOf(opts);
    if (opts.cachedOnly && (!existsSync(cached) || (lockFile !== null && !readLock(lockFile).files[url]))) {
      note(`${url} is not downloaded and locked, so it is left out (run \`kinetograph fetch-deps <entry>\`)`);
    } else if (existsSync(cached)) {
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
