// Downloads for fonts: a cached fetch shared by `@kinetograph/core/fonts` and
// `/google-fonts`. A file is downloaded once into `~/.cache/kinetograph/fonts`
// and read from there after that, so a second render needs no network. The
// fetch is injectable so tests (and offline projects) never touch the network.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /**
   * The bytes at a URL, fetched with the thread blocked. Used where a download cannot be waited for (`measureText`
   * while a font loads, `document.fonts.add` of a remote face). Default: a child Node process that runs the real
   * `fetch`; with a custom `fetch` and no `fetchSync` there is no synchronous download. `userAgent` is the one the
   * download should send.
   */
  fetchSync?: (url: string, userAgent: string) => Uint8Array;
  /** Default `~/.cache/kinetograph/fonts`. */
  cacheDir?: string;
}

export function defaultFontCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'fonts');
}

// In a Node render the project's own `fetch` reads project files only (no network, packages/cli/skills/kinetograph/references/ENGINE.md §10); these downloads are
// explicit and cached, and use the real one, which the DOM globals keep under this symbol.
const defaultFetch: FetchLike = (url, init) =>
  ((globalThis as Record<symbol, unknown>)[Symbol.for('kinetograph.realFetch')] as typeof fetch | undefined ?? fetch)(url, init);

/** Google serves TrueType to clients it does not recognise, which is what the renderer reads. */
const USER_AGENT = 'curl/8.0';

/** A browser's, for the answers a browser gets: WOFF2 files split into subsets, each block named by a comment. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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

// A temporary name no other write shares, so an async download and a blocking one of the same file cannot trample each other.
let writes = 0;
const tempName = (path: string): string => `${path}.${process.pid}.${++writes}.tmp`;

async function writeAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const temp = tempName(path);
  await writeFile(temp, data);
  await rename(temp, path);
}

function writeAtomicallySync(path: string, data: string | Uint8Array): void {
  const temp = tempName(path);
  writeFileSync(temp, data);
  renameSync(temp, path);
}

const textFile = (url: string, options: FontDownloadOptions, userAgent: string): { dir: string; file: string } => {
  const dir = options.cacheDir ?? defaultFontCacheDir();
  // The answer depends on who asks, so a browser's copy of a URL is another file.
  return { dir, file: join(dir, `css-${sha(userAgent === USER_AGENT ? url : `${userAgent}\n${url}`)}.css`) };
};

const binaryFile = (url: string, options: FontDownloadOptions): { dir: string; file: string } => {
  const dir = options.cacheDir ?? defaultFontCacheDir();
  const name = basename(new URL(url).pathname).replace(/[^A-Za-z0-9._-]/g, '_');
  return { dir, file: join(dir, `${sha(url)}-${name}`) };
};

/** `fetch` for a download: a network failure is a `FontDownloadError` too, so a caller catches one kind of error. */
async function download(url: string, options: FontDownloadOptions, userAgent: string): Promise<FetchResponse> {
  let response: FetchResponse;
  try {
    response = await (options.fetch ?? defaultFetch)(url, { headers: { 'User-Agent': userAgent } });
  } catch (error) {
    throw new FontDownloadError(url, 0, networkReason(error));
  }
  if (!response.ok) throw new FontDownloadError(url, response.status);
  return response;
}

function networkReason(error: unknown): string {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause?.message;
  if (typeof cause === 'string') return cause;
  return error instanceof Error ? error.message : String(error);
}

/** The text at `url`, cached by URL (and by who asks: `userAgent`). */
export async function fetchTextCached(url: string, options: FontDownloadOptions = {}, userAgent = USER_AGENT): Promise<string> {
  const { dir, file } = textFile(url, options, userAgent);
  const cached = await readIfThere(file);
  if (cached !== null) return cached;
  const text = await (await download(url, options, userAgent)).text();
  await mkdir(dir, { recursive: true });
  await writeAtomically(file, text);
  return text;
}

/** The path of the file at `url` in the cache, downloading it first if it is not there yet. */
export async function fetchFileCached(url: string, options: FontDownloadOptions = {}): Promise<string> {
  const { dir, file } = binaryFile(url, options);
  if (await isThere(file)) return file;
  const data = new Uint8Array(await (await download(url, options, USER_AGENT)).arrayBuffer());
  await mkdir(dir, { recursive: true });
  await writeAtomically(file, data);
  return file;
}

// ---- downloads that block ----

// Runs in a child Node process (the real `fetch`; the project's own is the offline shim). Exit 3: an HTTP status, 4: no answer.
const CHILD_FETCH = `
const [url, agent] = process.argv.slice(1);
try {
  const response = await fetch(url, { headers: { 'User-Agent': agent } });
  if (!response.ok) { process.stderr.write(String(response.status)); process.exit(3); }
  process.stdout.write(Buffer.from(await response.arrayBuffer()), () => process.exit(0));
} catch (error) {
  process.stderr.write(String((error && error.cause && error.cause.message) || (error && error.message) || error));
  process.exit(4);
}
`;

/** The bytes at `url`, with the thread blocked until they are there (a child Node process does the fetch). */
function childFetch(url: string, userAgent: string): Uint8Array {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_FETCH, '--', url, userAgent], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new FontDownloadError(url, 0, result.error.message);
  const message = result.stderr.toString();
  if (result.status === 3) throw new FontDownloadError(url, Number(message) || 0);
  if (result.status !== 0) throw new FontDownloadError(url, 0, message || `the download exited with ${String(result.status)}`);
  return new Uint8Array(result.stdout);
}

function downloadSync(url: string, options: FontDownloadOptions, userAgent: string): Uint8Array {
  if (options.fetchSync) return options.fetchSync(url, userAgent);
  if (options.fetch) {
    throw new Error(`${url} cannot be downloaded synchronously: a custom fetch was given without a fetchSync`);
  }
  return childFetch(url, userAgent);
}

/** `fetchTextCached`, blocking. */
export function fetchTextCachedSync(url: string, options: FontDownloadOptions = {}, userAgent = USER_AGENT): string {
  const { dir, file } = textFile(url, options, userAgent);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const text = Buffer.from(downloadSync(url, options, userAgent)).toString('utf8');
  mkdirSync(dir, { recursive: true });
  writeAtomicallySync(file, text);
  return text;
}

/** `fetchFileCached`, blocking. */
export function fetchFileCachedSync(url: string, options: FontDownloadOptions = {}): string {
  const { dir, file } = binaryFile(url, options);
  if (existsSync(file)) return file;
  const data = downloadSync(url, options, USER_AGENT);
  mkdirSync(dir, { recursive: true });
  writeAtomicallySync(file, data);
  return file;
}

export class FontDownloadError extends Error {
  /** The error code the CLI reports (`toErrorObject` passes a `code` of capitals through). */
  readonly code = 'FONT_DOWNLOAD';

  constructor(
    readonly url: string,
    /** The HTTP status; 0 when there was no answer. */
    readonly status: number,
    reason?: string,
  ) {
    super(
      status === 0
        ? `Downloading the font from ${url} failed${reason ? `: ${reason}` : ''}`
        : `Downloading the font from ${url} failed with HTTP status ${status}`,
    );
    this.name = 'FontDownloadError';
  }
}
