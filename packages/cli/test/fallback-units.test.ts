import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Unsupported } from '@kinetograph/scene';
import { LeftOutCollector, describeLeftOut, describeSplit, parseCompat } from '../src/compat-report.js';
import { clipSourceTime, gifSourceTime } from '../src/fallback/clip-time.js';
import { CHROME_VERSION, chromeArgs, findChrome } from '../src/fallback/chrome.js';
import { fontFace, projectRoot } from '../src/fallback/index.js';
import { encodePng } from '../src/fallback/png.js';
import { decodePng } from '../src/png.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-fallback-'));

describe('clipSourceTime (SCENE.md "video", rules 1 to 4)', () => {
  const base = { fps: 30, trimBefore: 0, trimAfter: null, loop: false };

  it('follows the clip frame at the scene frame rate', () => {
    expect(clipSourceTime({ ...base, n: 15 }, 2)).toBe(0.5);
    expect(clipSourceTime({ ...base, n: 14.75 }, 2)).toBe(14.75 / 30);
  });

  it('skips trimBefore frames and ends at trimAfter', () => {
    expect(clipSourceTime({ ...base, n: 0, trimBefore: 15 }, 2)).toBe(0.5);
    expect(clipSourceTime({ ...base, n: 15, trimBefore: 15 }, 2)).toBe(1);
    // Past the clip's end the time stays at the end, nudged back so the last picture *before* it shows.
    const held = clipSourceTime({ ...base, n: 1000, trimBefore: 15, trimAfter: 45 }, 2);
    expect(held).toBeLessThan(1.5);
    expect(held).toBeGreaterThan(1.499);
  });

  it('holds before the start and after the end of the stream when not looping', () => {
    expect(clipSourceTime({ ...base, n: -10 }, 2)).toBe(0);
    const end = clipSourceTime({ ...base, n: 600 }, 2);
    expect(end).toBeGreaterThan(1.999);
    expect(end).toBeLessThan(2);
  });

  it('wraps by modulo when looping, frames before the start included', () => {
    const loop = { ...base, loop: true, trimBefore: 15, trimAfter: 45 };
    expect(clipSourceTime({ ...loop, n: 0 }, 2)).toBe(0.5);
    expect(clipSourceTime({ ...loop, n: 30 }, 2)).toBe(0.5);
    expect(clipSourceTime({ ...loop, n: 45 }, 2)).toBe(1);
    expect(clipSourceTime({ ...base, loop: true, n: -10 }, 2)).toBeCloseTo(50 / 30, 10);
  });

  it('wraps a GIF\'s time round its duration, or leaves it to be held', () => {
    expect(gifSourceTime(1.25, 0.5, true)).toBeCloseTo(0.25, 10);
    expect(gifSourceTime(-0.1, 0.5, true)).toBeCloseTo(0.4, 10);
    expect(gifSourceTime(1.25, 0.5, false)).toBe(1.25);
  });
});

describe('encodePng', () => {
  it('round-trips straight-alpha pixels through the CLI\'s own decoder', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePng(3, 2, rgba);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const back = decodePng(png);
    expect([back.width, back.height]).toEqual([3, 2]);
    expect(Array.from(back.data)).toEqual(Array.from(rgba));
  });

  it('refuses a buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/16 bytes/);
  });
});

describe('fontFace', () => {
  it('declares the family, weight and style a fontKey names', () => {
    expect(fontFace('DM Sans', '/@font/0')).toEqual({
      css: '@font-face { font-family: "DM Sans"; font-weight: 400; font-style: normal; src: url("/@font/0"); }',
      load: 'normal 400 16px "DM Sans"',
    });
    expect(fontFace('Inter:700', '/@font/1').css).toContain('font-family: "Inter"; font-weight: 700; font-style: normal');
    expect(fontFace('Inter:400i', '/@font/2').css).toContain('font-weight: 400; font-style: italic');
    expect(fontFace('Inter:700i', '/@font/2').load).toBe('italic 700 16px "Inter"');
  });

  it('escapes quotes in a family name and keeps a colon that is not a weight', () => {
    expect(fontFace('A "B"', 'x').css).toContain('font-family: "A \\"B\\""');
    expect(fontFace('Odd:Name', 'x').css).toContain('font-family: "Odd:Name"; font-weight: 400');
  });
});

