// A store of the network answers a project's page asked for at run time (URLs it builds from its own state), so a render stays
// a function of (project, frame) and never touches the network. A record pass (`fetch-deps --record`) runs every frame with the
// network open for named hosts and keeps each response; a render only reads it back. The key is the method and the URL with
// secret query parameters removed (and the byte range of a Range request), so no secret reaches the key, the index or a message.
// Bodies are files named by their SHA-256 (equal bodies share one); one index maps key to body and headers.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Query parameters that never reach a key or a message (user-named ones are added to these). */
export const DEFAULT_SECRET_PARAMS = ['access_token', 'key', 'api_key', 'apikey', 'token'];

/** The headers a replayed response keeps. */
const KEPT_HEADERS = ['content-type', 'content-encoding', 'content-range', 'accept-ranges', 'etag', 'cache-control'];

export interface NetEntry {
  sha256: string;
  size: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface NetConfig {
  /** Where the store lives: `index.json` and the bodies under `<sha[0:2]>/<sha>`. */
  dir: string;
  mode: 'record' | 'replay';
  /** Record: the only hosts that may be reached. */
  allowHosts?: string[];
  /** Names of secret query parameters, on top of `DEFAULT_SECRET_PARAMS`. */
  secretParams?: string[];
  /** Record: written into the index. Replay: a different one is reported through `onStale`. */
  bundleSha?: string;
  /** Replay: the SHA-256 the lock pinned for the index file; a different index is an error. */
  indexSha256?: string;
  /** What a miss tells the user to run; `host` is the host of the missed URL. */
  hint?: (host: string) => string;
  onStale?: (message: string) => void;
}

interface NetState {
  config: NetConfig;
  secrets: Set<string>;
  entries: Map<string, NetEntry>;
  pending: Map<string, Promise<void>>;
  bundleSha: string | undefined;
}

let net: NetState | null = null;
let frameNow: number | null = null;

export const INDEX_FILE = 'index.json';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const blobPath = (dir: string, sha: string): string => join(dir, sha.slice(0, 2), sha);

/** `METHOD URL`, without the fragment, user info or secret parameters, plus the byte range of a Range request. */
export function netKey(method: string, url: string, range: string | null, secretParams: readonly string[] = []): string {
  const secrets = new Set([...DEFAULT_SECRET_PARAMS, ...secretParams].map((s) => s.toLowerCase()));
  const u = new URL(url);
  const kept = u.search.slice(1).split('&').filter((pair) => {
    if (pair === '') return false;
    let name = pair.split('=')[0]!;
    try {
      name = decodeURIComponent(name);
    } catch {
      // an undecodable name is compared as written
    }
    return !secrets.has(name.toLowerCase());
  });
  return `${method.toUpperCase()} ${u.origin}${u.pathname}${kept.length > 0 ? `?${kept.join('&')}` : ''}${range ? ` ${range.replace(/\s+/g, '')}` : ''}`;
}

/** Makes the shim's `fetch` record into, or replay from, the store at `config.dir`; null turns it off. */
export function setNetStore(config: NetConfig | null): void {
  net = null;
  if (config === null) return;
  const state: NetState = { config, secrets: new Set(config.secretParams ?? []), entries: new Map(), pending: new Map(), bundleSha: config.bundleSha };
  if (config.mode === 'replay') {
    const file = join(config.dir, INDEX_FILE);
    const bytes = readFileSync(file);
    if (config.indexSha256 !== undefined && sha256(bytes) !== config.indexSha256) {
      throw new Error(`${file} does not match the hash kinetograph.lock.json pinned for it: it changed since it was recorded. Record again to accept it`);
    }
    const index = JSON.parse(bytes.toString('utf8')) as { bundle?: string; entries: Record<string, NetEntry> };
    for (const [key, entry] of Object.entries(index.entries)) state.entries.set(key, entry);
    if (config.bundleSha !== undefined && index.bundle !== undefined && index.bundle !== config.bundleSha) {
      config.onStale?.('the network store was recorded for another version of this project: record it again if a request misses');
    }
  }
  net = state;
}

/** The frame being drawn, named by a miss. */
export function setNetFrame(frame: number | null): void {
  frameNow = frame;
}

const rangeOf = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string | null =>
  new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)).get('range');

