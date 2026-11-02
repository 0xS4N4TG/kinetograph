import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isStoredName, missingImages, safeImageName, sniffImage } from '../src/agent-images.js';
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

const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const put = (name: string, body: Uint8Array | string, token = 'window') =>
  fetch(`${base}/api/agent/image?token=${token}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: body as BodyInit });
const refs = (): string => join(projectDir, 'public', 'refs');

describe('names and sniffing', () => {
  it('cleans a name and takes only picture types', () => {
    expect(safeImageName('../../My Shot (1).PNG')).toBe('My-Shot-1.png');
    expect(safeImageName('photo.avif')).toBe('photo.avif');
    expect(safeImageName('clip.mp4')).toBeNull();
    expect(safeImageName('notes.txt')).toBeNull();
    expect(safeImageName('..png')).toBeNull();
    expect(isStoredName('a.png')).toBe(true);
    for (const bad of ['../a.png', 'sub/a.png', '.hidden.png', 'a b.png', 'a..png', 'a.mp4', '']) expect(isStoredName(bad)).toBe(false);
  });

  it('knows PNG, JPEG, GIF, WebP and AVIF, and nothing else', () => {
    expect(sniffImage(png('x'))).toBe(true);
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(sniffImage(Buffer.from('GIF89a'))).toBe(true);
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(sniffImage(Buffer.from('\0\0\0\x1cftypavif\0\0\0\0'))).toBe(true);
    expect(sniffImage(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0'))).toBe(false);
    expect(sniffImage(Buffer.from('#EXTM3U\n'))).toBe(false);
  });
});

describe('PUT /api/agent/image', () => {
  it('stores a picture under public/refs with a sanitised name', async () => {
    const r = await put('../../My Ref!.png', png('bytes'));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ file: 'My-Ref.png', src: 'public/refs/My-Ref.png' });
    expect(readFileSync(join(refs(), 'My-Ref.png'))).toEqual(png('bytes'));
    expect(existsSync(join(projectDir, 'My-Ref.png'))).toBe(false);
    expect(existsSync(join(projectDir, '..', 'My-Ref.png'))).toBe(false);
  });

  it('gives a clash -2 and never overwrites', async () => {
    await put('same.png', png('one'));
    const r = await put('same.png', png('two'));
    expect(((await r.json()) as { file: string }).file).toBe('same-2.png');
    expect(readFileSync(join(refs(), 'same.png'))).toEqual(png('one'));
  });

  it('takes an AVIF and a JPEG', async () => {
    expect((await put('a.avif', Buffer.from('\0\0\0\x1cftypavif\0\0\0\0'))).status).toBe(201);
    expect((await put('b.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).status).toBe(201);
  });

  it('needs the window token', async () => {
    const r = await put('nope.png', png('x'), 'agent');
    expect(r.status).toBe(403);
    expect(existsSync(join(refs(), 'nope.png'))).toBe(false);
  });

  it('refuses a name that is not a picture, a file that is not what its name says, and an empty file', async () => {
    const before = readdirSync(refs()).sort();
    expect((await put('run.sh', png('x'))).status).toBe(400);
    expect((await put('clip.mp4', png('x'))).status).toBe(400);
    expect((await put('..', png('x'))).status).toBe(400);
    expect((await put('fake.png', '#EXTM3U\n')).status).toBe(400);
    expect((await put('video.png', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom0000')]))).status).toBe(400);
    expect((await put('empty.png', '')).status).toBe(400);
    expect(readdirSync(refs()).sort()).toEqual(before);
  });

  it('does not write through a link at the target or its .part', async () => {
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'untouched');
    for (const link of ['linked.png', 'linked.png.part']) symlinkSync(victim, join(refs(), link));
    const r = await put('linked.png', png('new'));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { file: string }).file).toBe('linked-2.png');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    symlinkSync(join(outside, 'nowhere'), join(refs(), 'dangling.png'));
    expect(((await (await put('dangling.png', png('new'))).json()) as { file: string }).file).toBe('dangling-2.png');
    expect(existsSync(join(outside, 'nowhere'))).toBe(false);
  });

  it('refuses when public/refs, or public, is a link out of the project', async () => {
    for (const where of ['refs', 'public']) {
      const other = tempDir();
      const target = tempDir();
      if (where === 'refs') {
        mkdirSync(join(other, 'public'));
        symlinkSync(target, join(other, 'public', 'refs'));
      } else {
        symlinkSync(target, join(other, 'public'));
      }
      const saved = projectDir;
      projectDir = other;
      try {
        expect((await put('out.png', png('x'))).status).toBe(403);
        expect(readdirSync(target).filter((f) => f !== 'refs')).toEqual([]);
        if (where === 'refs') expect(readdirSync(target)).toEqual([]);
        expect((await fetch(`${base}/api/agent/image?token=window&name=out.png`)).status).toBe(404);
      } finally {
        projectDir = saved;
      }
    }
  });

  it('refuses a picture over 20 MB from its Content-Length, writing nothing', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/agent/image?token=window&name=big.png`, { method: 'PUT', headers: { 'Content-Length': String(21 * 1024 * 1024) } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve(413) : reject(e)));
      req.write('x');
    });
    expect(status).toBe(413);
    expect(existsSync(join(refs(), 'big.png'))).toBe(false);
  });
});

describe('GET /api/agent/image', () => {
  it('serves a stored picture with the window token only', async () => {
    const ok = await fetch(`${base}/api/agent/image?token=window&name=My-Ref.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png('bytes'));
    expect((await fetch(`${base}/api/agent/image?token=agent&name=My-Ref.png`)).status).toBe(403);
    expect((await fetch(`${base}/api/agent/image?token=window&name=missing.png`)).status).toBe(404);
  });

  it('does not serve a link, even one that points at a picture outside the project', async () => {
    symlinkSync(join(outside, 'secret.png'), join(refs(), 'leak.png'));
    const r = await fetch(`${base}/api/agent/image?token=window&name=leak.png`);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('secret');
    rmSync(join(refs(), 'leak.png'));
  });

  it('refuses a name that is a path', async () => {
    for (const name of ['../secret.png', 'sub/x.png', '/etc/passwd', '..%2f..%2fx.png']) {
      expect((await fetch(`${base}/api/agent/image?token=window&name=${encodeURIComponent(name)}`)).status).toBe(400);
    }
  });
});

describe('missingImages', () => {
  it('lists names that are not plain pictures in public/refs', () => {
    expect(missingImages(projectDir, ['My-Ref.png', 'nope.png', '../x.png', 'dangling.png', 'linked.png'])).toEqual(['nope.png', '../x.png', 'dangling.png', 'linked.png']);
    expect(missingImages(tempDir(), ['a.png'])).toEqual(['a.png']);
  });
});
