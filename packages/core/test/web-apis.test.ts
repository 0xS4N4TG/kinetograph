// The browser globals a project commonly touches (packages/cli/skills/kinetograph/references/ENGINE.md §10): sizes, matchMedia, Image, fetch of project files,
// canvas, requestAnimationFrame on the frame clock, and the rule that nothing here looks at a wall clock or the network.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetStylesheets, setDomEnvironment } from '@kinetographdev/compat/dom';
import { setWebViewport } from '@kinetographdev/compat/shim';
import { getFonts } from '../src/font-registry.js';
import { installDeterminism, resetVirtualClock, setVirtualFrame } from '../src/determinism.js';
import '../src/web-install.js';
import { registerStylesheet } from '@kinetographdev/compat/dom';
import { staticFile } from '../src/assets.js';

const g = globalThis as any;

/** A PNG header of `w` x `h` (enough for the size; not a picture). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

let dir: string;
beforeAll(() => {
  installDeterminism();
  dir = mkdtempSync(join(tmpdir(), 'kg-web-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'pic.png'), png(7, 5));
  writeFileSync(join(dir, 'public', 'data.json'), JSON.stringify({ a: 1 }));
  writeFileSync(join(dir, 'broken.png'), 'not an image');
  setDomEnvironment({ baseDir: dir, publicDir: join(dir, 'public') });
  process.env.KINETOGRAPH_PUBLIC_DIR = join(dir, 'public');
  setWebViewport({ width: 1080, height: 1920 });
});

describe('window and matchMedia', () => {
  it('report the composition’s size and a 1x screen', () => {
    expect([g.innerWidth, g.innerHeight, g.devicePixelRatio]).toEqual([1080, 1920, 1]);
    expect(g.window).toBe(globalThis);
    expect(g.screen.width).toBe(1080);
    expect(g.document.documentElement.clientHeight).toBe(1920);
  });

  it('evaluate media queries against it', () => {
    const m = (q: string) => g.matchMedia(q).matches;
    expect(m('(min-width: 1000px)')).toBe(true);
    expect(m('(min-width: 1081px)')).toBe(false);
    expect(m('(max-width: 1080px) and (orientation: portrait)')).toBe(true);
    expect(m('(orientation: landscape)')).toBe(false);
    expect(m('screen')).toBe(true);
    expect(m('print')).toBe(false);
    expect(m('not print')).toBe(true);
    expect(m('(prefers-reduced-motion: reduce)')).toBe(false);
    expect(m('(prefers-reduced-motion: no-preference)')).toBe(true);
    expect(m('(prefers-color-scheme: dark)')).toBe(false);
    expect(m('(min-width: 5000px), (max-width: 2000px)')).toBe(true);
    expect(g.matchMedia('(min-width: 10px)').media).toBe('(min-width: 10px)');
  });

  it('follow the viewport', () => {
    setWebViewport({ width: 500, height: 400 });
    expect(g.innerWidth).toBe(500);
    expect(g.matchMedia('(orientation: landscape)').matches).toBe(true);
    setWebViewport({ width: 1080, height: 1920 });
  });
});

describe('new Image()', () => {
  it('loads a project file: naturalWidth, onload and decode()', async () => {
    const img = new g.Image();
    const loaded = new Promise<void>((resolve) => (img.onload = () => resolve()));
    img.src = staticFile('pic.png');
    expect(img.complete).toBe(false);
    await loaded;
    expect([img.naturalWidth, img.naturalHeight, img.width, img.height, img.complete]).toEqual([7, 5, 7, 5, true]);
    const again = new g.Image();
    again.src = 'pic.png';
    await again.decode();
    expect(again.naturalWidth).toBe(7);
  });

  it('fires error with a message for a missing file, a remote URL and a non-image', async () => {
    const fail = (src: string) =>
      new Promise<string>((resolve) => {
        const img = new g.Image();
        img.onerror = (e: any) => resolve(e.message);
        img.src = src;
      });
    expect(await fail('nothing.png')).toContain('no such file in the project');
    expect(await fail('https://example.com/a.png')).toContain('remote URLs are not available');
    expect(await fail(join(dir, 'broken.png'))).toContain('not an image');
    const img = new g.Image();
    img.src = 'nothing.png';
    await expect(img.decode()).rejects.toThrow('no such file');
  });

  it('reads the size of a data: URL and of an in-memory blob', async () => {
    const data = new g.Image();
    data.src = `data:image/png;base64,${png(3, 9).toString('base64')}`;
    await data.decode();
    expect([data.naturalWidth, data.naturalHeight]).toEqual([3, 9]);
    const blob = new Blob([png(11, 13)], { type: 'image/png' });
    const viaBlob = new g.Image();
    viaBlob.src = URL.createObjectURL(blob);
    await viaBlob.decode();
    expect([viaBlob.naturalWidth, viaBlob.naturalHeight]).toEqual([11, 13]);
  });
});

describe('fetch', () => {
  it('reads project files, from staticFile(), relative paths and the public folder', async () => {
    expect(await (await fetch(staticFile('data.json'))).json()).toEqual({ a: 1 });
    expect(await (await fetch('data.json')).json()).toEqual({ a: 1 });
    expect(await (await fetch('/data.json')).json()).toEqual({ a: 1 });
    expect((await fetch('data.json')).headers.get('content-type')).toBe('application/json');
  });

  it('refuses remote URLs with a message that says why, and missing files', async () => {
    await expect(fetch('https://api.example.com/x')).rejects.toThrow(/remote URLs are not available: Kinetograph renders offline/);
    await expect(fetch('missing.json')).rejects.toThrow('no such file in the project');
    // data: and blob: stay what they are.
    expect(await (await fetch('data:text/plain,hi')).text()).toBe('hi');
  });
});

describe('canvas and the clock', () => {
  it('document.createElement("canvas") is a 300 x 150 canvas with a 2D context that records', () => {
    const canvas = g.document.createElement('canvas');
    expect([canvas.width, canvas.height, canvas.tagName]).toEqual([300, 150, 'CANVAS']);
    const ctx = canvas.getContext('2d');
    expect(canvas.getContext('2d')).toBe(ctx);
    expect(ctx.canvas).toBe(canvas.getContext('2d').canvas);
    ctx.fillStyle = '#336699';
    ctx.fillRect(1, 2, 3, 4);
    expect(ctx.commands).toEqual([{ op: 'fill', path: 'M1 2L4 2L4 6L1 6Z', paint: { type: 'color', color: '#336699' } }]);
    // A new width empties the canvas and puts the state back.
    canvas.width = 50;
    expect([canvas.width, ctx.commands.length, ctx.fillStyle]).toEqual([50, 0, '#000000']);
    expect(g.document.createElement('div').tagName).toBe('DIV');
  });

  it('draws one canvas onto another as the commands it holds, an OffscreenCanvas too', () => {
    const source = new g.OffscreenCanvas(10, 8);
    source.getContext('2d').fillRect(0, 0, 4, 4);
    const target = g.document.createElement('canvas');
    target.getContext('2d').drawImage(source, 5, 6);
    expect(target.getContext('2d').commands).toMatchObject([
      { op: 'image', dx: 5, dy: 6, dw: 10, dh: 8, source: { kind: 'canvas', width: 10, height: 8, commands: [{ op: 'fill' }] } },
    ]);
  });

  it('draws a project image by its file, and refuses one it cannot read', () => {
    const image = new g.Image();
    image.src = 'pic.png';
    const ctx = g.document.createElement('canvas').getContext('2d');
    ctx.drawImage(image, 1, 1);
    expect(ctx.commands).toMatchObject([{ op: 'image', source: { kind: 'src', src: join(dir, 'public', 'pic.png') }, dw: 7, dh: 5 }]);
    expect(() => ctx.drawImage(new g.Image(), 0, 0)).toThrow(/not a picture/);
  });

  it('has WebGL contexts that record, one kind of context to a canvas, and WebGPU contexts that record too', () => {
    const canvas = g.document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    expect(gl).toBeInstanceOf(g.WebGLRenderingContext);
    expect(canvas.getContext('webgl')).toBe(gl);
    expect(canvas.getContext('2d')).toBeNull();
    expect(canvas.getContext('bitmaprenderer')).toBeNull();
    const gpuCanvas = g.document.createElement('canvas');
    const gpu = gpuCanvas.getContext('webgpu');
    expect(gpu).not.toBeNull();
    expect(gpuCanvas.getContext('webgpu')).toBe(gpu);
    expect(gpuCanvas.getContext('webgl')).toBeNull();
    expect(canvas.getContext('webgpu')).toBeNull();
    expect(typeof g.navigator.gpu.requestAdapter).toBe('function');
    expect(() => canvas.toDataURL()).toThrow(/^unsupported:/);
  });

  it('has the canvas classes as globals', () => {
    const ctx = g.document.createElement('canvas').getContext('2d');
    expect(ctx).toBeInstanceOf(g.CanvasRenderingContext2D);
    expect(ctx.createLinearGradient(0, 0, 1, 1)).toBeInstanceOf(g.CanvasGradient);
    expect(new g.Path2D('M0 0L1 1')).toBeInstanceOf(g.Path2D);
    expect(new g.ImageData(2, 2).data).toHaveLength(16);
  });

  it('runs requestAnimationFrame once per frame, with the frame time', () => {
    resetVirtualClock();
    const times: number[] = [];
    const loop = (t: number) => {
      times.push(t);
      g.requestAnimationFrame(loop);
    };
    g.requestAnimationFrame(loop);
    setVirtualFrame(1, 30);
    setVirtualFrame(2, 30);
    setVirtualFrame(3, 30);
    expect(times.map((t) => Math.round(t * 100) / 100)).toEqual([33.33, 66.67, 100]);
    expect(Date.now() - Date.UTC(2026, 0, 1)).toBe(100);
    expect(performance.now()).toBeCloseTo(100, 3);
    resetVirtualClock();
  });
});

describe('@font-face in a stylesheet', () => {
  it('registers the file with the font registry', () => {
    resetStylesheets();
    writeFileSync(join(dir, 'public', 'Face.ttf'), 'x');
    registerStylesheet(`@font-face { font-family: "My Face"; src: url("/Face.ttf") format("truetype"); font-weight: 700; font-style: italic; }`);
    expect(getFonts()['My Face:700i']).toBe(join(dir, 'public', 'Face.ttf'));
  });
});
