// The plugin catalog Studio lists as "Available": the plugins of the Kinetograph site, for a project that does not have
// them yet. It is read at start from the site's /api/catalog without making anyone wait: the list is the cached copy of
// the last good answer, else the copy bundled with this package (catalog/plugins.json, written by
// scripts/sync-catalog.mjs from the site's own feed function), and a fetch with a short timeout replaces it when the
// site answers with something valid. A site that is down, slow or sends garbage changes nothing; `--offline` skips the fetch.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogPlugin } from './protocol.js';

export const DEFAULT_CATALOG_URL = 'https://kinetograph.dev/api/catalog';
const TIMEOUT_MS = 3000;
const MAX_BYTES = 512 * 1024;
const BUNDLED_FILE = fileURLToPath(new URL('../catalog/plugins.json', import.meta.url));

/** Next to the font cache (`~/.cache/kinetograph/fonts`). */
export const defaultCatalogCacheFile = (): string => join(homedir(), '.cache', 'kinetograph', 'plugin-catalog.json');

export interface CatalogOptions {
  url?: string;
  cacheFile?: string;
  offline?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  bundledFile?: string;
  log?: (message: string) => void;
}

export interface CatalogSource {
  /** The best list known now. */
  get(): CatalogPlugin[];
  /** Where `get()` comes from: `site` once a fetch succeeded, else `cache` or `bundled`. */
  origin(): 'site' | 'cache' | 'bundled';
  /** Settles (never rejects) when the fetch at start is over. */
  refreshed: Promise<void>;
  /** Stops a fetch in flight. */
  close(): void;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const webUrl = (v: unknown): v is string => text(v, 2048) && /^https?:\/\/[^\s]+$/.test(v);

function entry(value: unknown): CatalogPlugin | null {
  if (!isObject(value)) return null;
  const { name, slug, title, description, icon, version, published, url } = value;
  if (!text(name, 214) || !NPM_NAME.test(name) || !text(slug, 100) || !/^[a-z0-9-]+$/.test(slug) || !text(title, 100)) return null;
  if (typeof description !== 'string' || description.length > 2000 || typeof published !== 'boolean' || !webUrl(url)) return null;
  const out: CatalogPlugin = { name, slug, title, description, published, url };
  if (icon !== undefined && icon !== '') {
    if (!webUrl(icon)) return null;
    out.icon = icon;
  }
  if (version !== undefined && version !== '') {
    if (!text(version, 64)) return null;
    out.version = version;
  }
  return out;
}

/**
 * The plugins of a feed (`{ version: 1, plugins }`), or null when it is not one. An entry that is not valid is left
 * out, but a feed that lists plugins and has no valid one is rejected, so garbage never replaces a good copy.
 */
export function parseCatalog(value: unknown): CatalogPlugin[] | null {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.plugins)) return null;
  const seen = new Set<string>();
  const plugins: CatalogPlugin[] = [];
  for (const raw of value.plugins) {
    const plugin = entry(raw);
    if (plugin && !seen.has(plugin.name)) {
      seen.add(plugin.name);
      plugins.push(plugin);
    }
  }
  return plugins.length === 0 && value.plugins.length > 0 ? null : plugins;
}

function readFeed(file: string): CatalogPlugin[] | null {
  try {
    return parseCatalog(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function createCatalog(options: CatalogOptions = {}): CatalogSource {
  const url = options.url ?? (process.env.KINETOGRAPH_CATALOG_URL || DEFAULT_CATALOG_URL);
  const cacheFile = options.cacheFile ?? defaultCatalogCacheFile();
  const offline = options.offline ?? process.env.KINETOGRAPH_OFFLINE === '1';
  const log = options.log ?? (() => undefined);
  const controller = new AbortController();

  const cached = readFeed(cacheFile);
  let current: CatalogPlugin[] = cached ?? readFeed(options.bundledFile ?? BUNDLED_FILE) ?? [];
  let origin: 'site' | 'cache' | 'bundled' = cached ? 'cache' : 'bundled';

  async function refresh(): Promise<void> {
    try {
      const response = await (options.fetch ?? fetch)(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > MAX_BYTES) throw new Error('the answer is too large');
      const plugins = parseCatalog(JSON.parse(body));
      if (!plugins) throw new Error('the answer is not a plugin catalog');
      current = plugins;
      origin = 'site';
      try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        const temporary = `${cacheFile}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, plugins }));
        renameSync(temporary, cacheFile);
      } catch {
        // No cache directory to write to: the list still serves from memory.
      }
    } catch (error) {
      log(`plugin catalog: ${(error as Error).message}; using the ${origin} copy`);
    }
  }

  return {
    get: () => current,
    origin: () => origin,
    refreshed: offline ? Promise.resolve() : refresh(),
    close: () => controller.abort(),
  };
}
