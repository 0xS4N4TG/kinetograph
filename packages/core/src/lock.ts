// `kinetograph.lock.json`, beside a project's entry: every file the project downloads from the web (CDN scripts, ES
// modules, pictures, media), as URL to the SHA-256 and size of the bytes first downloaded. A render checks the cache
// against it, so a file that changed upstream or on disk is an error, not a different video.
//
//   { "version": 1, "files": { "https://esm.sh/gsap@3.12.5": { "sha256": "…", "size": 71234 } } }
//
// A download that was redirected also records the URL it ended at (`"final"`).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LOCK_FILE_NAME = 'kinetograph.lock.json';

export interface LockEntry {
  sha256: string;
  size: number;
  /** Where the download ended up when the request was redirected: a module's relative imports and `import.meta.url` use it. */
  final?: string;
}

export interface Lock {
  version: 1;
  files: Record<string, LockEntry>;
}

/** The lock file of the project whose entry file is `entry`. */
export const lockPathOf = (entry: string): string => join(dirname(entry), LOCK_FILE_NAME);

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The lock at `path`; an empty one when there is no file. A file that is not a lock is an error (it is not overwritten). */
export function readLock(path: string): Lock {
  if (!existsSync(path)) return { version: 1, files: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}): fix it, or delete it and run \`kinetograph fetch-deps <entry> --update\``);
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== 'object' || files === null) throw new Error(`${path} is not a kinetograph lock file (no "files" object)`);
  const out: Lock = { version: 1, files: {} };
  for (const [url, entry] of Object.entries(files)) {
    const e = entry as Partial<LockEntry> | null;
    if (e && typeof e.sha256 === 'string' && typeof e.size === 'number') {
      out.files[url] = { sha256: e.sha256, size: e.size, ...(typeof e.final === 'string' ? { final: e.final } : {}) };
    }
  }
  return out;
}

/** Writes the lock whole (sorted by URL, so the file diffs well), to a temporary file renamed over the old. */
export function writeLock(path: string, lock: Lock): void {
  const files: Record<string, LockEntry> = {};
  for (const url of Object.keys(lock.files).sort()) files[url] = lock.files[url]!;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Adds (or replaces) one URL, re-reading the file first so two processes adding different URLs both keep theirs. */
export function recordInLock(path: string, url: string, entry: LockEntry): void {
  const lock = readLock(path);
  const have = lock.files[url];
  if (have && have.sha256 === entry.sha256 && have.size === entry.size && have.final === entry.final) return;
  lock.files[url] = entry;
  writeLock(path, lock);
}

/**
 * Why `bytes` are not what the lock recorded for `url`, or null when they are (or the lock has no entry). `final`, when
 * given, is where the request ended after redirects: the lock pins that too, so a server that sends the request somewhere
 * else is a mismatch even when the bytes are the same.
 */
export function lockMismatch(lock: Lock, url: string, bytes: Uint8Array, final?: string): string | null {
  const entry = lock.files[url];
  if (!entry) return null;
  if (final !== undefined && (entry.final ?? url) !== final) {
    return `${url} was redirected to ${final} but ${LOCK_FILE_NAME} locked it at ${entry.final ?? url}: the redirect target changed since it was locked. Run \`kinetograph fetch-deps <entry> --update\` to accept the new one`;
  }
  const got = sha256Hex(bytes);
  if (got === entry.sha256) return null;
  return `${url} does not match ${LOCK_FILE_NAME} (locked sha256 ${entry.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…): it changed since it was locked. Run \`kinetograph fetch-deps <entry> --update\` to accept the new file`;
}
