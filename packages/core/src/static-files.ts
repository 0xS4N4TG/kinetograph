// `getStaticFiles`, `watchStaticFile` and `prefetch` (docs/AUTHORING.md §7.1): Remotion's calls about the files of the
// public folder. A project's files are on disk and nothing changes while it renders, so listing them is a directory
// read, watching one is a Studio-only no-op, and prefetching one is already done.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { remoteMessage } from '@kinetograph/compat/shim';
import { getPublicDir, staticFile } from './assets.js';
import { warnOnce } from './warn.js';

export interface StaticFile {
  /** What to pass as the `src` of `<Img>`, `<Audio>`, `<Video>` and the rest: `staticFile(name)`. */
  src: string;
  /** The path of the file relative to the public folder, with `/` separators: `subfolder/image.png`. */
  name: string;
  sizeInBytes: number;
  /** The file's modification time in Unix milliseconds. */
  lastModified: number;
}

/** Every file in the public folder, in the order of their names; hidden files (`.DS_Store`) are left out. */
export function getStaticFiles(): StaticFile[] {
  const files: StaticFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no public folder: no files
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${name}/`);
      } else if (entry.isFile()) {
        const stats = statSync(join(dir, entry.name));
        files.push({ src: staticFile(name), name, sizeInBytes: stats.size, lastModified: stats.mtimeMs });
      }
    }
  };
  walk(getPublicDir(), '');
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Remotion's call for the Studio, which reloads a file that changed. A render sees the project as it is, so this does nothing. */
export function watchStaticFile(_fileName: string, _callback: (newData: StaticFile | null) => void): { cancel: () => void } {
  warnOnce('watchStaticFile', 'watchStaticFile() does nothing in Kinetograph: a render reads the files as they are, and none changes.');
  return { cancel: () => undefined };
}

export interface PrefetchOptions {
  method?: 'blob-url' | 'base64';
  contentType?: string;
  onProgress?: (progress: { totalBytes: number | null; loadedBytes: number }) => void;
  credentials?: 'omit' | 'same-origin' | 'include';
  logLevel?: 'trace' | 'verbose' | 'info' | 'warn' | 'error';
}

/**
 * Remotion's preloading for the Player. In a render it resolves at once with the source, minus its `#` fragment, and
 * so does this; a file of the project is already local. A remote URL is an error, as for every other offline call.
 */
export function prefetch(src: string, _options?: PrefetchOptions): { free: () => void; waitUntilDone: () => Promise<string> } {
  const hash = src.indexOf('#');
  const withoutHash = hash === -1 ? src : src.slice(0, hash);
  if (/^(https?|wss?|ftp):\/\//i.test(withoutHash)) throw new TypeError(remoteMessage('prefetch', withoutHash));
  return { free: () => undefined, waitUntilDone: () => Promise.resolve(withoutHash) };
}