function respond(entry: NetEntry, bytes: Uint8Array): Response {
  const empty = entry.status === 204 || entry.status === 205 || entry.status === 304;
  return new Response(empty ? null : (bytes as BodyInit), { status: entry.status, statusText: entry.statusText, headers: entry.headers });
}

/**
 * The answer to a remote GET or HEAD from the store (replay) or from the network, kept in the store (record); null when no
 * store is on, so the caller refuses as it did before. A replayed miss throws, naming the URL (secrets removed) and the frame.
 */
export async function netFetch(
  real: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  url: string,
  method: string,
): Promise<Response | null> {
  const state = net;
  if (state === null) return null;
  const { config } = state;
  const key = netKey(method, url, rangeOf(input, init), [...state.secrets]);
  const host = new URL(url).hostname;
  if (config.mode === 'record') {
    if (!(config.allowHosts ?? []).includes(host)) return null;
    if (!state.entries.has(key)) {
      // The same request made twice at once is one network call.
      let work = state.pending.get(key);
      if (work === undefined) {
        work = (async () => {
          const response = await real(input, init);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const sha = sha256(bytes);
          const file = blobPath(config.dir, sha);
          if (!existsSync(file)) {
            mkdirSync(join(config.dir, sha.slice(0, 2)), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, bytes);
            renameSync(tmp, file);
          }
          // `fetch` hands over the body already inflated; the header stays, as in a browser, and the length is the page's to read.
          const headers: Record<string, string> = {};
          for (const name of KEPT_HEADERS) {
            const value = response.headers.get(name);
            if (value !== null) headers[name] = value;
          }
          state.entries.set(key, { sha256: sha, size: bytes.length, status: response.status, statusText: response.statusText, headers });
        })().finally(() => state.pending.delete(key));
        state.pending.set(key, work);
      }
      await work;
    }
  }
  const entry = state.entries.get(key);
  if (entry === undefined) {
    const where = frameNow === null ? '' : ` at frame ${frameNow}`;
    const fix = config.hint ? `: run \`${config.hint(host)}\`` : '';
    throw new TypeError(`fetch("${key.slice(key.indexOf(' ') + 1)}") is not in the recorded network store${where}${fix}`);
  }
  const bytes = readFileSync(blobPath(config.dir, entry.sha256));
  if (config.mode === 'replay' && sha256(bytes) !== entry.sha256) {
    throw new Error(`the recorded body of ${key} in ${config.dir} does not match its hash: it changed since it was recorded`);
  }
  return respond(entry, bytes);
}

/**
 * Ends a record pass: writes the index (sorted by key, so the file and its hash do not depend on the order requests came in),
 * drops bodies it no longer names, and returns what the lock should pin.
 */
export function finishNetRecord(): { sha256: string; size: number; entries: number; hosts: string[] } {
  const state = net;
  if (state === null || state.config.mode !== 'record') throw new Error('no network record is running');
  const { dir } = state.config;
  mkdirSync(dir, { recursive: true });
  const entries: Record<string, NetEntry> = {};
  for (const key of [...state.entries.keys()].sort()) entries[key] = state.entries.get(key)!;
  const text = `${JSON.stringify({ version: 1, ...(state.bundleSha ? { bundle: state.bundleSha } : {}), entries })}\n`;
  const file = join(dir, INDEX_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  const named = new Set(Object.values(entries).map((e) => e.sha256));
  for (const shard of readdirSync(dir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const blob of readdirSync(join(dir, shard.name))) if (!named.has(blob)) rmSync(join(dir, shard.name, blob), { force: true });
  }
  const hosts = [...new Set(Object.keys(entries).map((key) => new URL(key.split(' ')[1]!).hostname))].sort();
  return { sha256: sha256(Buffer.from(text)), size: Buffer.byteLength(text), entries: state.entries.size, hosts };
}