describe('projectRoot', () => {
  it('is the nearest directory above the entry with a package.json, else the entry\'s own', () => {
    const root = scratch();
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    expect(projectRoot(join(root, 'src', 'deep', 'index.tsx'))).toBe(root);
    const loose = scratch();
    expect(projectRoot(join(loose, 'index.tsx'))).toBe(loose);
  });
});

describe('finding Chrome', () => {
  it('uses the executablePath option, then KINETOGRAPH_CHROME', async () => {
    const dir = scratch();
    const exe = join(dir, 'chrome');
    writeFileSync(exe, '');
    expect(await findChrome({ executablePath: exe, env: {} })).toEqual({ executablePath: exe, source: 'option' });
    expect(await findChrome({ env: { KINETOGRAPH_CHROME: exe } })).toEqual({ executablePath: exe, source: 'environment' });
    // The option wins over the environment.
    expect((await findChrome({ executablePath: exe, env: { KINETOGRAPH_CHROME: '/nope' } })).source).toBe('option');
  });

  it('says which setting points at nothing', async () => {
    await expect(findChrome({ env: { KINETOGRAPH_CHROME: '/no/such/chrome' } })).rejects.toMatchObject({
      code: 'CHROME_UNAVAILABLE',
      message: expect.stringContaining('KINETOGRAPH_CHROME is /no/such/chrome'),
    });
    await expect(findChrome({ executablePath: '/no/such/chrome', env: {} })).rejects.toThrow(/executablePath option/);
  });

  it('is pinned to the Chrome for Testing build puppeteer-core is released with', () => {
    expect(CHROME_VERSION).toBe('154.0.8037.57');
  });

  it('runs headless Chrome without the GPU, in sRGB, and without the sandbox only as root', () => {
    const args = chromeArgs({ root: false });
    expect(args).toEqual(expect.arrayContaining(['--disable-gpu', '--force-color-profile=srgb', '--hide-scrollbars']));
    expect(args).not.toContain('--no-sandbox');
    expect(chromeArgs({ root: true })).toContain('--no-sandbox');
  });
});

const issue = (element: string, property: string | null, value: string | null, reason = 'not supported'): Unsupported => ({
  path: '$0 <div>',
  element,
  property,
  value,
  reason,
});

describe('--compat', () => {
  it('is auto, native or chrome', () => {
    expect(parseCompat(undefined)).toBe('auto');
    for (const mode of ['auto', 'native', 'chrome'] as const) expect(parseCompat(mode)).toBe(mode);
    expect(() => parseCompat('both')).toThrowError(/--compat must be auto, native or chrome/);
  });

  it('collects what was left out, one entry per kind, most frames first', () => {
    const collector = new LeftOutCollector();
    for (let frame = 10; frame < 14; frame++) {
      // The same thing twice in a frame counts the frame once.
      collector.add(frame, [
        issue('div', 'transform', 'skewX(5deg)', 'skew'),
        issue('div', 'transform', 'skewX(5deg)', 'skew'),
        ...(frame === 12 ? [issue('canvas', null, null, 'not drawn natively'), issue('div', 'transform', 'skewY(9deg)', 'skew')] : []),
      ]);
    }
    const result = collector.result();
    expect(result).toEqual([
      { element: 'div', property: 'transform', reason: 'skew', values: ['skewX(5deg)', 'skewY(9deg)'], frames: 4, firstFrame: 10, lastFrame: 13 },
      { element: 'canvas', property: null, reason: 'not drawn natively', values: [], frames: 1, firstFrame: 12, lastFrame: 12 },
    ]);
    const lines = describeLeftOut(result);
    expect(lines[0]).toMatch(/2 kinds/);
    expect(lines[1]).toBe('  div { transform: skewX(5deg) | skewY(9deg) }: skew (4 frames, 10..=13)');
    expect(lines[2]).toBe('  canvas: not drawn natively (frame 12)');
    expect(describeLeftOut([])).toEqual([]);
  });

  it('says how many frames went each way', () => {
    expect(
      describeSplit({
        nativeFrames: 5,
        chromeFrames: 3,
        runs: [
          { first: 0, last: 1, path: 'native' },
          { first: 2, last: 2, path: 'chrome' },
          { first: 3, last: 5, path: 'native' },
        ],
      }),
    ).toBe('5 native, 3 in Chrome (frames 2)');
    expect(describeSplit({ nativeFrames: 4, chromeFrames: 0, runs: [{ first: 0, last: 3, path: 'native' }] })).toBe('4 native, 0 in Chrome');
  });
});
