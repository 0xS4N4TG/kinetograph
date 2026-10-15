import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '@kinetograph/compat/doctor';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import { compareFrames, diffRgba, formatReport } from '../src/commands/doctor.js';
import type { ChromeFrame, ChromeRenderer } from '../src/fallback/index.js';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { fakeNative } from './helpers.js';

// As in commands.test.ts: `openSource` is the seam to a project's bundle, and now `openChromeRenderer` is the seam
// to Chrome. Neither the GPU nor Chrome is touched here.
const seam = vi.hoisted(() => ({
  project: undefined as undefined | ((entry: string) => unknown),
  chrome: undefined as undefined | ((source: unknown) => unknown),
}));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.project?.(entry) ?? actual.openSource(entry, options) };
});
vi.mock('../src/fallback/index.js', () => ({
  openChromeRenderer: (source: unknown) => Promise.resolve(seam.chrome!(source)),
}));

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-doctor-test-'));

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

const skew: Unsupported = {
  path: '$0.2 <div>', element: 'div', property: 'transform', value: 'skewX(10deg)', reason: 'skew is not supported',
};
const canvas: Unsupported = {
  path: '$0.5 <canvas>', element: 'canvas', property: null, value: null, reason: 'element not supported',
};

/** A project stand-in whose frames report `unsupported(frame)`; records which frames were asked for. */
function stubProject(unsupported: (frame: number) => Unsupported[], duration = 20): { source: Source; asked: number[]; disposed: () => number } {
  const dir = scratch();
  const asked: number[] = [];
  let disposed = 0;
  const source: Source = {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 4, height: 4, fps: 30, durationInFrames: duration, defaultProps: {} },
    async frame(frame) {
      asked.push(frame);
      const scene: SceneJson = { width: 4, height: 4, fps: 30, durationInFrames: duration, background: '#000', fonts: {}, layers: [] };
      return { sceneJson: JSON.stringify({ ...scene, id: `f${frame}` }), audio: [], sequences: [], unsupported: unsupported(frame), jsMs: 1, stringifyMs: 0 };
    },
    dispose: () => void disposed++,
  };
  return { source, asked, disposed: () => disposed };
}

const solid = (width: number, height: number, [r, g, b, a]: number[]): { width: number; height: number; data: Buffer } => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r!, g!, b!, a!], i);
  return { width, height, data };
};

beforeEach(() => {
  setNativeForTests(fakeNative().native);
  seam.project = undefined;
  seam.chrome = undefined;
});

