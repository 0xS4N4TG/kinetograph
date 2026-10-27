import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLock } from '@kinetographdev/core/lock';
import { fetchCdnData, fetchCdnScripts, resolveCdnScript, useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';

let dir: string;
let project: string;
const saved = process.env.KINETOGRAPH_CDN_CACHE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-lock-'));
  project = join(dir, 'project');
  mkdirSync(project);
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
});
afterEach(() => {
  useLockFile(null);
  if (saved === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const ok = (body: string): FetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});

const URL_A = 'https://cdn.jsdelivr.net/npm/somelib@1.0.0/dist/lib.min.js';
const lockPath = (): string => join(project, 'kinetograph.lock.json');

describe('kinetograph.lock.json', () => {
  it('records the sha256 and size of a first download, and a later run verifies the cache against it', async () => {
    useLockFile(lockPath());
    const [first] = await fetchCdnScripts([URL_A], project, { fetchImpl: async () => ok('var a=1;') });
    expect(first!.status).toBe('fetched');
    const lock = readLock(lockPath());
    expect(lock.files[URL_A]!.size).toBe(8);
    expect(lock.files[URL_A]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // A second run: cached, and still resolves.
    useLockFile(lockPath());
    expect(resolveCdnScript(URL_A, project)).toMatchObject({ via: 'cache' });
    const [again] = await fetchCdnScripts([URL_A], project, { fetchImpl: async () => { throw new Error('no network'); } });
    expect(again!.status).toBe('cached');
  });

  it('fails clearly when the cache no longer matches the lock', async () => {
    useLockFile(lockPath());
    await fetchCdnScripts([URL_A], project, { fetchImpl: async () => ok('var a=1;') });
    // Another project's run replaced the cached bytes and their recorded hash: the lock still says the first.
    const file = readdirSync(join(dir, 'cache')).filter((f) => f.endsWith('.js'))[0]!;
    const { createHash } = await import('node:crypto');
    const changed = 'var a=2;';
    writeFileSync(join(dir, 'cache', file), changed);
    writeFileSync(join(dir, 'cache', `${file}.sha256`), `${createHash('sha256').update(changed).digest('hex')}\n`);
    useLockFile(lockPath());
    const found = resolveCdnScript(URL_A, project);
    expect('error' in found && found.error).toContain('kinetograph.lock.json');
    expect('error' in found && found.error).toContain('fetch-deps <entry> --update');
  });

  it('refuses a download whose bytes differ from the lock, and --update accepts it', async () => {
    useLockFile(lockPath());
    await fetchCdnData([URL_A], { fetchImpl: async () => ok('one') });
    rmSync(join(dir, 'cache'), { recursive: true });
    useLockFile(lockPath());
    const [refused] = await fetchCdnData([URL_A], { fetchImpl: async () => ok('two') });
    expect(refused!.status).toBe('failed');
    expect(refused!.code).toBe('LOCK_MISMATCH');
    expect(refused!.error).toContain('--update');

    useLockFile(lockPath(), true);
    const [updated] = await fetchCdnData([URL_A], { update: true, fetchImpl: async () => ok('two') });
    expect(updated!.status).toBe('fetched');
    expect(readLock(lockPath()).files[URL_A]!.size).toBe(3);
  });

  it('adds a file that is cached but not yet locked (downloaded by another project)', async () => {
    await fetchCdnData([URL_A], { fetchImpl: async () => ok('shared') });
    useLockFile(lockPath());
    const [cached] = await fetchCdnData([URL_A], { fetchImpl: async () => { throw new Error('no network'); } });
    expect(cached!.status).toBe('cached');
    expect(readLock(lockPath()).files[URL_A]!.size).toBe(6);
  });

  it('writes the lock sorted, and leaves no temporary files', async () => {
    useLockFile(lockPath());
    await fetchCdnData(['https://esm.sh/b', 'https://esm.sh/a'], { fetchImpl: async () => ok('x') });
    expect(Object.keys(JSON.parse(readFileSync(lockPath(), 'utf8')).files)).toEqual(['https://esm.sh/a', 'https://esm.sh/b']);
    expect(readdirSync(join(dir, 'cache')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(project).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('prefetch', () => {
  it('downloads a CDN script of a page before the render and locks it', async () => {
    writeFileSync(
      join(project, 'index.html'),
      `<!doctype html><html><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div>
<script src="${URL_A}"></script></body></html>`,
    );
    const calls: string[] = [];
    const result = await prefetchHyperframes(join(project, 'index.html'), {
      fetchImpl: async (url) => {
        calls.push(url);
        return ok('window.lib=1;');
      },
    });
    expect(calls).toEqual([URL_A]);
    expect(result.fetched).toBe(1);
    expect(readLock(join(project, 'kinetograph.lock.json')).files[URL_A]!.size).toBe(13);

    // The second run is offline in effect: nothing is requested.
    const second = await prefetchHyperframes(join(project, 'index.html'), { fetchImpl: async () => { throw new Error('no network'); } });
    expect(second.fetched).toBe(0);
    expect(second.files[0]!.status).toBe('cached');
  });
});
