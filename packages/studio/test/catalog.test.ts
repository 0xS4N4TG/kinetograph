import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCatalog, DEFAULT_CATALOG_URL, parseCatalog } from '../src/catalog.js';
import type { CatalogPlugin } from '../src/protocol.js';
import { api, cleanup, projectSource, start, stopAll, tempDir, tokenOf } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hexed = { name: '@kinetographdev/hexed', slug: 'hexed', title: 'Hexed', description: 'Looks.', published: false, url: 'https://kinetograph.dev/plugins/hexed/' };
const paper = { name: '@kinetographdev/paper', slug: 'paper', title: 'Paper', description: 'Paper.', icon: 'https://kinetograph.dev/i/paper.svg', version: '0.1.0', published: true, url: 'https://kinetograph.dev/plugins/paper/' };
const feed = (...plugins: unknown[]) => ({ version: 1, plugins });

/** A local site: answers with `reply` on any path. */
class Site {
  hits = 0;
  reply: { status?: number; body?: string; delayMs?: number } = { body: JSON.stringify(feed(hexed, paper)) };
  server: Server = createServer((_req, res) => {
    this.hits++;
    const { status = 200, body = '', delayMs = 0 } = this.reply;
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    }, delayMs).unref();
  });
  url = '';
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/catalog`;
  }
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

const site = new Site();
beforeAll(() => site.listen());
afterAll(async () => {
  await site.close();
  await stopAll();
  cleanup();
});
afterEach(() => {
  delete process.env.KINETOGRAPH_CATALOG_URL;
  delete process.env.KINETOGRAPH_OFFLINE;
  site.hits = 0;
  site.reply = { body: JSON.stringify(feed(hexed, paper)) };
});

const names = (list: CatalogPlugin[]) => list.map((p) => p.name);
const cacheIn = () => join(tempDir(), 'cache', 'plugin-catalog.json');

describe('parseCatalog', () => {
  it('accepts a feed and keeps only the known fields', () => {
    expect(parseCatalog(feed({ ...hexed, extra: 1 }, paper))).toEqual([hexed, paper]);
  });
  it('rejects a feed of the wrong shape or version', () => {
    for (const bad of [null, [], 'x', {}, { version: 2, plugins: [] }, { version: 1 }, { version: 1, plugins: {} }]) expect(parseCatalog(bad)).toBeNull();
  });
  it('drops an invalid entry, and rejects a feed with no valid entry', () => {
    expect(names(parseCatalog(feed(hexed, { name: 'x' }, { ...paper, url: 'javascript:alert(1)' }, { ...paper, name: 'Not A Package' }))!)).toEqual(['@kinetographdev/hexed']);
    expect(parseCatalog(feed({ name: 'x' }))).toBeNull();
    expect(parseCatalog(feed())).toEqual([]);
  });
  it('accepts an https icon only, and no duplicate names', () => {
    expect(parseCatalog(feed({ ...hexed, icon: 'data:image/svg+xml,x' }))).toBeNull();
    expect(parseCatalog(feed(hexed, hexed))).toEqual([hexed]);
  });
});

describe('the catalog source', () => {
  it('uses the site answer and caches it', async () => {
    const cacheFile = cacheIn();
    const catalog = createCatalog({ url: site.url, cacheFile });
    await catalog.refreshed;
    expect(catalog.origin()).toBe('site');
    expect(catalog.get()).toEqual([hexed, paper]);
    expect(parseCatalog(JSON.parse(readFileSync(cacheFile, 'utf8')))).toEqual([hexed, paper]);
  });

  it('serves the bundled copy at once, before the site has answered', async () => {
    site.reply = { body: JSON.stringify(feed(paper)), delayMs: 100 };
    const catalog = createCatalog({ url: site.url, cacheFile: cacheIn() });
    expect(catalog.origin()).toBe('bundled');
    expect(catalog.get().length).toBeGreaterThan(0);
    expect(catalog.get().every((p) => !p.published)).toBe(true);
    await catalog.refreshed;
    expect(names(catalog.get())).toEqual(['@kinetographdev/paper']);
  });

  it('keeps the cached copy when the site times out', async () => {
    const cacheFile = cacheIn();
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(feed(paper)));
    site.reply = { body: JSON.stringify(feed(hexed)), delayMs: 2000 };
    const log = vi.fn();
    const catalog = createCatalog({ url: site.url, cacheFile, timeoutMs: 100, log });
    expect(catalog.origin()).toBe('cache');
    const began = Date.now();
    await catalog.refreshed;
    expect(Date.now() - began).toBeLessThan(1500);
    expect(catalog.origin()).toBe('cache');
    expect(names(catalog.get())).toEqual(['@kinetographdev/paper']);
    expect(log).toHaveBeenCalledOnce();
  });

  it.each([
    ['bad JSON', { body: '{nope' }],
    ['a different shape', { body: JSON.stringify({ hello: 1 }) }],
    ['a feed with no valid entry', { body: JSON.stringify(feed({ name: 5 })) }],
    ['an error status', { status: 500, body: JSON.stringify(feed(hexed)) }],
    ['an answer that is too large', { body: JSON.stringify(feed({ ...hexed, description: 'x'.repeat(600_000) })) }],
  ])('ignores %s and leaves the cache untouched', async (_label, reply) => {
    const cacheFile = cacheIn();
    mkdirSync(dirname(cacheFile), { recursive: true });
    const cached = JSON.stringify(feed(paper));
    writeFileSync(cacheFile, cached);
    site.reply = reply;
    const catalog = createCatalog({ url: site.url, cacheFile });
    await catalog.refreshed;
    expect(catalog.origin()).toBe('cache');
    expect(names(catalog.get())).toEqual(['@kinetographdev/paper']);
    expect(readFileSync(cacheFile, 'utf8')).toBe(cached);
  });

  it('falls back to the bundled copy with no cache and an unreachable site', async () => {
    const down = new Site();
    await down.listen();
    const url = down.url;
    await down.close();
    const catalog = createCatalog({ url, cacheFile: cacheIn() });
    await catalog.refreshed;
    expect(catalog.origin()).toBe('bundled');
    expect(catalog.get().length).toBeGreaterThan(0);
  });

  it('is empty, not broken, when the cache and the bundled file are both unreadable', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bad.json'), 'garbage');
    const catalog = createCatalog({ offline: true, cacheFile: join(dir, 'bad.json'), bundledFile: join(dir, 'missing.json') });
    expect(catalog.get()).toEqual([]);
  });

  it('does not fetch when offline (option or KINETOGRAPH_OFFLINE)', async () => {
    await createCatalog({ url: site.url, cacheFile: cacheIn(), offline: true }).refreshed;
    process.env.KINETOGRAPH_OFFLINE = '1';
    await createCatalog({ url: site.url, cacheFile: cacheIn() }).refreshed;
    expect(site.hits).toBe(0);
  });

  it('takes the address from KINETOGRAPH_CATALOG_URL, and from the site by default', async () => {
    process.env.KINETOGRAPH_CATALOG_URL = site.url;
    const catalog = createCatalog({ cacheFile: cacheIn() });
    await catalog.refreshed;
    expect(catalog.origin()).toBe('site');
    expect(site.hits).toBe(1);
    const seen: string[] = [];
    delete process.env.KINETOGRAPH_CATALOG_URL;
    await createCatalog({ cacheFile: cacheIn(), fetch: async (u) => (seen.push(String(u)), new Response('{}')) }).refreshed;
    expect(seen).toEqual([DEFAULT_CATALOG_URL]);
  });

  it('stops a fetch in flight when closed', async () => {
    site.reply = { body: JSON.stringify(feed(paper)), delayMs: 1500 };
    const catalog = createCatalog({ url: site.url, cacheFile: cacheIn() });
    catalog.close();
    const began = Date.now();
    await catalog.refreshed;
    expect(Date.now() - began).toBeLessThan(1000);
    expect(catalog.origin()).toBe('bundled');
  });
});

describe('GET /api/plugins/catalog', () => {
  it('serves the catalog to the window, and refuses without its token', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    writeFileSync(join(dir, 'index.tsx'), projectSource('Catalog'));
    const studio = await start(join(dir, 'index.tsx'), { catalog: { url: site.url, cacheFile: cacheIn() } });
    expect((await api(studio, '/api/plugins/catalog')).status).toBe(403);
    const headers = { 'X-Studio-Token': tokenOf(studio)! };
    // Until the site has answered it is the bundled copy; then the site's.
    await vi.waitFor(async () => expect((await api(studio, '/api/plugins/catalog', { headers })).json.plugins.map((p: CatalogPlugin) => p.name)).toEqual([hexed.name, paper.name]));
    const r = await api(studio, '/api/plugins/catalog', { headers });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(feed(hexed, paper));
  });
});