describe('doctor <entry>', () => {
  it('reports the share of native frames, the runs and each issue with its frame ranges', async () => {
    // Frames 4..6 and 12 hold a skew; frame 5 also a canvas.
    const { source, asked, disposed } = stubProject((f) => [...(f >= 4 && f <= 6 || f === 12 ? [skew] : []), ...(f === 5 ? [canvas] : [])]);
    seam.project = () => source;
    const r = await cli('doctor', 'index.tsx', '--json');
    expect(r.code).toBe(0);
    const report: DoctorReport = r.json;
    expect(report).toMatchObject({ comp: 'Main', first: 0, last: 19, frames: 20, nativeFrames: 16, chromeFrames: 4, nativeShare: 0.8 });
    expect(report.runs).toEqual([
      { first: 0, last: 3, path: 'native' },
      { first: 4, last: 6, path: 'chrome' },
      { first: 7, last: 11, path: 'native' },
      { first: 12, last: 12, path: 'chrome' },
      { first: 13, last: 19, path: 'native' },
    ]);
    expect(report.issues).toEqual([
      { element: 'div', property: 'transform', reason: 'skew is not supported', values: ['skewX(10deg)'], paths: ['$0.2 <div>'], ranges: [[4, 6], [12, 12]], frames: 4 },
      { element: 'canvas', property: null, reason: 'element not supported', values: [], paths: ['$0.5 <canvas>'], ranges: [[5, 5]], frames: 1 },
    ]);
    expect(report.compare).toBeUndefined();
    // Every frame of the range, once, in order; and the source is released.
    expect(asked).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(disposed()).toBe(1);
  });

  it('prints the report as text', async () => {
    seam.project = () => stubProject((f) => (f >= 4 && f <= 6 ? [skew] : [])).source;
    const r = await cli('doctor', 'index.tsx');
    expect(r.code).toBe(0);
    expect(r.text).toContain('Main: frames 0..19 (20 frames)');
    expect(r.text).toContain('drawn natively: 17 of 20 (85.0%); by Chrome: 3');
    expect(r.text).toMatch(/native\s+0\.\.3\n\s+chrome\s+4\.\.6\n\s+native\s+7\.\.19/);
    expect(r.text).toContain('1. div transform: skew is not supported');
    expect(r.text).toContain('frames 4..6 (3 frames)');
    expect(r.text).toContain('values skewX(10deg)');
    expect(r.text).toContain('at $0.2 <div>');
    expect(r.err).toContain('checked frame 20/20');
  });

  it('checks only the --range, with the end excluded as render does', async () => {
    const { source, asked } = stubProject((f) => (f >= 4 && f <= 6 ? [skew] : []));
    seam.project = () => source;
    const r = await cli('doctor', 'index.tsx', '--range', '5..9', '--json');
    expect(asked).toEqual([5, 6, 7, 8]);
    expect(r.json).toMatchObject({ first: 5, last: 8, frames: 4, nativeFrames: 2, chromeFrames: 2 });
    expect(r.json.issues[0].ranges).toEqual([[5, 6]]);
  });

  it('finds a scene file 100% native', async () => {
    const file = join(scratch(), 'scene.json');
    const scene: SceneJson = {
      width: 64, height: 36, fps: 30, durationInFrames: 30, background: '#000', fonts: {},
      layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
    };
    writeFileSync(file, JSON.stringify(scene));
    const r = await cli('doctor', file, '--json');
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      comp: 'scene', first: 0, last: 29, frames: 30, nativeFrames: 30, chromeFrames: 0, nativeShare: 1,
      runs: [{ first: 0, last: 29, path: 'native' }], issues: [],
    });
    expect((await cli('doctor', file)).text).toContain('nothing needs Chrome');
  });

  it('refuses a --compare that is not a positive whole number', async () => {
    seam.project = () => stubProject(() => []).source;
    expect((await cli('doctor', 'index.tsx', '--compare', '0', '--json')).json.error.code).toBe('INVALID_ARG');
    expect((await cli('doctor', 'index.tsx', '--compare', '1.5', '--json')).json.error.code).toBe('INVALID_ARG');
  });

  it('fails when the project throws on a frame', async () => {
    const { source } = stubProject(() => []);
    source.frame = async (frame) => {
      if (frame === 3) throw new Error('component threw');
      return { sceneJson: '{}', audio: [], unsupported: [], jsMs: 0, stringifyMs: 0 };
    };
    seam.project = () => source;
    const r = await cli('doctor', 'index.tsx', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.message).toContain('component threw');
  });
});

describe('doctor without an entry', () => {
  it('reports the addon', async () => {
    const r = await cli('doctor', '--json');
    expect(r.code).toBe(0);
    expect(r.json.addon).toEqual({ loaded: true, version: '0.0.0-test' });
    expect(r.json.compat).toBeUndefined();
    expect((await cli('doctor')).text).toContain('kinetograph doctor <entry>');
  });

  it('says the options need an entry', async () => {
    const r = await cli('doctor', '--range', '0..5', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error).toEqual({ code: 'INVALID_ARG', message: '--range needs an <entry>' });
  });

  it('is documented in the help', async () => {
    const r = await cli('doctor', '--help');
    expect(r.text).toContain('usage: kinetograph doctor [entry]');
    expect(r.text).toContain('--compare <number>');
    expect(r.text).toContain('--range <string>');
  });
});

