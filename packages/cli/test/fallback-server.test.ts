import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Native } from '../src/native.js';
import { decodePng } from '../src/png.js';
import { pageHtml, startFrameServer, type FrameServer } from '../src/fallback/server.js';

interface Calls {
  videoFrame: { file: string; time: number }[];
  layout: unknown[];
}

let dir: string;
let outside: string;
let server: FrameServer;
let calls: Calls;
let registered: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kinetograph-server-'));
  outside = mkdtempSync(join(tmpdir(), 'kinetograph-outside-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'a.png'), 'png bytes');
  writeFileSync(join(dir, 'logo.svg'), '<svg/>');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  writeFileSync(join(outside, 'Font.ttf'), 'font bytes');
  calls = { videoFrame: [], layout: [] };
  registered = { Inter: join(outside, 'Font.ttf') };
  const native = {
    probeMedia: () => ({ kind: 'video', width: 2, height: 2, durationInSeconds: 2, fps: 30, frames: 60, hasAudio: false }),
    videoFrame: (file: string, time: number) => {
      calls.videoFrame.push({ file, time });
      return { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]) };
    },
    layoutText: (request: { fonts: Record<string, string> }) => {
      calls.layout.push(request);
      return { width: 10, height: 20, lines: [], glyphs: [] };
    },
  } as unknown as Native;
  server = await startFrameServer({
    bundle: 'console.log("bundle")',
    settings: { cwd: dir, publicDir: join(dir, 'public') },
    baseDir: dir,
    roots: [dir],
    native,
    fonts: () => registered,
  });
});
afterEach(async () => {
  await server.close();
});

const get = (path: string) => fetch(`${server.origin}${path}`);

describe('the driver\'s server', () => {
  it('serves the page and the bundle on the loopback only', async () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await get('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('id="kg-stage"');
    expect(html).toContain('src="/bundle.js"');
    expect(html).toContain(`"publicDir":${JSON.stringify(join(dir, 'public'))}`);
    expect(await (await get('/bundle.js')).text()).toBe('console.log("bundle")');
  });

  it('keeps `</script>` out of the settings', () => {
    expect(pageHtml({ cwd: '</script><script>alert(1)', publicDir: '/p' })).not.toContain('</script><script>alert');
  });

  it('serves a project file by path, relative to the project or its public folder, or by absolute path', async () => {
    expect(await (await get(`/@file?path=${encodeURIComponent('logo.svg')}`)).text()).toBe('<svg/>');
    const viaPublic = await get(`/@file?path=${encodeURIComponent('a.png')}`);
    expect(viaPublic.headers.get('content-type')).toBe('image/png');
    expect(await viaPublic.text()).toBe('png bytes');
    // A DOM <img src={staticFile('a.png')}> asks for the absolute path.
    expect(await (await get(join(dir, 'public', 'a.png'))).text()).toBe('png bytes');
  });

  it('refuses files outside the project and says so', async () => {
    for (const path of [join(outside, 'secret.txt'), '../' + outside.split('/').pop() + '/secret.txt']) {
      const res = await get(`/@file?path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    }
    expect((await get('/@file?path=missing.png')).status).toBe(404);
  });

  it('serves the registered fonts, and only those', async () => {
    const url = server.fontUrl(registered.Inter!);
    expect(url).toBe('/@font/0');
    expect(server.fontUrl(registered.Inter!)).toBe(url);
    expect(await (await get(url)).text()).toBe('font bytes');
    expect((await get('/@font/7')).status).toBe(404);
  });

  it('decodes the picture of a video at the time the rules give, and returns it as a PNG', async () => {
    const query = new URLSearchParams({ src: 'clip.mp4', n: '15', fps: '30', trimBefore: '0', loop: '0' });
    const res = await get(`/@video?${query}`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(calls.videoFrame).toEqual([{ file: join(dir, 'clip.mp4'), time: 0.5 }]);
    const picture = decodePng(new Uint8Array(await res.arrayBuffer()));
    expect([picture.width, picture.height]).toEqual([2, 1]);
    expect(Array.from(picture.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
    // A looping clip wraps (a 2 s file at 30 fps is 60 frames); trimAfter ends it.
    await get(`/@video?${new URLSearchParams({ src: 'clip.mp4', n: '75', fps: '30', trimBefore: '0', loop: '1' })}`);
    expect(calls.videoFrame[1]!.time).toBe(0.5);
  });

  it('decodes the picture of a GIF at its time, wrapped when it loops', async () => {
    await get(`/@gif?${new URLSearchParams({ src: 'spin.gif', time: '4.5', loop: '1' })}`);
    await get(`/@gif?${new URLSearchParams({ src: 'spin.gif', time: '4.5', loop: '0' })}`);
    expect(calls.videoFrame.map((c) => c.time)).toEqual([0.5, 4.5]);
  });

  it('refuses bad arguments with a code and a message', async () => {
    const res = await get('/@video?src=clip.mp4&fps=30');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({ code: 'INVALID_ARG', message: 'missing n' });
  });

  it('answers the page\'s synchronous calls: a media header, and text layout with the Node side\'s fonts', async () => {
    const probe = await (await get(`/@probe?src=${encodeURIComponent('clip.mp4')}`)).json();
    expect(probe).toMatchObject({ kind: 'video', durationInSeconds: 2 });
    const reply = await fetch(`${server.origin}/@layout`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hi', font: 'Inter', size: 20, fonts: { Other: '/x.ttf' } }),
    });
    expect(await reply.json()).toMatchObject({ width: 10, height: 20 });
    // The fonts the page knew and the ones registered on the Node side (a downloaded Google font) are both there.
    expect((calls.layout[0] as { fonts: object }).fonts).toEqual({ Other: '/x.ttf', Inter: registered.Inter });
    expect((calls.layout[0] as { baseDir: string }).baseDir).toBe(dir);
  });

  it('refuses what it does not serve', async () => {
    expect((await fetch(`${server.origin}/bundle.js`, { method: 'DELETE' })).status).toBe(405);
  });
});
