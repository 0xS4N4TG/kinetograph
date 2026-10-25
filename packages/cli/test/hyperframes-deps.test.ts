import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cdnCachePath,
  fetchCdnScripts,
  parseCdnUrl,
  resolveCdnScript,
  type FetchResponse,
} from '../src/hyperframes/deps.js';

let dir: string;
let project: string;
const savedCache = process.env.KINETOGRAPH_CDN_CACHE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-deps-'));
  project = join(dir, 'project');
  mkdirSync(project);
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
});
afterEach(() => {
  if (savedCache === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = savedCache;
  rmSync(dir, { recursive: true, force: true });
});

const ok = (body: string, headers: Record<string, string> = {}): FetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const redirect = (to: string): FetchResponse => ({
  ok: false,
  status: 302,
  headers: { get: (n) => (n.toLowerCase() === 'location' ? to : null) },
  arrayBuffer: async () => new ArrayBuffer(0),
});

const URL_OK = 'https://cdn.jsdelivr.net/npm/somelib@1.0.0/dist/lib.min.js';

describe('CDN URLs', () => {
  it('names the package, version and file', () => {
    expect(parseCdnUrl('https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js')).toEqual({ pkg: 'gsap', version: '3.14.2', path: 'dist/gsap.min.js' });
    expect(parseCdnUrl('https://unpkg.com/@scope/pkg@2.0.0/x.js')).toEqual({ pkg: '@scope/pkg', version: '2.0.0', path: 'x.js' });
    expect(parseCdnUrl('https://example.com/x.js')).toBeNull();
  });

  it('resolves to an installed package of the same version, and not another', () => {
    const pkg = join(dir, 'node_modules', 'somelib');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'somelib', version: '1.0.0' }));
    writeFileSync(join(pkg, 'dist', 'lib.min.js'), 'x');
    expect(resolveCdnScript(URL_OK, project)).toEqual({ file: join(pkg, 'dist', 'lib.min.js'), via: 'node_modules' });
    const other = resolveCdnScript(URL_OK.replace('1.0.0', '2.0.0'), project);
    expect('error' in other && other.error).toContain('fetch-deps');
  });

  it('names the URL and the command when nothing has it', () => {
    const found = resolveCdnScript(URL_OK, project);
    expect('error' in found && found.error).toContain(URL_OK);
    expect('error' in found && found.error).toContain('kinetograph fetch-deps');
  });
});

