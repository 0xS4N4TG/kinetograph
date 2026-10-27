// The libraries a HyperFrames page loads from a CDN (`<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">`).
// A render never fetches them. A URL is resolved, in this order, to
//
//   1. the same package at the same version in a `node_modules` at or above the project (`gsap@3.14.2` → its dist file),
//   2. the cache `~/.cache/kinetograph/cdn/<hash of the URL>.js`, which only `kinetograph fetch-deps <entry>` fills,
//
// and is an error naming the URL and that command otherwise. `render`, `still`, `doctor` and `studio` run the same
// download first (`prefetch.ts`) unless `--offline`; what they download is pinned in `kinetograph.lock.json`.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { lockMismatch, readLock, recordInLock, writeLock, type Lock } from '@kinetographdev/core/lock';
import { realFetch } from '@kinetographdev/compat/shim';
import { CliError } from '../errors.js';

export interface CdnRef {
  pkg: string;
  version: string;
  /** The file in the package, `dist/gsap.min.js`; empty for the package's default file. */
  path: string;
}

/** `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>`, `https://unpkg.com/<pkg>@<version>/<path>`; null for any other URL. */
export function parseCdnUrl(url: string): CdnRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let rest: string;
  if (parsed.hostname === 'cdn.jsdelivr.net' && parsed.pathname.startsWith('/npm/')) rest = parsed.pathname.slice('/npm/'.length);
  else if (parsed.hostname === 'unpkg.com') rest = parsed.pathname.slice(1);
  else return null;
  const m = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)(?:\/(.*))?$/.exec(rest);
  if (!m) return null;
  return { pkg: m[1]!, version: decodeURIComponent(m[2]!), path: m[3] ?? '' };
}

/** `~/.cache/kinetograph/cdn`, or `$KINETOGRAPH_CDN_CACHE`. */
export function cdnCacheDir(): string {
  return process.env.KINETOGRAPH_CDN_CACHE ?? join(homedir(), '.cache', 'kinetograph', 'cdn');
}

/** Where a URL's file is cached. */
export function cdnCachePath(url: string): string {
  return join(cdnCacheDir(), `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.js`);
}

