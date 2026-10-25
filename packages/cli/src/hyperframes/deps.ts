// The libraries a HyperFrames page loads from a CDN (`<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">`).
// A render never fetches them. A URL is resolved, in this order, to
//
//   1. the same package at the same version in a `node_modules` at or above the project (`gsap@3.14.2` → its dist file),
//   2. the cache `~/.cache/kinetograph/cdn/<hash of the URL>.js`, which only `kinetograph fetch-deps <entry>` fills,
//
// and is an error naming the URL and that command otherwise.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
export const DEFAULT_ALLOWED_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh'];
/** The most bytes of one script. */
export const MAX_SCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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

async function download(url: string, options: FetchOptions, allowed: Set<string>): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? ((u, init) => fetch(u, init) as Promise<FetchResponse>);
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
    return bytes;
  }
}

/** Downloads the URLs that are neither installed nor cached into the cache (the only code that fetches a script). */
export async function fetchCdnScripts(urls: string[], projectDir: string, options: FetchOptions = {}): Promise<FetchedDep[]> {
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...(options.allowHosts ?? [])]);
  const results: FetchedDep[] = [];
  for (const raw of [...new Set(urls)]) {
    const url = normalizeScriptUrl(raw);
    const found = resolveCdnScript(url, projectDir);
    if ('file' in found) {
      results.push({ url, file: found.file, status: found.via === 'node_modules' ? 'installed' : 'cached' });
      continue;
    }
    const file = cdnCachePath(url);
    try {
      const bytes = await download(url, options, allowed);
      const integrity = options.integrity?.[raw] ?? options.integrity?.[url];
      if (integrity) verifyIntegrity(bytes, integrity, url);
      mkdirSync(dirname(file), { recursive: true });
      // Temporary names, so a reader never sees half a file; the hash goes last.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
      writeFileSync(`${file}.url`, `${url}\n`);
      writeFileSync(hashFile(file), `${sha256Hex(bytes)}\n`);
      results.push({ url, file, status: 'fetched' });
    } catch (error) {
      results.push({ url, file, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
