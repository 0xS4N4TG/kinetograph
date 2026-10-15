import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { LABEL_FONT_PATH } from '../src/scenes.js';
import { decodePng } from '../src/png.js';
import { fakeNative, type Calls } from './helpers.js';

// `openSource` and the Chrome driver are the two seams to things that need a real bundle and a real browser.
const seam = vi.hoisted(() => ({
  source: undefined as undefined | (() => unknown),
  chromeFrames: [] as number[],
  chromeOptions: [] as object[],
  chromeClosed: 0,
}));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.source?.() ?? actual.openSource(entry, options) };
});
vi.mock('../src/fallback/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fallback/index.js')>();
  return {
    ...actual,
    openChromeRenderer: async (source: Source, options: { scale?: number }) => {
      seam.chromeOptions.push(options);
      return {
        frame: async (frame: number) => {
          seam.chromeFrames.push(frame);
          const { width, height } = source.composition;
          const w = Math.round(width * (options.scale ?? 1));
          const h = Math.round(height * (options.scale ?? 1));
          const data = Buffer.alloc(w * h * 4);
          for (let i = 0; i < w * h; i++) data.set([200, frame, 0, 255], i * 4);
          return { width: w, height: h, data };
        },
        close: async () => {
          seam.chromeClosed++;
        },
      };
    },
  };
});

let calls: Calls;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-compat-cli-'));

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

const issue: Unsupported = { path: '$0 <div>', element: 'div', property: 'filter', value: 'url(#x)', reason: 'an SVG filter is not supported' };

/** A project whose frames in `chrome` hold something native cannot draw. */
function project(chrome: number[]): Source {
  const dir = scratch();
  return {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: {} },
    async frame(frame) {
      const scene: SceneJson = {
        width: 64, height: 36, fps: 30, durationInFrames: 90, background: '#000', fonts: { 'DM Sans': LABEL_FONT_PATH },
        layers: [{ id: `frame-${frame}`, type: 'shape', shape: { kind: 'rect', width: 8, height: 8 }, fill: '#fff' }],
      };
      return { sceneJson: JSON.stringify(scene), audio: [], unsupported: chrome.includes(frame) ? [issue] : [], jsMs: 1, stringifyMs: 0 };
    },
    dispose() {},
  };
}

beforeEach(() => {
  const fake = fakeNative();
  calls = fake.calls;
  setNativeForTests(fake.native);
  seam.source = undefined;
  seam.chromeFrames = [];
  seam.chromeOptions = [];
  seam.chromeClosed = 0;
});

describe('still --compat', () => {
  it('draws a frame natively when it holds nothing unsupported, and in Chrome when it does', async () => {
    seam.source = () => project([7]);
    const native = await cli('still', 'index.tsx', '3', '-o', join(scratch(), 'a.png'), '--json');
    expect(native.json).toMatchObject({ frame: 3, drawnBy: 'native', compat: { nativeFrames: 1, chromeFrames: 0 } });
    expect(calls.still.map((c) => c.frame)).toEqual([3]);
    expect(seam.chromeFrames).toEqual([]);

    const output = join(scratch(), 'b.png');
    const chrome = await cli('still', 'index.tsx', '7', '-o', output, '--json');
    expect(chrome.code).toBe(0);
    expect(chrome.json).toMatchObject({ frame: 7, drawnBy: 'chrome', compat: { mode: 'auto', nativeFrames: 0, chromeFrames: 1 } });
    // The addon was not asked for it; the PNG is Chrome's picture.
    expect(calls.still.map((c) => c.frame)).toEqual([3]);
    const picture = decodePng(readFileSync(output));
    expect([picture.width, picture.height]).toEqual([64, 36]);
    expect(Array.from(picture.data.subarray(0, 4))).toEqual([200, 7, 0, 255]);
    expect(seam.chromeClosed).toBe(1);
  });

  it('--compat chrome draws any frame in Chrome and never opens the GPU', async () => {
    seam.source = () => project([]);
    const r = await cli('still', 'index.tsx', '3', '-o', join(scratch(), 'c.png'), '--compat', 'chrome', '--json');
    expect(r.json.drawnBy).toBe('chrome');
    expect(calls.still).toHaveLength(0);
  });

  it('--compat native draws natively and lists what it left out on stderr', async () => {
    seam.source = () => project([7]);
    const r = await cli('still', 'index.tsx', '7', '-o', join(scratch(), 'd.png'), '--compat', 'native');
    expect(r.code).toBe(0);
    expect(calls.still.map((c) => c.frame)).toEqual([7]);
    expect(seam.chromeFrames).toEqual([]);
    expect(r.err).toContain('--compat native');
    expect(r.err).toContain('div { filter: url(#x) }: an SVG filter is not supported (frame 7)');
  });

  it('rejects another mode', async () => {
    seam.source = () => project([]);
    const r = await cli('still', 'index.tsx', '3', '-o', join(scratch(), 'e.png'), '--compat', 'both', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error).toMatchObject({ code: 'INVALID_ARG', message: expect.stringContaining('--compat must be auto, native or chrome') });
  });

  it('does not take a .json scene to Chrome', async () => {
    const file = join(scratch(), 'scene.json');
    writeFileSync(file, JSON.stringify({ width: 64, height: 36, fps: 30, durationInFrames: 9, layers: [] }));
    const r = await cli('still', file, '3', '-o', join(scratch(), 'f.png'), '--json');
    expect(r.json.drawnBy).toBe('native');
    expect(seam.chromeFrames).toEqual([]);
  });
});

