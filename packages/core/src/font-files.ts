// Downloads for fonts: a cached fetch shared by `@kinetograph/core/fonts` and
// `/google-fonts`. A file is downloaded once into `~/.cache/kinetograph/fonts`
// and read from there after that, so a second render needs no network. The
// fetch is injectable so tests (and offline projects) never touch the network.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** The part of `fetch` the downloads use. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

export interface FontDownloadOptions {
  fetch?: FetchLike;
  /** Default `~/.cache/kinetograph/fonts`. */
  cacheDir?: string;
}

export function defaultFontCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'fonts');
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Google serves TrueType to clients it does not recognise, which is what the renderer reads (it has no WOFF2 decoder). */
const USER_AGENT = 'curl/8.0';

const sha = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function isThere(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/** The text at `url`, cached by URL. */
export async function fetchTextCached(url: string, options: FontDownloadOptions = {}): Promise<string> {
  const dir = options.cacheDir ?? defaultFontCacheDir();
  const file = join(dir, `css-${sha(url)}.css`);
  const cached = await readIfThere(file);
  if (cached !== null) return cached;
  const response = await (options.fetch ?? defaultFetch)(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new FontDownloadError(url, response.status);
  const text = await response.text();
  await mkdir(dir, { recursive: true });
  await writeAtomically(file, text);
  return text;
}

/** The path of the file at `url` in the cache, downloading it first if it is not there yet. */
export async function fetchFileCached(url: string, options: FontDownloadOptions = {}): Promise<string> {
  const dir = options.cacheDir ?? defaultFontCacheDir();
  const name = basename(new URL(url).pathname).replace(/[^A-Za-z0-9._-]/g, '_');
  const file = join(dir, `${sha(url)}-${name}`);
  if (await isThere(file)) return file;
  const response = await (options.fetch ?? defaultFetch)(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new FontDownloadError(url, response.status);
  const data = new Uint8Array(await response.arrayBuffer());
  await mkdir(dir, { recursive: true });
  await writeAtomically(file, data);
  return file;
}

export class FontDownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Downloading the font from ${url} failed with HTTP status ${status}`);
    this.name = 'FontDownloadError';
  }
}
