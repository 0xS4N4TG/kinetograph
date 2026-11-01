import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg, safeRefName } from '../src/panels/brief-routes.js';
import { panelRoutes, type PanelRouteContext } from '../src/panels/routes.js';
import { cleanup, tempDir } from './helpers.js';

let server: Server;
let base: string;
let projectDir: string;
let outside: string;

beforeAll(async () => {
  projectDir = tempDir();
  outside = tempDir();
  writeFileSync(join(outside, 'secret.png'), 'secret');
  // The way the panel host will call the routes: the window's token decides `fromWindow`.
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

const put = (name: string, body: Uint8Array | string, token = 'window') =>
  fetch(`${base}/api/panels/brief/ref?token=${token}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: body as BodyInit });

const hasFfmpeg = (): boolean => {
  try {
    execFileSync(findFfmpeg(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('safeRefName', () => {
  it('keeps the last segment, safe characters and a known extension', () => {
    expect(safeRefName('My Cut (v2).MP4')).toBe('My-Cut-v2.mp4');
    expect(safeRefName('../../etc/passwd.png')).toBe('passwd.png');
    expect(safeRefName('C:\\Users\\a\\clip.mov')).toBe('clip.mov');
    expect(safeRefName('..png')).toBeNull();
    expect(safeRefName('notes.txt')).toBeNull();
    expect(safeRefName('')).toBeNull();
  });
});

describe('PUT /api/panels/brief/ref', () => {
  it('stores an image under plan/refs with a sanitised name', async () => {
    const r = await put('../../My Ref!.png', 'png-bytes');
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ src: 'plan/refs/My-Ref.png' });
    expect(readFileSync(join(projectDir, 'plan', 'refs', 'My-Ref.png'), 'utf8')).toBe('png-bytes');
    expect(existsSync(join(projectDir, 'My-Ref.png'))).toBe(false);
    expect(existsSync(join(projectDir, '..', 'My-Ref.png'))).toBe(false);
  });

  it('does not overwrite: a second file with the same name gets a suffix', async () => {
    await put('same.jpg', 'one');
    const r = await put('same.jpg', 'two');
    expect(((await r.json()) as { src: string }).src).toBe('plan/refs/same-2.jpg');
    expect(readFileSync(join(projectDir, 'plan', 'refs', 'same.jpg'), 'utf8')).toBe('one');
  });

  it('needs the window token', async () => {
    const r = await put('nope.png', 'x', 'agent');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(existsSync(join(projectDir, 'plan', 'refs', 'nope.png'))).toBe(false);
  });

  it('refuses a name that is not a video or an image, and an empty file', async () => {
    expect((await put('run.sh', 'rm -rf')).status).toBe(400);
    expect((await put('..', 'x')).status).toBe(400);
    expect((await put('empty.png', '')).status).toBe(400);
    expect(readdirSync(join(projectDir, 'plan', 'refs')).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('refuses a file over the cap from its Content-Length, writing nothing', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/panels/brief/ref?token=window&name=big.mp4`, { method: 'PUT', headers: { 'Content-Length': String(600 * 1024 * 1024) } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve(413) : reject(e)));
      req.write('x');
    });
    expect(r).toBe(413);
    expect(existsSync(join(projectDir, 'plan', 'refs', 'big.mp4'))).toBe(false);
  });

  it.skipIf(!hasFfmpeg())('makes a contact sheet of a video', async () => {
    const clip = join(tempDir(), 'clip.mp4');
    execFileSync(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=4', '-pix_fmt', 'yuv420p', clip]);
    const r = await put('clip.mp4', readFileSync(clip));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ src: 'plan/refs/clip.mp4', sheet: 'plan/refs/clip.mp4.sheet.png' });
    const sheet = readFileSync(join(projectDir, 'plan', 'refs', 'clip.mp4.sheet.png'));
    expect(sheet.subarray(1, 4).toString()).toBe('PNG');
    // 4 by 2 tiles of 360 px wide frames with 4 px between them; the clip is 16:9, so two rows are 2 x 202 px.
    expect(sheet.readUInt32BE(16)).toBe(4 * 360 + 3 * 4);
    expect(sheet.readUInt32BE(20)).toBe(2 * 202 + 4);
  });
});

describe('GET /api/panels/brief/ref', () => {
  it('serves a stored file, with the window token', async () => {
    mkdirSync(join(projectDir, 'plan', 'refs'), { recursive: true });
    const ok = await fetch(`${base}/api/panels/brief/ref?token=window&path=plan/refs/My-Ref.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('png-bytes');
    expect((await fetch(`${base}/api/panels/brief/ref?token=agent&path=plan/refs/My-Ref.png`)).status).toBe(403);
  });

  it('refuses a path outside plan/refs', async () => {
    for (const path of ['../secret.png', 'plan/refs/../../secret.png', '/etc/passwd', 'plan/refs/sub/x.png', 'plan/other.png', `${outside}/secret.png`]) {
      const r = await fetch(`${base}/api/panels/brief/ref?token=window&path=${encodeURIComponent(path)}`);
      expect(r.status, path).toBe(400);
    }
  });

  it('leaves other paths to the next handler', async () => {
    expect((await fetch(`${base}/api/panels/other?token=window`)).status).toBe(404);
  });
});