/** The nearest `node_modules/<pkg>` at or above `from` that is exactly `version`. */
function installedPackage(pkg: string, version: string, from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version === version) return dirname(manifest);
      } catch {
        // an unreadable manifest is not this package
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The file of an installed package the CDN URL names. */
function installedFile(pkgDir: string, ref: CdnRef): string | null {
  const path = ref.path.split(/[?#]/)[0]!;
  if (path !== '') {
    const file = join(pkgDir, path);
    return existsSync(file) ? file : null;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    for (const field of ['jsdelivr', 'unpkg', 'browser', 'main']) {
      const value = manifest[field];
      if (typeof value === 'string' && existsSync(join(pkgDir, value))) return join(pkgDir, value);
    }
  } catch {
    // fall through
  }
  return null;
}

export type ScriptResolution = { file: string; via: 'node_modules' | 'cache' } | { error: string };

/** The hosts `fetch-deps` downloads from without being told to. */
export const DEFAULT_ALLOWED_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.skypack.dev'];
/** The most bytes of one script. */
export const MAX_SCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ---- the project's lock file (kinetograph.lock.json) ----

let active: { path: string; lock: Lock } | null = null;

/** The lock file the next resolves check the cache against, and the downloads are recorded in; null for none. */
export function useLockFile(path: string | null, fresh = false): void {
  if (path === null) {
    active = null;
    return;
  }
  try {
    // `fresh` (fetch-deps --update): the lock starts empty, so it ends up holding what the project uses now.
    active = { path, lock: fresh ? { version: 1, files: {} } : readLock(path) };
    if (fresh && existsSync(path)) writeLock(path, active.lock);
  } catch (error) {
    throw new CliError('LOCK_INVALID', error instanceof Error ? error.message : String(error));
  }
}

/** The lock file in use. */
export const activeLockFile = (): string | null => active?.path ?? null;

/**
 * A download of `url` with `bytes`: refused when the lock has another hash for it (unless `update`), else recorded.
 */
function lockDownload(url: string, bytes: Uint8Array, update: boolean, final: string): void {
  if (active === null) return;
  if (!update) {
    const mismatch = lockMismatch(active.lock, url, bytes, final);
    if (mismatch !== null) throw new CliError('LOCK_MISMATCH', mismatch);
  }
  const entry = { sha256: sha256Hex(bytes), size: bytes.length, ...(final !== url ? { final } : {}) };
  active.lock.files[url] = entry;
  recordInLock(active.path, url, entry);
}

/** A cached file that is not in the lock yet (downloaded for another project) joins it, as the hash stored beside it says. */
function lockCached(url: string, file: string): void {
  if (active === null || active.lock.files[url]) return;
  const final = cachedFinal(file);
  const entry = { sha256: readFileSync(hashFile(file), 'utf8').trim(), size: readFileSync(file).length, ...(final !== null ? { final } : {}) };
  active.lock.files[url] = entry;
  recordInLock(active.path, url, entry);
}

function writeAtomic(file: string, data: Uint8Array | string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Stores a download. Every write is a temporary file renamed into place, and the file itself comes last, after its hash
 * and URL: a render running at the same time (parallel workers on a first run) sees either no file or a whole one with
 * its hash.
 */
function store(file: string, url: string, bytes: Uint8Array, update: boolean, final: string = url): void {
  lockDownload(url, bytes, update, final);
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(hashFile(file), `${sha256Hex(bytes)}\n`);
  writeAtomic(`${file}.url`, `${url}\n`);
  // Where a redirected request ended (a module's base for relative imports); absent when it was not redirected.
  if (final !== url) writeAtomic(`${file}.final`, `${final}\n`);
  else rmSync(`${file}.final`, { force: true });
  writeAtomic(file, bytes);
}

/** The URL a cached file's request was redirected to, or null. */
function cachedFinal(file: string): string | null {
  try {
    return readFileSync(`${file}.final`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The URL a downloaded data file or module really came from: where its request ended after redirects, as the downloader
 * recorded beside the cached file, or `url` itself. A browser resolves a module's relative imports and `import.meta.url`
 * against this. The lock's `final` never steers resolution (it is project data anyone can edit): it is only compared with
 * the cache's record, and a difference is an error. A record that is not https, or leaves the default hosts and the
 * requested URL's host without the lock pinning it, is ignored.
 */
export function finalUrlOf(url: string): string {
  const recorded = cachedFinal(dataCachePath(url));
  const locked = active?.lock.files[url];
  if (locked && (locked.final ?? url) !== (recorded ?? url)) {
    throw new CliError(
      'LOCK_MISMATCH',
      `${url} was downloaded with a redirect to ${recorded ?? url} but ${active!.path} locked it at ${locked.final ?? url}. Run \`kinetograph fetch-deps <entry> --update\` to download it again and update the lock.`,
    );
  }
  if (recorded === null) return url;
  let parsed: URL;
  try {
    parsed = new URL(recorded);
  } catch {
    return url;
  }
  const trusted = DEFAULT_ALLOWED_HOSTS.includes(parsed.hostname) || parsed.hostname === new URL(url).hostname || locked?.final === recorded;
  return parsed.protocol === 'https:' && trusted ? recorded : url;
}

/** The hash `fetch-deps` stored beside a cached file. */
const hashFile = (file: string): string => `${file}.sha256`;

/** Whether the cached file's bytes are what was downloaded, else why not. */
function verifiedCache(file: string, url: string): { ok: true } | { ok: false; error: string } {
  const again = 'Run `kinetograph fetch-deps <entry>` to download it again';
  if (!existsSync(hashFile(file))) return { ok: false, error: `the cached copy of ${url} (${file}) has no recorded hash and is not run. ${again}.` };
  const a = Buffer.from(readFileSync(hashFile(file), 'utf8').trim());
  const b = Buffer.from(sha256Hex(readFileSync(file)));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: `the cached copy of ${url} (${file}) does not match the hash recorded when it was downloaded: it was changed, and is not run. ${again}.` };
  }
  const locked = active?.lock.files[url];
  if (locked && locked.sha256 !== a.toString()) {
    return {
      ok: false,
      error: `the cached copy of ${url} (${file}) does not match kinetograph.lock.json (locked sha256 ${locked.sha256.slice(0, 12)}…, cached ${a.toString().slice(0, 12)}…) and is not run. Run \`kinetograph fetch-deps <entry> --update\` to download it again and update the lock.`,
    };
  }
  return { ok: true };
}

/** Where the script at `url` is on this machine, or why it is not. `projectDir` is where the search for `node_modules` starts. */
export function resolveCdnScript(url: string, projectDir: string): ScriptResolution {
  const ref = parseCdnUrl(url);
  if (ref !== null) {
    const pkgDir = installedPackage(ref.pkg, ref.version, projectDir);
    if (pkgDir !== null) {
      const file = installedFile(pkgDir, ref);
      if (file !== null) return { file, via: 'node_modules' };
    }
  }
  const cached = cdnCachePath(url);
  if (existsSync(cached)) {
    const checked = verifiedCache(cached, url);
    return checked.ok ? { file: cached, via: 'cache' } : { error: checked.error };
  }
  const hint =
    ref === null
      ? ''
      : ` or install it in the project (npm install ${ref.pkg}@${ref.version}), which a render then uses instead`;
  return {
    error:
      `the script ${url} is not available offline: a render never downloads it. ` +
      `Run \`kinetograph fetch-deps <entry>\` once to cache it in ${cdnCacheDir()}${hint}.`,
  };
}

export interface FetchedDep {
  url: string;
  file: string;
  status: 'installed' | 'cached' | 'fetched' | 'failed';
  error?: string;
  /** The error's code (`LOCK_MISMATCH`, `FETCH_REFUSED`, ...). */
  code?: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchOptions {
  fetchImpl?: (url: string, init: { redirect: 'manual' }) => Promise<FetchResponse>;
  /** Hosts besides the defaults (`--allow-host`). */
  allowHosts?: string[];
  /** `integrity` attributes of the script tags, by URL (`sha384-<base64>`, several separated by spaces). */
  integrity?: Record<string, string>;
  maxBytes?: number;
  /** `fetch-deps --update`: download again what is cached, and replace what the lock says. */
  update?: boolean;
}

/** `//host/x` is `https://host/x`; anything else as it is. */
export const normalizeScriptUrl = (url: string): string => (url.startsWith('//') ? `https:${url}` : url);

function checkUrl(url: string, allowed: Set<string>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('FETCH_REFUSED', `${url} is not a URL`);
  }
  if (parsed.protocol !== 'https:') throw new CliError('FETCH_REFUSED', `${url} is refused: only https: scripts are downloaded`);
  if (!allowed.has(parsed.hostname)) {
    throw new CliError(
      'FETCH_REFUSED',
      `${url} is refused: ${parsed.hostname} is not an allowed host (${[...allowed].join(', ')}). Pass --allow-host ${parsed.hostname} to download from it.`,
    );
  }
}

/** Checks `bytes` against an `integrity` attribute: any one of its hashes matching is enough (SRI). */
export function verifyIntegrity(bytes: Uint8Array, integrity: string, url: string): void {
  const entries = integrity
    .split(/\s+/)
    .map((item) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)/.exec(item))
    .filter((m): m is RegExpExecArray => m !== null);
  if (entries.length === 0) return;
  for (const m of entries) {
    const got = createHash(m[1]!).update(bytes).digest();
    if (got.equals(Buffer.from(m[2]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))) return;
  }
  throw new CliError('INTEGRITY_MISMATCH', `${url} does not match the integrity attribute of its script tag (${integrity}): it is not cached`);
}

/** The global `fetch`, unless it is the page's (`installDomGlobals`), then the one it replaced. */
function networkFetch(): typeof fetch {
  return (globalThis.fetch as { kinetograph?: boolean }).kinetograph === true ? realFetch() : globalThis.fetch;
}

async function download(url: string, options: FetchOptions, allowed: Set<string>): Promise<{ bytes: Uint8Array; final: string }> {
  // The network's own fetch: after a page has run in this process (the pre-download step runs it), the global `fetch`
  // is the page's, which reads project files only.
  const fetchImpl = options.fetchImpl ?? ((u, init) => networkFetch()(u, init) as Promise<FetchResponse>);
  let current = url;
  for (let hop = 0; ; hop++) {
    checkUrl(current, allowed);
    const response = await fetchImpl(current, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS) throw new CliError('FETCH_FAILED', `too many redirects, or none to follow, from ${current}`);
      // A hop that leaves https or the allowed hosts is refused, like a first request would be (checkUrl, next turn).
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new CliError('FETCH_FAILED', `HTTP ${response.status}`);
    const max = options.maxBytes ?? MAX_SCRIPT_BYTES;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > max) throw new CliError('FETCH_REFUSED', `${url} is ${length} bytes, over the ${max} byte limit`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new CliError('FETCH_REFUSED', `${url} is over the ${max} byte limit`);
    return { bytes, final: current };
  }
}

/** Downloads the URLs that are neither installed nor cached into the cache (the only code that fetches a script). */
export async function fetchCdnScripts(urls: string[], projectDir: string, options: FetchOptions = {}): Promise<FetchedDep[]> {
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...(options.allowHosts ?? [])]);
  const results: FetchedDep[] = [];
  for (const raw of [...new Set(urls)]) {
    const url = normalizeScriptUrl(raw);
    const integrity = options.integrity?.[raw] ?? options.integrity?.[url];
    const found = resolveCdnScript(url, projectDir);
    if ('file' in found) {
      // Whatever resolved is checked against the page's integrity attribute every time: a page that adds or changes
      // it must not get the bytes it was not written for. A cached copy that fails is downloaded again, once.
      let mismatch: string | null = null;
      if (integrity) {
        try {
          verifyIntegrity(readFileSync(found.file), integrity, url);
        } catch (error) {
          mismatch = error instanceof Error ? error.message : String(error);
        }
      }
      if (mismatch === null && !(options.update && found.via === 'cache')) {
        if (found.via === 'cache') lockCached(url, found.file);
        results.push({ url, file: found.file, status: found.via === 'node_modules' ? 'installed' : 'cached' });
        continue;
      }
      if (found.via === 'node_modules') {
        results.push({ url, file: found.file, status: 'failed', error: `the installed copy ${found.file}: ${mismatch}` });
        continue;
      }
    }
    const file = cdnCachePath(url);
    try {
      const { bytes, final } = await download(url, options, allowed);
      if (integrity) verifyIntegrity(bytes, integrity, url);
      store(file, url, bytes, options.update === true, final);
      results.push({ url, file, status: 'fetched' });
    } catch (error) {
      results.push({ url, file, status: 'failed', error: error instanceof Error ? error.message : String(error), ...(error instanceof CliError ? { code: error.code } : {}) });
    }
  }
  return results;
}

// ---- data and media the page fetches ----

/** The most bytes of one data file a page fetches (`d3.json(url)`), and of one remote video or audio. */
export const MAX_DATA_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

/** Where a fetched data file or remote media file is cached: the URL's hash, with the URL's own extension. */
export function dataCachePath(url: string): string {
  let ext = '';
  try {
    ext = extname(new URL(url).pathname).toLowerCase();
  } catch {
    // a URL that does not parse is never cached
  }
  return join(cdnCacheDir(), `data-${createHash('sha256').update(url).digest('hex').slice(0, 24)}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin'}`);
}

/** The cached file of `url` when it is there and its bytes are what was downloaded, else null (and why, in `reason`). */
export function resolveCdnData(url: string): { file: string } | { error: string } {
  const file = dataCachePath(url);
  if (!existsSync(file)) return { error: `${url} is not cached: run \`kinetograph fetch-deps <entry>\` (a render never downloads it)` };
  const checked = verifiedCache(file, url);
  return checked.ok ? { file } : { error: checked.error };
}

/**
 * Downloads what a page fetches or plays from the web into the cache (`fetch-deps`): https only, hosts allowed one by
 * one, no redirect to another host, a size limit, and the hash recorded for the render to check. Same rules as a script.
 */
export async function fetchCdnData(urls: string[], options: FetchOptions = {}): Promise<FetchedDep[]> {
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...(options.allowHosts ?? [])]);
  const results: FetchedDep[] = [];
  for (const url of [...new Set(urls)]) {
    const file = dataCachePath(url);
    if (!options.update && existsSync(file) && verifiedCache(file, url).ok) {
      lockCached(url, file);
      results.push({ url, file, status: 'cached' });
      continue;
    }
    try {
      const { bytes, final } = await download(url, options, allowed);
      store(file, url, bytes, options.update === true, final);
      results.push({ url, file, status: 'fetched' });
    } catch (error) {
      results.push({ url, file, status: 'failed', error: error instanceof Error ? error.message : String(error), ...(error instanceof CliError ? { code: error.code } : {}) });
    }
  }
  return results;
}