describe('doctor --compare', () => {
  /** The native side draws frame f as grey f; Chrome draws it as grey f + `offset`. */
  function stubSides(offset: (frame: number) => number) {
    const nativeCalls: { scene: any; frame: number; baseDir?: string | null }[] = [];
    class Renderer {
      rgba(scene: string, frame: number, baseDir?: string | null) {
        nativeCalls.push({ scene: JSON.parse(scene), frame, baseDir });
        return solid(4, 4, [frame, frame, frame, 255]);
      }
    }
    setNativeForTests(fakeNative({ Renderer }).native);
    const chromeCalls: number[] = [];
    let closed = 0;
    let opened = 0;
    seam.chrome = () => {
      opened++;
      const renderer: ChromeRenderer = {
        async frame(frame): Promise<ChromeFrame> {
          chromeCalls.push(frame);
          return solid(4, 4, [frame + offset(frame), frame, frame, 255]);
        },
        async close() {
          closed++;
        },
      };
      return renderer;
    };
    return { nativeCalls, chromeCalls, closed: () => closed, opened: () => opened };
  }

  it('draws frames spread over the range both ways and fills compare', async () => {
    const sides = stubSides((f) => (f === 19 ? 10 : 0));
    const { source, asked } = stubProject((f) => (f >= 10 ? [skew] : []));
    seam.project = () => source;
    const r = await cli('doctor', 'index.tsx', '--compare', '3', '--json');
    expect(r.code).toBe(0);
    expect(r.json.compare).toEqual([
      { frame: 0, path: 'native', maxDiff: 0, meanDiff: 0, differingPixels: 0 },
      { frame: 10, path: 'chrome', maxDiff: 0, meanDiff: 0, differingPixels: 0 },
      { frame: 19, path: 'chrome', maxDiff: 10, meanDiff: 2.5, differingPixels: 16 },
    ]);
    // The scenes come from the single pass over the frames: the project is not run twice.
    expect(asked).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(sides.nativeCalls.map((c) => [c.frame, c.scene.id, c.baseDir])).toEqual([
      [0, 'f0', source.baseDir], [10, 'f10', source.baseDir], [19, 'f19', source.baseDir],
    ]);
    expect(sides.chromeCalls).toEqual([0, 10, 19]);
    expect(sides.opened()).toBe(1);
    expect(sides.closed()).toBe(1);
  });

  it('samples inside the --range', async () => {
    const sides = stubSides(() => 0);
    seam.project = () => stubProject(() => []).source;
    const r = await cli('doctor', 'index.tsx', '--range', '4..=8', '--compare', '2', '--json');
    expect(r.json.compare.map((c: { frame: number }) => c.frame)).toEqual([4, 8]);
    expect(sides.chromeCalls).toEqual([4, 8]);
  });

  it('prints the comparison as text', async () => {
    stubSides((f) => (f === 0 ? 5 : 0));
    seam.project = () => stubProject(() => []).source;
    const r = await cli('doctor', 'index.tsx', '--compare', '2');
    expect(r.text).toContain('native against Chrome');
    expect(r.text).toContain('frame 0 (native): max 5, mean 1.250, 16 pixels more than 2 apart');
    expect(r.text).toContain('frame 19 (native): max 0, mean 0.000, 0 pixels more than 2 apart');
  });

  it('never starts Chrome without --compare', async () => {
    const sides = stubSides(() => 0);
    seam.project = () => stubProject(() => []).source;
    await cli('doctor', 'index.tsx', '--json');
    expect(sides.opened()).toBe(0);
  });

  it('closes Chrome when a side fails', async () => {
    const sides = stubSides(() => 0);
    seam.project = () => stubProject(() => []).source;
    class Broken {
      rgba(): never {
        throw new Error('no GPU');
      }
    }
    setNativeForTests(fakeNative({ Renderer: Broken }).native);
    const r = await cli('doctor', 'index.tsx', '--compare', '2', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.message).toContain('no GPU');
    expect(sides.closed()).toBe(1);
  });

  it('refuses a scene file, which has no DOM for Chrome', async () => {
    const sides = stubSides(() => 0);
    const file = join(scratch(), 'scene.json');
    writeFileSync(file, JSON.stringify({ width: 4, height: 4, fps: 30, durationInFrames: 3, background: '#000', fonts: {}, layers: [] }));
    const r = await cli('doctor', file, '--compare', '2', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('INVALID_ARG');
    expect(sides.opened()).toBe(0);
  });
});

describe('diffRgba', () => {
  it('measures max, mean over all four channels, and pixels more than 2 apart', () => {
    const a = Uint8Array.from([0, 0, 0, 255, 100, 100, 100, 255, 10, 10, 10, 255]);
    const b = Uint8Array.from([2, 0, 0, 255, 100, 103, 100, 255, 10, 10, 10, 250]);
    // Differences 2, 3 and 5: the first pixel is within 2 levels, the other two are not.
    expect(diffRgba(a, b)).toEqual({ maxDiff: 5, meanDiff: 10 / 12, differingPixels: 2 });
  });

  it('is zero for equal pictures and for none', () => {
    const a = Uint8Array.from([1, 2, 3, 4]);
    expect(diffRgba(a, a)).toEqual({ maxDiff: 0, meanDiff: 0, differingPixels: 0 });
    expect(diffRgba(new Uint8Array(0), new Uint8Array(0))).toEqual({ maxDiff: 0, meanDiff: 0, differingPixels: 0 });
  });
});

describe('compareFrames', () => {
  it('names the frame when the two sides draw different sizes', async () => {
    const native = { rgba: () => solid(4, 4, [0, 0, 0, 255]) };
    const chrome = { frame: async () => solid(8, 4, [0, 0, 0, 255]) };
    await expect(compareFrames([{ frame: 7, sceneJson: '{}', unsupported: [] }], '/p', native as any, chrome)).rejects.toMatchObject({
      code: 'SIZE_MISMATCH',
      message: expect.stringContaining('frame 7: the engine drew 4x4 and Chrome 8x4'),
    });
  });

  it('gives a frame the path render would draw it by', async () => {
    const native = { rgba: () => solid(1, 1, [0, 0, 0, 255]) };
    const chrome = { frame: async () => solid(1, 1, [0, 0, 0, 255]) };
    const out = await compareFrames(
      [{ frame: 1, sceneJson: '{}', unsupported: [] }, { frame: 2, sceneJson: '{}', unsupported: [skew] }],
      '/p', native as any, chrome,
    );
    expect(out.map((c) => c.path)).toEqual(['native', 'chrome']);
  });
});

describe('formatReport', () => {
  const base: DoctorReport = {
    comp: 'Main', first: 0, last: 9, frames: 10, nativeFrames: 10, chromeFrames: 0, nativeShare: 1,
    runs: [{ first: 0, last: 9, path: 'native' }], issues: [],
  };

  it('says so when nothing needs Chrome', () => {
    expect(formatReport(base)).toBe(
      'Main: frames 0..9 (10 frames)\ndrawn natively: 10 of 10 (100.0%); by Chrome: 0\nnothing needs Chrome: every frame is drawn by the engine',
    );
  });

  it('writes a one-frame range and a single issue plainly', () => {
    const text = formatReport({
      ...base, first: 3, last: 3, frames: 1, nativeFrames: 0, chromeFrames: 1, nativeShare: 0,
      runs: [{ first: 3, last: 3, path: 'chrome' }],
      issues: [{ element: 'canvas', property: null, reason: 'element not supported', values: [], paths: ['$0 <canvas>'], ranges: [[3, 3]], frames: 1 }],
    });
    expect(text).toContain('Main: frames 3..3 (1 frame)');
    expect(text).toContain('1 issue, most frames first:');
    expect(text).toContain('1. canvas: element not supported\n     frames 3 (1 frame)\n     at $0 <canvas>');
    expect(text).not.toContain('values');
  });

  it('has a line for a report with no frames', () => {
    expect(formatReport({ ...base, frames: 0, runs: [] })).toBe('Main: no frames checked');
  });
});

describe('lint with compat issues', () => {
  it('reports one warning per issue group and still passes', async () => {
    seam.project = () => stubProject((f) => (f >= 10 ? [skew] : [])).source;
    setNativeForTests(
      fakeNative({
        inspect: (_s: string, frame: number) =>
          JSON.stringify({ width: 4, height: 4, fps: 30, durationInFrames: 20, frame, margin: 0, camera: null, layers: [] }),
      }).native,
    );
    const r = await cli('lint', 'index.tsx', '--frames', '0,10,15', '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, errors: 0, warnings: 1 });
    expect(r.json.issues).toEqual([
      {
        rule: 'compat',
        severity: 'warning',
        layer: null,
        message: 'not drawn natively, so Chrome renders the frame: div transform: skew is not supported (skewX(10deg)) at $0.2 <div>',
        frames: [10, 15],
      },
    ]);
    const text = await cli('lint', 'index.tsx', '--frames', '0,10,15');
    expect(text.text).toContain('warning compat at frames 10, 15: not drawn natively');
  });
});
