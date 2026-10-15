import { describe, expect, it } from 'vitest';
import type { Renderer } from '@kinetograph/native';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import type { ChromeFrame, ChromeOptions, ChromeRenderer } from '../src/fallback/index.js';
import { fitFrame, renderSource, type RenderJobOptions } from '../src/render-job.js';
import type { Source } from '../src/source.js';
import { fakeNative } from './helpers.js';

const issue: Unsupported = { path: '$0.1 <div>', element: 'div', property: 'transform', value: 'skewX(10deg)', reason: 'skew is not supported' };

/** A project whose frames in `chrome` hold something the native path cannot draw. */
function project(chrome: number[], extra: Partial<Source> = {}): Source {
  return {
    kind: 'project',
    entry: '/work/index.tsx',
    baseDir: '/work',
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 12, defaultProps: {} },
    async frame(frame) {
      const scene: SceneJson = { width: 64, height: 36, fps: 30, durationInFrames: 12, background: '#000', layers: [{ id: `f${frame}`, type: 'group', children: [] }] };
      return { sceneJson: JSON.stringify(scene), audio: [], unsupported: chrome.includes(frame) ? [issue] : [], jsMs: 1, stringifyMs: 0 };
    },
    dispose() {},
    ...extra,
  };
}

interface ChromeLog {
  opened: { source: Source; options: ChromeOptions }[];
  frames: number[];
  closed: number;
}

/** A stand-in for the driver: `width` x `height` pictures whose first byte is the frame number. */
function fakeChrome(size = { width: 64, height: 36 }, log: ChromeLog = { opened: [], frames: [], closed: 0 }) {
  const openChrome: NonNullable<RenderJobOptions['openChrome']> = async (source, options) => {
    log.opened.push({ source, options });
    const renderer: ChromeRenderer = {
      async frame(frame): Promise<ChromeFrame> {
        log.frames.push(frame);
        const data = Buffer.alloc(size.width * size.height * 4);
        data[0] = frame;
        return { ...size, data };
      },
      async close() {
        log.closed++;
      },
    };
    return renderer;
  };
  return { openChrome, log };
}

function setup() {
  const { native, calls } = fakeNative();
  return { renderer: new native.Renderer() as unknown as Renderer, calls };
}

