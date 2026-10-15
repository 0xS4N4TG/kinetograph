import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openerCommand } from '../src/index.js';
import { serveStatic } from '../src/static.js';
import { stableStringify } from '../src/util.js';
import { cleanup, tempDir } from './helpers.js';

let built: Server;
let unbuilt: Server;
let builtUrl: string;
let unbuiltUrl: string;

const serve = (dir: string) =>
  new Promise<Server>((resolve) => {
    const server = createServer((req, res) => void serveStatic(new URL(req.url!, 'http://x').pathname, res, req.method === 'HEAD', dir));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

beforeAll(async () => {
  const root = tempDir();
  const dir = join(root, 'dist');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>studio</title>');
  writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(join(root, 'secret.txt'), 'outside');
  built = await serve(dir);
  unbuilt = await serve(join(root, 'missing'));
  builtUrl = urlOf(built);
  unbuiltUrl = urlOf(unbuilt);
});
afterAll(() => {
  built.close();
  unbuilt.close();
  cleanup();
});

describe('serving the built UI', () => {
  it('serves index.html at / and for paths that are no file', async () => {
    for (const path of ['/', '/index.html', '/comp/Main/frame/3']) {
      const r = await fetch(builtUrl + path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toContain('<title>studio</title>');
    }
  });

  it('serves files with their types, caching only what is hashed', async () => {
    const js = await fetch(`${builtUrl}/assets/app-1a2b.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
    const svg = await fetch(`${builtUrl}/favicon.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers HEAD without a body', async () => {
    const r = await fetch(`${builtUrl}/`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
  });

  it('never serves a file outside the directory', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt']) {
      const r = await fetch(builtUrl + path);
      expect(await r.text(), path).not.toContain('outside');
    }
  });

  it('says the UI is not built when there is no index.html', async () => {
    const r = await fetch(`${unbuiltUrl}/anything`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(await r.text()).toContain('not built');
  });
});

describe('small helpers', () => {
  it('opens the browser with the platform’s opener', () => {
    expect(openerCommand('darwin', 'http://x/')).toEqual({ command: 'open', args: ['http://x/'] });
    expect(openerCommand('linux', 'http://x/')).toEqual({ command: 'xdg-open', args: ['http://x/'] });
    expect(openerCommand('win32', 'http://x/')).toEqual({ command: 'cmd', args: ['/c', 'start', '""', 'http://x/'] });
  });

  it('stableStringify does not depend on key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(stableStringify({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});
