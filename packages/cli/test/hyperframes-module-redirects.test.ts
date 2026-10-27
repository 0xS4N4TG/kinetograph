import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readLock } from '@kinetographdev/core/lock';
import { dataCachePath, fetchCdnData, finalUrlOf, useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';
import { buildPlan } from '../src/hyperframes/plan.js';

// A real HTTP server behind the https URLs: the code under test redirects by hand, as a render's download does.
const ROUTES: Record<string, { status: number; location?: string; body?: string }> = {
  '/a/start.js': { status: 302, location: '/b/real/main.js' },
  '/b/real/main.js': { status: 200, body: 'import { x } from "./dep.js";\nwindow.fromDep = x;\nwindow.moduleUrl = import.meta.url;\n' },
  '/b/real/other.js': { status: 200, body: 'import { x } from "./dep.js";\nwindow.fromDep = x;\n' },
  '/b/real/dep.js': { status: 200, body: 'export const x = "dep from b/real";\n' },
  // What a browser would never ask for: a relative import resolved against the requested URL.
  '/a/dep.js': { status: 200, body: 'export const x = "WRONG: dep from a";\n' },
  '/away.js': { status: 302, location: 'https://evil.example/x.js' },
};

let server: Server;
let port: number;
const requested: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url ?? ''];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(route.status, route.location ? { location: route.location } : {}).end(route.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** `https://esm.sh/<path>` is served by the local server; a redirect is handed back as it is. */
const localFetch = async (url: string): Promise<FetchResponse> => {
  requested.push(url);
  const parsed = new URL(url);
  const response = await fetch(`http://127.0.0.1:${port}${parsed.pathname}`, { redirect: 'manual' });
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    arrayBuffer: () => response.arrayBuffer(),
  };
};

let dir: string;
let index: string;
const saved = process.env.KINETOGRAPH_CDN_CACHE;

beforeEach(() => {
  requested.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'kg-redirect-'));
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
  index = join(dir, 'index.html');
  writeFileSync(
    index,
    `<!doctype html><html><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div>
<script type="module" src="https://esm.sh/a/start.js"></script></body></html>`,
  );
});
afterEach(() => {
  useLockFile(null);
  if (saved === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('a module whose download was redirected', () => {
  it('resolves its relative imports and import.meta.url against the final URL', async () => {
    const result = await prefetchHyperframes(index, { fetchImpl: localFetch });
    expect(result.files.filter((f) => f.status === 'failed')).toEqual([]);
    // The import was asked for at the redirect's target, not at the requested URL's directory.
    expect(requested).toContain('https://esm.sh/b/real/dep.js');
    expect(requested).not.toContain('https://esm.sh/a/dep.js');

    // The cache and the lock both remember where the request ended.
    const url = 'https://esm.sh/a/start.js';
    expect(readFileSync(`${dataCachePath(url)}.final`, 'utf8').trim()).toBe('https://esm.sh/b/real/main.js');
    expect(readLock(join(dir, 'kinetograph.lock.json')).files[url]?.final).toBe('https://esm.sh/b/real/main.js');
    expect(readLock(join(dir, 'kinetograph.lock.json')).files['https://esm.sh/b/real/dep.js']?.final).toBeUndefined();

    // A render builds from the cache alone and gets the same bases.
    useLockFile(null);
    const { plan } = await buildPlan(index);
    expect(plan.notes).toEqual([]);
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const script of plan.scripts) new vm.Script(script.code, { filename: script.file }).runInContext(sandbox);
    expect(sandbox.fromDep).toBe('dep from b/real');
    expect(sandbox.moduleUrl).toBe('https://esm.sh/b/real/main.js');
  });

  it('never takes the final URL from the lock: a tampered one is a mismatch, not a base', async () => {
    await prefetchHyperframes(index, { fetchImpl: localFetch });
    useLockFile(null);
    const lockFile = join(dir, 'kinetograph.lock.json');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    lock.files['https://esm.sh/a/start.js'].final = 'https://esm.sh/evil/';
    writeFileSync(lockFile, JSON.stringify(lock));
    // Resolution stops rather than resolve imports against the lock's value.
    await expect(buildPlan(index)).rejects.toThrow(/locked it at https:\/\/esm\.sh\/evil\//);
    useLockFile(lockFile);
    expect(() => finalUrlOf('https://esm.sh/a/start.js')).toThrow(/kinetograph fetch-deps/);
    // A download of it again sees a different redirect target than the lock pins.
    rmSync(join(dir, 'cache'), { recursive: true, force: true });
    const again = await prefetchHyperframes(index, { fetchImpl: localFetch });
    expect(again.files.find((f) => f.url === 'https://esm.sh/a/start.js')?.code).toBe('LOCK_MISMATCH');
  });

  it('ignores a cache record that is not https', async () => {
    await prefetchHyperframes(index, { fetchImpl: localFetch });
    useLockFile(null);
    writeFileSync(`${dataCachePath('https://esm.sh/a/start.js')}.final`, 'http://esm.sh/b/real/main.js\n');
    expect(finalUrlOf('https://esm.sh/a/start.js')).toBe('https://esm.sh/a/start.js');
    writeFileSync(`${dataCachePath('https://esm.sh/a/start.js')}.final`, 'https://elsewhere.example/main.js\n');
    expect(finalUrlOf('https://esm.sh/a/start.js')).toBe('https://esm.sh/a/start.js');
  });

  it('pins the redirect target like the bytes: a server that redirects elsewhere is a LOCK_MISMATCH, and --update accepts it', async () => {
    await prefetchHyperframes(index, { fetchImpl: localFetch });
    useLockFile(null);
    rmSync(join(dir, 'cache'), { recursive: true, force: true });
    const original = ROUTES['/a/start.js']!;
    ROUTES['/a/start.js'] = { status: 302, location: '/b/real/other.js' };
    try {
      const refused = await prefetchHyperframes(index, { fetchImpl: localFetch });
      const entry = refused.files.find((f) => f.url === 'https://esm.sh/a/start.js');
      expect(entry?.status).toBe('failed');
      expect(entry?.code).toBe('LOCK_MISMATCH');
      expect(entry?.error).toMatch(/redirected to https:\/\/esm\.sh\/b\/real\/other\.js.*locked it at https:\/\/esm\.sh\/b\/real\/main\.js/);
      useLockFile(null);
      const accepted = await prefetchHyperframes(index, { fetchImpl: localFetch, update: true });
      expect(accepted.files.filter((f) => f.status === 'failed')).toEqual([]);
      expect(readLock(join(dir, 'kinetograph.lock.json')).files['https://esm.sh/a/start.js']?.final).toBe('https://esm.sh/b/real/other.js');
    } finally {
      ROUTES['/a/start.js'] = original;
    }
  });

  it('records no final URL for a download that was not redirected', async () => {
    const [result] = await fetchCdnData(['https://esm.sh/b/real/dep.js'], { fetchImpl: localFetch });
    expect(result?.status).toBe('fetched');
    expect(existsSync(`${dataCachePath('https://esm.sh/b/real/dep.js')}.final`)).toBe(false);
  });

  it('still refuses a redirect to a host that is not allowed', async () => {
    const [refused] = await fetchCdnData(['https://esm.sh/away.js'], { fetchImpl: localFetch });
    expect(refused?.status).toBe('failed');
    expect(refused?.code).toBe('FETCH_REFUSED');
    expect(refused?.error).toMatch(/evil\.example/);
    expect(requested).toEqual(['https://esm.sh/away.js']);
  });
});