describe('renderSource with Chrome frames', () => {
  it('feeds native and Chrome frames into one writer in frame order', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    const result = await renderSource(project([3, 4, 8]), renderer, { output: 'out.mp4', range: '0..10', openChrome });
    // 0..10 is frames 0 to 9.
    expect(calls.order).toEqual([
      'native 0', 'native 1', 'native 2', 'raw 3', 'raw 4', 'native 5', 'native 6', 'native 7', 'raw 8', 'native 9',
    ]);
    expect(calls.pushedRaw.map((p) => [p.frame, p.width, p.height, p.bytes])).toEqual([
      [3, 64, 36, 64 * 36 * 4], [4, 64, 36, 64 * 36 * 4], [8, 64, 36, 64 * 36 * 4],
    ]);
    expect(log.frames).toEqual([3, 4, 8]);
    expect(calls.begun).toHaveLength(1);
    expect(calls.finished).toHaveLength(1);
    expect(calls.aborted).toBe(0);
    // The summary says how many went each way, and in which runs.
    expect(result.compat).toMatchObject({ mode: 'auto', nativeFrames: 7, chromeFrames: 3, leftOut: [] });
    expect(result.compat.runs).toEqual([
      { first: 0, last: 2, path: 'native' },
      { first: 3, last: 4, path: 'chrome' },
      { first: 5, last: 7, path: 'native' },
      { first: 8, last: 8, path: 'chrome' },
      { first: 9, last: 9, path: 'native' },
    ]);
  });

  it('starts Chrome once, on the first frame that needs it, and closes it', async () => {
    const { renderer } = setup();
    const { openChrome, log } = fakeChrome();
    await renderSource(project([6, 7]), renderer, { output: 'out.mp4', openChrome });
    expect(log.opened).toHaveLength(1);
    expect(log.opened[0]!.options.scale).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('never starts Chrome for a project that needs none', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    const result = await renderSource(project([]), renderer, { output: 'out.mp4', openChrome });
    expect(log.opened).toHaveLength(0);
    expect(calls.pushedRaw).toHaveLength(0);
    expect(calls.pushed).toHaveLength(12);
    expect(result.compat).toMatchObject({ nativeFrames: 12, chromeFrames: 0, runs: [{ first: 0, last: 11, path: 'native' }] });
  });

  it('draws every frame in Chrome with --compat chrome, native or not', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    const result = await renderSource(project([2]), renderer, { output: 'out.mp4', range: '0..4', compat: 'chrome', openChrome });
    expect(calls.pushed).toHaveLength(0);
    expect(calls.order).toEqual(['raw 0', 'raw 1', 'raw 2', 'raw 3']);
    expect(log.frames).toEqual([0, 1, 2, 3]);
    expect(result.compat).toMatchObject({ mode: 'chrome', nativeFrames: 0, chromeFrames: 4 });
  });

  it('draws every frame natively with --compat native and reports what it left out', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    const result = await renderSource(project([2, 3]), renderer, { output: 'out.mp4', range: '0..5', compat: 'native', openChrome });
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(log.opened).toHaveLength(0);
    expect(result.compat).toMatchObject({ mode: 'native', nativeFrames: 5, chromeFrames: 0 });
    expect(result.compat.leftOut).toEqual([
      { element: 'div', property: 'transform', reason: 'skew is not supported', values: ['skewX(10deg)'], frames: 2, firstFrame: 2, lastFrame: 3 },
    ]);
  });

  it('halves Chrome\'s scale for --draft and crops its picture to the writer\'s size', async () => {
    const { renderer, calls } = setup();
    // 64x36 is 32x18 as a draft; a Chrome that rounded the other way gives 33x19.
    const { openChrome, log } = fakeChrome({ width: 33, height: 19 });
    await renderSource(project([1]), renderer, { output: 'out.mp4', range: '0..3', draft: true, openChrome });
    expect(log.opened[0]!.options.scale).toBe(0.5);
    expect(calls.begun[0]!.options).toMatchObject({ width: 32, height: 18 });
    expect(calls.pushedRaw).toEqual([{ frame: 1, width: 32, height: 18, bytes: 32 * 18 * 4 }]);
  });

  it('aborts the video and closes Chrome when a Chrome frame fails', async () => {
    const { renderer, calls } = setup();
    const log: ChromeLog = { opened: [], frames: [], closed: 0 };
    const openChrome: NonNullable<RenderJobOptions['openChrome']> = async () => ({
      frame: async () => {
        throw new Error('Chrome could not draw frame 3');
      },
      close: async () => {
        log.closed++;
      },
    });
    await expect(renderSource(project([3]), renderer, { output: 'out.mp4', openChrome })).rejects.toThrow('could not draw frame 3');
    expect(calls.aborted).toBe(1);
    expect(calls.finished).toHaveLength(0);
    expect(log.closed).toBe(1);
  });

  it('cancels between frames and still closes Chrome', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    let seen = 0;
    await expect(
      renderSource(project([0, 1, 2, 3]), renderer, { output: 'out.mp4', openChrome, shouldCancel: () => ++seen > 2 }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls.order).toEqual(['raw 0', 'raw 1']);
    expect(calls.aborted).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('leaves a .json scene to the addon whole, whatever --compat says', async () => {
    const { renderer, calls } = setup();
    const { openChrome, log } = fakeChrome();
    const scene = project([], { kind: 'scene' });
    const result = await renderSource(scene, renderer, { output: 'out.mp4', compat: 'chrome', openChrome });
    expect(calls.render).toHaveLength(1);
    expect(log.opened).toHaveLength(0);
    expect(result.compat.chromeFrames).toBe(0);
  });
});

describe('fitFrame', () => {
  it('keeps a picture of the right size, crops a larger one and refuses a smaller one', () => {
    const picture = (width: number, height: number): ChromeFrame => {
      const data = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) data[i * 4] = i % 251;
      return { width, height, data };
    };
    const same = picture(4, 2);
    expect(fitFrame(same, 4, 2)).toBe(same);
    const cropped = fitFrame(picture(5, 3), 4, 2);
    expect([cropped.width, cropped.height, cropped.data.length]).toEqual([4, 2, 32]);
    // Row 1 of the crop is row 1 of the original, from its left edge.
    expect(cropped.data[4 * 4]).toBe(5);
    expect(() => fitFrame(picture(3, 2), 4, 2)).toThrow(/Chrome drew 3x2/);
  });
});
