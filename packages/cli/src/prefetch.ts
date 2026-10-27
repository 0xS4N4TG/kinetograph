// The step before frame 0 of `render`, `still`, `studio`, `doctor` and the other commands that open a project: what the
// project loads from the web is downloaded into the caches and pinned in `kinetograph.lock.json`, so the frames are
// drawn from disk. `--offline` (or `KINETOGRAPH_OFFLINE=1`, which render workers inherit) skips it: a file that is
// missing is then the error it was before this step existed.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { lockPathOf } from '@kinetographdev/core/lock';
import { prefetchRemoteAssets } from '@kinetographdev/core/remote-assets';
import { CliError } from './errors.js';
import { isHyperframesEntry } from './hyperframes/entry.js';
import { autoPrefetchHyperframes } from './hyperframes/prefetch.js';

export interface PrefetchEntryOptions {
  offline?: boolean;
  progress?: (message: string) => void;
}

/** Whether downloads are off for this process. */
export const isOffline = (offline?: boolean): boolean => offline === true || process.env.KINETOGRAPH_OFFLINE === '1';

/** Sets the process to offline (and its workers, which copy the environment). */
export function setOffline(offline: boolean): void {
  if (offline) process.env.KINETOGRAPH_OFFLINE = '1';
}

// The studio opens a project again for each preview: the step runs once for each version of the entry file.
const done = new Map<string, number>();

/** What a HyperFrames entry needs before it is read; a no-op for any other entry or when offline. */
export async function prefetchBeforePlan(entry: string, options: PrefetchEntryOptions = {}): Promise<void> {
  if (isOffline(options.offline) || !isHyperframesEntry(entry)) return;
  const version = statSync(entry).mtimeMs;
  if (done.get(entry) === version) return;
  await autoPrefetchHyperframes(entry, options.progress ?? (() => {}));
  done.set(entry, version);
}

// ---- a Remotion project: the remote pictures and videos its bundle names ----

/** File extensions of the remote files a project draws (`<Img src>`, `<Video>`, CSS `url()`). */
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|m4a|aac|flac)$/i;

/**
 * The https URLs in a bundle's code that name a picture, video or audio file: string literals and CSS `url()`s. A URL built
 * at run time (a template with a hole, a URL with no extension) is not found here; it is downloaded when a frame first
 * asks for it, and said so.
 */
export function scanRemoteUrls(code: string): string[] {
  const end = code.lastIndexOf('//# sourceMappingURL=');
  const text = end >= 0 ? code.slice(0, end) : code;
  const found = new Set<string>();
  for (const m of text.matchAll(/https:\/\/[^\s'"`<>()\\{}$]+/g)) {
    const url = m[0].replace(/[.,;]+$/, '');
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    if (MEDIA_EXT.test(pathname)) found.add(url);
  }
  return [...found];
}

const scanned = new Set<string>();

/**
 * Before frame 0 of a Remotion project: its bundle is scanned for remote files, they are downloaded into the asset cache
 * and pinned in the lock file beside the entry. Sets the environment the render-time resolver reads (the lock file), so a
 * file that first appears mid-render is added to the same lock.
 */
export async function prefetchBundleAssets(entry: string, bundleFile: string, options: PrefetchEntryOptions = {}): Promise<void> {
  if (isHyperframesEntry(entry)) return;
  const lockFile = lockPathOf(entry);
  process.env.KINETOGRAPH_LOCK_FILE = lockFile;
  if (isOffline(options.offline)) return;
  const code = readFileSync(bundleFile, 'utf8');
  const key = createHash('sha256').update(code).digest('hex');
  if (scanned.has(key)) return;
  const urls = scanRemoteUrls(code);
  if (urls.length > 0) {
    const result = await prefetchRemoteAssets(urls, { lockFile });
    const mismatch = result.failed.find((f) => f.mismatch);
    if (mismatch) throw new CliError('LOCK_MISMATCH', mismatch.error);
    const say = options.progress ?? (() => {});
    if (result.fetched.length > 0) say(`downloaded ${result.fetched.length} remote file(s) into the asset cache (locked in ${lockFile})`);
    for (const f of result.failed) say(`could not download ${f.url}: ${f.error}`);
  }
  scanned.add(key);
}