describe('fetch-deps', () => {
  it('downloads from an allowed host, records the hash, and a render then resolves it', async () => {
    const [result] = await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => ok('var a=1;') });
    expect(result!.status).toBe('fetched');
    expect(resolveCdnScript(URL_OK, project)).toEqual({ file: cdnCachePath(URL_OK), via: 'cache' });
  });

  it('refuses http', async () => {
    const [result] = await fetchCdnScripts(['http://cdn.jsdelivr.net/npm/x@1.0.0/a.js'], project, { fetchImpl: async () => ok('x') });
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('only https');
  });

  it('takes // as https', async () => {
    const seen: string[] = [];
    const [result] = await fetchCdnScripts(['//unpkg.com/x@1.0.0/a.js'], project, {
      fetchImpl: async (u) => (seen.push(u), ok('x')),
    });
    expect(result!.status).toBe('fetched');
    expect(seen).toEqual(['https://unpkg.com/x@1.0.0/a.js']);
  });

  it('refuses a foreign host without --allow-host, and allows it with', async () => {
    const url = 'https://evil.example/lib.js';
    const [refused] = await fetchCdnScripts([url], project, { fetchImpl: async () => ok('x') });
    expect(refused!.status).toBe('failed');
    expect(refused!.error).toContain(url);
    expect(refused!.error).toContain('--allow-host evil.example');
    const [allowed] = await fetchCdnScripts([url], project, { allowHosts: ['evil.example'], fetchImpl: async () => ok('x') });
    expect(allowed!.status).toBe('fetched');
  });

  it('refuses a redirect to http or to a host that is not allowed', async () => {
    const toHttp = await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => redirect('http://cdn.jsdelivr.net/x.js') });
    expect(toHttp[0]!.error).toContain('only https');
    const away = await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => redirect('https://evil.example/x.js') });
    expect(away[0]!.error).toContain('not an allowed host');
  });

  it('follows a redirect inside the allowed hosts', async () => {
    let calls = 0;
    const [result] = await fetchCdnScripts([URL_OK], project, {
      fetchImpl: async () => (calls++ === 0 ? redirect('https://unpkg.com/somelib@1.0.0/dist/lib.min.js') : ok('ok')),
    });
    expect(result!.status).toBe('fetched');
  });

  it('checks the integrity attribute and caches nothing on a mismatch', async () => {
    const good = `sha384-${createHash('sha384').update('var a=1;').digest('base64')}`;
    const [fine] = await fetchCdnScripts([URL_OK], project, { integrity: { [URL_OK]: good }, fetchImpl: async () => ok('var a=1;') });
    expect(fine!.status).toBe('fetched');
    rmSync(cdnCachePath(URL_OK));
    rmSync(`${cdnCachePath(URL_OK)}.sha256`);
    const [bad] = await fetchCdnScripts([URL_OK], project, { integrity: { [URL_OK]: good }, fetchImpl: async () => ok('var a=2;') });
    expect(bad!.status).toBe('failed');
    expect(bad!.error).toContain('integrity');
    expect('error' in resolveCdnScript(URL_OK, project)).toBe(true);
  });

  it('refuses a response over the size limit', async () => {
    const [result] = await fetchCdnScripts([URL_OK], project, { maxBytes: 4, fetchImpl: async () => ok('too long') });
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('limit');
  });

  it('does not run a cached file that was changed, or one with no recorded hash', async () => {
    await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => ok('var a=1;') });
    const file = cdnCachePath(URL_OK);
    writeFileSync(file, 'evil()');
    const tampered = resolveCdnScript(URL_OK, project);
    expect('error' in tampered && tampered.error).toContain('does not match');
    rmSync(`${file}.sha256`);
    const unhashed = resolveCdnScript(URL_OK, project);
    expect('error' in unhashed && unhashed.error).toContain('no recorded hash');
    // fetch-deps replaces it.
    const [again] = await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => ok('var a=1;') });
    expect(again!.status).toBe('fetched');
    expect('file' in resolveCdnScript(URL_OK, project)).toBe(true);
  });

  it('checks the page\'s integrity against a copy already cached: downloads again once, else refuses', async () => {
    await fetchCdnScripts([URL_OK], project, { fetchImpl: async () => ok('var a=1;') });
    const want = `sha256-${createHash('sha256').update('var b=2;').digest('base64')}`;
    // The cached bytes do not match: fetched again, and the new bytes do.
    const [again] = await fetchCdnScripts([URL_OK], project, { integrity: { [URL_OK]: want }, fetchImpl: async () => ok('var b=2;') });
    expect(again!.status).toBe('fetched');
    // Neither the cached nor the downloaded bytes match: refused.
    const wrong = `sha256-${createHash('sha256').update('other').digest('base64')}`;
    const [refused] = await fetchCdnScripts([URL_OK], project, { integrity: { [URL_OK]: wrong }, fetchImpl: async () => ok('var b=2;') });
    expect(refused!.status).toBe('failed');
    expect(refused!.error).toContain('integrity');
  });

  it('refuses an installed copy that does not match the page\'s integrity', async () => {
    const pkg = join(dir, 'node_modules', 'somelib');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'somelib', version: '1.0.0' }));
    writeFileSync(join(pkg, 'dist', 'lib.min.js'), 'var a=1;');
    const wrong = `sha256-${createHash('sha256').update('other').digest('base64')}`;
    const [result] = await fetchCdnScripts([URL_OK], project, { integrity: { [URL_OK]: wrong }, fetchImpl: async () => ok('x') });
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('installed copy');
  });
});
