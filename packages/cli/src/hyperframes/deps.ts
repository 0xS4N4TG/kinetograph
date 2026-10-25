// The libraries a HyperFrames page loads from a CDN (`<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">`).
// A render never fetches them. A URL is resolved, in this order, to
//
//   1. the same package at the same version in a `node_modules` at or above the project (`gsap@3.14.2` → its dist file),
//   2. the cache `~/.cache/kinetograph/cdn/<hash of the URL>.js`, which only `kinetograph fetch-deps <entry>` fills,
//
// and is an error naming the URL and that command otherwise.

import { createHash } from 'node:crypto';
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
  if (existsSync(cached)) return { file: cached, via: 'cache' };
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

/** Downloads the URLs that are neither installed nor cached into the cache (the only code that fetches a script). */
export async function fetchCdnScripts(
  urls: string[],
  projectDir: string,
  fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = (url) => fetch(url),
): Promise<FetchedDep[]> {
  const results: FetchedDep[] = [];
  for (const url of [...new Set(urls)]) {
    const found = resolveCdnScript(url, projectDir);
    if ('file' in found) {
      results.push({ url, file: found.file, status: found.via === 'node_modules' ? 'installed' : 'cached' });
      continue;
    }
    const file = cdnCachePath(url);
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new CliError('FETCH_FAILED', `HTTP ${response.status}`);
      const text = await response.text();
      mkdirSync(dirname(file), { recursive: true });
      // The URL beside it says what the file is; the write goes through a temporary name so a reader never sees half of it.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      writeFileSync(`${file}.url`, `${url}\n`);
      results.push({ url, file, status: 'fetched' });
    } catch (error) {
      results.push({ url, file, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
