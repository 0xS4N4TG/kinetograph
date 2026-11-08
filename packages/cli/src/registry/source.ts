// Reading a registry: over https, or from a folder (`KINETOGRAPH_REGISTRY`, for tests and local use). Everything read
// is data. Nothing from a registry is ever executed, and every read has a size limit.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { CliError } from '../errors.js';
import { isItemName } from './item.js';

export const DEFAULT_REGISTRY = 'https://kinetograph.dev/r';
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

export interface Registry {
  /** Where it reads from, for messages. */
  readonly location: string;
  /** `<name>.json` (or `index` for the index). */
  readJson(name: string): Promise<unknown>;
  /** A binary file named by an item's `url`, relative to that item's JSON file. */
  readFile(itemName: string, url: string): Promise<Uint8Array>;
}

/**
 * Headers for registry requests. The seam for a licence key: a paid item will be fetched with
 * `Authorization: Bearer <KINETOGRAPH_LICENSE_KEY>`. No keys are read yet, so nothing is sent.
 */
export function requestHeaders(): Record<string, string> {
  return {};
}

export interface OpenOptions {
  /** `KINETOGRAPH_REGISTRY` or the default. */
  spec?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

export function openRegistry(options: OpenOptions = {}): Registry {
  const spec = (options.spec ?? process.env.KINETOGRAPH_REGISTRY ?? '') || DEFAULT_REGISTRY;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    if (!/^https:\/\//i.test(spec)) throw new CliError('INSECURE_URL', `the registry must be an https URL or a folder, got ${spec}`);
    return httpsRegistry(spec.replace(/\/+$/, ''), options.fetch ?? fetch);
  }
  const root = resolve(spec);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new CliError('REGISTRY_ERROR', `the registry folder ${root} does not exist`);
  return folderRegistry(root, options.fetch ?? fetch);
}

function checkName(name: string): void {
  if (name !== 'index' && !isItemName(name)) throw new CliError('INVALID_ARG', `"${name}" is not an item name (lowercase letters, digits and hyphens)`);
}

function parseJson(text: string, from: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('REGISTRY_ERROR', `${from} is not valid JSON`);
  }
}

function tooBig(from: string, limit: number): CliError {
  return new CliError('TOO_LARGE', `${from} is larger than the ${Math.round(limit / 1024 / 1024)} MB limit`);
}

function httpsRegistry(base: string, fetchImpl: typeof fetch): Registry {
  return {
    location: base,
    async readJson(name) {
      checkName(name);
      const url = `${base}/${name}.json`;
      const bytes = await download(new URL(url), MAX_JSON_BYTES, fetchImpl, name === 'index' ? undefined : `no item named "${name}" in the registry (${url})`);
      return parseJson(Buffer.from(bytes).toString('utf8'), url);
    },
    async readFile(itemName, url) {
      return download(fileUrl(new URL(`${base}/${itemName}.json`), url), MAX_FILE_BYTES, fetchImpl);
    },
  };
}

function folderRegistry(root: string, fetchImpl: typeof fetch): Registry {
  const realRoot = realpathSync(root);
  /** The file at `path` under the registry folder, refusing a link or a path that leads out of it. */
  const readInside = (path: string, limit: number): Uint8Array => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new CliError('UNSAFE_PATH', `${path} is outside the registry folder`);
    if (!existsSync(file)) throw new CliError('REGISTRY_ERROR', `no such file in the registry: ${path}`);
    if (lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(realRoot + sep)) throw new CliError('UNSAFE_PATH', `${path} is a link out of the registry folder`);
    if (statSync(file).size > limit) throw tooBig(path, limit);
    return readFileSync(file);
  };
  return {
    location: root,
    async readJson(name) {
      checkName(name);
      const path = `${name}.json`;
      if (name !== 'index' && !existsSync(resolve(root, path))) throw new CliError('NOT_FOUND', `no item named "${name}" in the registry (${root})`);
      return parseJson(Buffer.from(readInside(path, MAX_JSON_BYTES)).toString('utf8'), path);
    },
    async readFile(_itemName, url) {
      // A folder has no origin, so a file it names must be in the folder; an absolute URL can only be refused.
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) fileUrl(undefined, url);
      return readInside(url, MAX_FILE_BYTES);
    },
  };
}

/**
 * `url` against the item's own URL. It must come out as https (INSECURE_URL) and on the same origin as the item
 * (UNSAFE_URL: scheme, host and port), so a registry cannot send the CLI to fetch from somewhere else. Without an
 * `itemUrl` (a folder registry) no absolute URL is allowed.
 */
function fileUrl(itemUrl: URL | undefined, url: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(url, itemUrl ?? 'https://folder.invalid/');
  } catch {
    throw new CliError('INVALID_ITEM', `"${url}" is not a URL`);
  }
  if (resolved.protocol !== 'https:') throw new CliError('INSECURE_URL', `${resolved.href} is not an https URL`);
  if (resolved.origin !== (itemUrl ?? resolved).origin || itemUrl === undefined) {
    throw new CliError('UNSAFE_URL', `${resolved.href} is not on the registry's own origin${itemUrl ? ` (${itemUrl.origin})` : ''}`);
  }
  return resolved;
}

/** One GET over https, following at most 3 redirects (each to https), refusing more than `limit` bytes. */
export async function download(url: URL, limit: number, fetchImpl: typeof fetch, notFound?: string): Promise<Uint8Array> {
  for (let hops = 0; ; hops++) {
    if (url.protocol !== 'https:') throw new CliError('INSECURE_URL', `${url.href} is not an https URL`);
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', headers: requestHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new CliError('NETWORK', `could not reach ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hops >= MAX_REDIRECTS) throw new CliError('NETWORK', `${url.href} redirects too many times`);
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    if (response.status === 404 && notFound !== undefined) throw new CliError('NOT_FOUND', notFound);
    if (!response.ok) throw new CliError('NETWORK', `${url.href} answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > limit) throw tooBig(url.href, limit);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array(await response.arrayBuffer());
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw tooBig(url.href, limit);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