describe('strip --compat', () => {
  it('draws each sampled frame the way it needs, and builds the sheet from all of them', async () => {
    seam.source = () => project([30]);
    const output = join(scratch(), 'sheet.png');
    const r = await cli('strip', 'index.tsx', '-n', '4', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(r.json.frames).toEqual([0, 30, 59, 89]);
    expect(r.json.compat).toMatchObject({ nativeFrames: 3, chromeFrames: 1 });
    // The native frames, then the sheet; frame 30 came from Chrome.
    expect(calls.still.map((c) => c.frame)).toEqual([0, 59, 89, 0]);
    expect(seam.chromeFrames).toEqual([30]);
    const sheet = calls.still[3]!.scene as SceneJson;
    expect(sheet.layers.filter((l) => l.type === 'image')).toHaveLength(4);
    expect(seam.chromeClosed).toBe(1);
  });
});

describe('render --compat', () => {
  it('splits the frames and says how many went each way', async () => {
    seam.source = () => project([2, 3]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..6');
    expect(r.code).toBe(0);
    expect(calls.order).toEqual(['native 0', 'native 1', 'raw 2', 'raw 3', 'native 4', 'native 5']);
    expect(r.text).toContain('4 native, 2 in Chrome (frames 2..=3)');
  });

  it('puts the split in the JSON result', async () => {
    seam.source = () => project([2, 3]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..6', '--json');
    expect(r.json.compat).toMatchObject({
      mode: 'auto',
      nativeFrames: 4,
      chromeFrames: 2,
      runs: [
        { first: 0, last: 1, path: 'native' },
        { first: 2, last: 3, path: 'chrome' },
        { first: 4, last: 5, path: 'native' },
      ],
    });
  });

  it('says nothing about Chrome for a project that needed none', async () => {
    seam.source = () => project([]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..3');
    expect(r.text).not.toContain('Chrome');
    expect(seam.chromeOptions).toEqual([]);
  });

  it('--compat native lists what it left out on stderr, and --json keeps it in the result', async () => {
    seam.source = () => project([1, 2]);
    const text = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..4', '--compat', 'native');
    expect(text.err).toContain('--compat native: 1 kind of unsupported content left out of the frames:');
    expect(text.err).toContain('(2 frames, 1..=2)');
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1, 2, 3]);
    const json = await cli('render', 'index.tsx', '-o', join(scratch(), 'q.mp4'), '--range', '0..4', '--compat', 'native', '--json');
    expect(json.json.compat.leftOut).toHaveLength(1);
  });

  it('--compat chrome draws every frame in Chrome, at half size for --draft', async () => {
    seam.source = () => project([]);
    await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..3', '--compat', 'chrome', '--draft', '--json');
    expect(calls.order).toEqual(['raw 0', 'raw 1', 'raw 2']);
    expect(seam.chromeOptions).toEqual([expect.objectContaining({ scale: 0.5 })]);
    expect(calls.pushedRaw[0]).toMatchObject({ width: 32, height: 18 });
  });

  it('is an option of the commands that draw frames, and the MCP tools see it', async () => {
    const { toolCommands, inputShape } = await import('../src/mcp.js');
    for (const name of ['still', 'render', 'strip']) {
      const command = toolCommands().find((c) => c.name === name)!;
      expect(Object.keys(inputShape(command)), name).toContain('compat');
    }
    const onion = toolCommands().find((c) => c.name === 'onion')!;
    expect(Object.keys(inputShape(onion))).not.toContain('compat');
  });
});
