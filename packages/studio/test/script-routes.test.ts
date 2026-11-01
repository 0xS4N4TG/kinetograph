import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { panelRoutes, type PanelRouteContext } from '../src/panels/routes.js';
import { audioSegments, rangeOf } from '../src/panels/script-routes.js';
import { cleanup, tempDir } from './helpers.js';

let server: Server;
let base: string;
let projectDir: string;
let outside: string;

beforeAll(async () => {
  projectDir = tempDir();
  outside = tempDir();
  writeFileSync(join(outside, 'secret.mp3'), 'SECRETBYTES');
  mkdirSync(join(projectDir, 'audio'));
  writeFileSync(join(projectDir, 'audio', 'track.mp3'), '0123456789');
  writeFileSync(join(projectDir, 'audio', 'notes.txt'), 'not audio');
  mkdirSync(join(outside, 'dir'));
  writeFileSync(join(outside, 'dir', 'inner.wav'), 'INNERBYTES');
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ctx: PanelRouteContext = { projectDir, fromWindow: url.searchParams.get('token') === 'window' };
      for (const route of panelRoutes) if (await route(req, res, url, ctx)) return;
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  cleanup();
});

const get = (path: string, token = 'window', headers: Record<string, string> = {}) =>
  fetch(`${base}/api/panels/script/audio?token=${token}&path=${encodeURIComponent(path)}`, { headers });

describe('audioSegments and rangeOf', () => {
  it('take a plain relative audio path and nothing else', () => {
    expect(audioSegments('audio/track.mp3')).toEqual(['audio', 'track.mp3']);
    expect(audioSegments('Song.WAV')).toEqual(['Song.WAV']);
    for (const bad of ['', '/etc/a.mp3', '../a.mp3', 'a/../b.mp3', 'a//b.mp3', './a.mp3', 'a\\b.mp3', 'C:/a.mp3', 'a.txt', 'a.mp3\0', 'noext']) {
      expect(audioSegments(bad), bad).toBeNull();
    }
  });

  it('reads one byte range', () => {
    expect(rangeOf(undefined, 10)).toBeNull();
    expect(rangeOf('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(rangeOf('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(rangeOf('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(rangeOf('bytes=2-99', 10)).toEqual({ start: 2, end: 9 });
    expect(rangeOf('bytes=10-', 10)).toBe('bad');
    expect(rangeOf('bytes=5-2', 10)).toBe('bad');
    expect(rangeOf('bytes=-', 10)).toBe('bad');
    expect(rangeOf('items=1-2', 10)).toBe('bad');
  });
});

describe('GET /api/panels/script/audio', () => {
  it('serves an audio file of the project to the window, whole or by range', async () => {
    const whole = await get('audio/track.mp3');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/mpeg');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('0123456789');
    const part = await get('audio/track.mp3', 'window', { Range: 'bytes=2-4' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await part.text()).toBe('234');
    expect((await get('audio/track.mp3', 'window', { Range: 'bytes=50-' })).status).toBe(416);
  });

  it('is for the window only', async () => {
    expect((await get('audio/track.mp3', 'agent')).status).toBe(403);
    expect((await get('audio/track.mp3', 'none')).status).toBe(403);
  });

  it('refuses paths that are not plain relative audio paths', async () => {
    for (const path of ['audio/notes.txt', '../secret.mp3', 'audio/../audio/track.mp3', '/etc/passwd.mp3', `${outside}/secret.mp3`, '']) {
      expect((await get(path)).status, path).toBe(400);
    }
  });

  it('says 404 for a file that is not there', async () => {
    expect((await get('audio/missing.mp3')).status).toBe(404);
  });

  it('does not serve a link, or a file behind a linked directory', async () => {
    symlinkSync(join(outside, 'secret.mp3'), join(projectDir, 'audio', 'leak.mp3'));
    symlinkSync(join(outside, 'dir'), join(projectDir, 'linked'));
    const file = await get('audio/leak.mp3');
    expect(file.status).toBe(403);
    expect(await file.text()).not.toContain('SECRETBYTES');
    const dir = await get('linked/inner.wav');
    expect(dir.status).toBe(403);
    expect(await dir.text()).not.toContain('INNERBYTES');
    rmSync(join(projectDir, 'audio', 'leak.mp3'));
    rmSync(join(projectDir, 'linked'));
  });

  it('does not serve a directory with an audio name', async () => {
    mkdirSync(join(projectDir, 'folder.mp3'));
    expect((await get('folder.mp3')).status).toBe(403);
  });

  it('leaves other paths to the next handler', async () => {
    expect((await fetch(`${base}/api/panels/script/other?token=window`)).status).toBe(404);
  });
});
