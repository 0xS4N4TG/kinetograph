import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg, safeRefName, sniff } from '../src/panels/brief-routes.js';
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

/** The first bytes of a real PNG, then `text`. */
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

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

describe('sniff', () => {
  it('knows the containers it accepts and nothing else', () => {
    expect(sniff(Buffer.from('\0\0\0\x18ftypmp42'))).toMatchObject({ kind: 'video', demuxer: 'mov' });
    expect(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toMatchObject({ kind: 'video', demuxer: 'matroska' });
    expect(sniff(Buffer.from('RIFF\0\0\0\0AVI LIST'))).toMatchObject({ kind: 'video', demuxer: 'avi' });
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ kind: 'image' });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image' });
    expect(sniff(Buffer.from('GIF89a'))).toEqual({ kind: 'image' });
    expect(sniff(Buffer.from('#EXTM3U\n'))).toBeNull();
    expect(sniff(Buffer.from('ffconcat version 1.0'))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe('PUT /api/panels/brief/ref', () => {
  it('stores an image under plan/refs with a sanitised name', async () => {
    const r = await put('../../My Ref!.png', png('bytes'));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ src: 'plan/refs/My-Ref.png' });
    expect(readFileSync(join(projectDir, 'plan', 'refs', 'My-Ref.png'), 'utf8')).toBe(png('bytes').toString('utf8'));
    expect(existsSync(join(projectDir, 'My-Ref.png'))).toBe(false);
    expect(existsSync(join(projectDir, '..', 'My-Ref.png'))).toBe(false);
  });

  it('does not overwrite: a second file with the same name gets a suffix', async () => {
    await put('same.png', png('one'));
    const r = await put('same.png', png('two'));
    expect(((await r.json()) as { src: string }).src).toBe('plan/refs/same-2.png');
    expect(readFileSync(join(projectDir, 'plan', 'refs', 'same.png'))).toEqual(png('one'));
  });

  it('needs the window token', async () => {
    const r = await put('nope.png', png('x'), 'agent');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(existsSync(join(projectDir, 'plan', 'refs', 'nope.png'))).toBe(false);
  });

  it('refuses a name that is not a video or an image, and an empty file', async () => {
    expect((await put('run.sh', png('x'))).status).toBe(400);
    expect((await put('..', png('x'))).status).toBe(400);
    expect((await put('empty.png', '')).status).toBe(400);
    expect(readdirSync(join(projectDir, 'plan', 'refs')).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('refuses text playlists and files that are not what their name says', async () => {
    const before = readdirSync(join(projectDir, 'plan', 'refs')).sort();
    expect((await put('list.mp4', '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n')).status).toBe(400);
    expect((await put('concat.mov', "ffconcat version 1.0\nfile '/etc/hosts'\n")).status).toBe(400);
    expect((await put('fake.png', '#EXTM3U\n')).status).toBe(400);
    // A real image under a video name, and a video container under an image name.
    expect((await put('image.mp4', png('x'))).status).toBe(400);
    expect((await put('video.png', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom0000')]))).status).toBe(400);
    expect(readdirSync(join(projectDir, 'plan', 'refs')).sort()).toEqual(before);
  });

  it('does not write through a link at the target, its .part or its sheet path', async () => {
    const refs = join(projectDir, 'plan', 'refs');
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'untouched');
    for (const link of ['linked.png', 'linked.png.part', 'linked.png.sheet.png']) symlinkSync(victim, join(refs, link));
    const r = await put('linked.png', png('new'));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { src: string }).src).toBe('plan/refs/linked-2.png');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    // A dangling link counts as taken too.
    symlinkSync(join(outside, 'nowhere'), join(refs, 'dangling.png'));
    expect(((await (await put('dangling.png', png('new'))).json()) as { src: string }).src).toBe('plan/refs/dangling-2.png');
    expect(existsSync(join(outside, 'nowhere'))).toBe(false);
  });

  it('refuses when plan/refs is a link out of the project', async () => {
    const other = tempDir();
    const target = tempDir();
    mkdirSync(join(other, 'plan'));
    symlinkSync(target, join(other, 'plan', 'refs'));
    const saved = projectDir;
    projectDir = other;
    try {
      const r = await put('out.png', png('x'));
      expect(r.status).toBe(403);
      expect(readdirSync(target)).toEqual([]);
      const get = await fetch(`${base}/api/panels/brief/ref?token=window&path=plan/refs/out.png`);
      expect(get.status).toBe(404);
    } finally {
      projectDir = saved;
    }
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
    expect(await ok.text()).toBe(png('bytes').toString('utf8'));
    expect((await fetch(`${base}/api/panels/brief/ref?token=agent&path=plan/refs/My-Ref.png`)).status).toBe(403);
  });

  it('does not serve a link, even one that points at an image outside the project', async () => {
    symlinkSync(join(outside, 'secret.png'), join(projectDir, 'plan', 'refs', 'leak.png'));
    const r = await fetch(`${base}/api/panels/brief/ref?token=window&path=plan/refs/leak.png`);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('secret');
    rmSync(join(projectDir, 'plan', 'refs', 'leak.png'));
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
