import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '@kinetographdev/compat/doctor';
import type { SceneJson, Unsupported } from '@kinetographdev/scene';
import { formatReport } from '../src/commands/doctor.js';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { fakeNative } from './helpers.js';

// As in commands.test.ts: `openSource` is the seam to a project's bundle. The GPU is not touched here.
const seam = vi.hoisted(() => ({
  project: undefined as undefined | ((entry: string, options: { unsupportedImports?: { specifier: string; file: string | null }[] }) => unknown),
}));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.project?.(entry, options) ?? actual.openSource(entry, options) };
});

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

beforeEach(() => {
  setNativeForTests(fakeNative().native);
  seam.project = undefined;
});

describe('doctor <entry>', () => {
  it('reports the share of clean frames and each issue with its frame ranges', async () => {
    // Frames 4..6 and 12 hold a skew; frame 5 also a canvas.
    const { source, asked, disposed } = stubProject((f) => [...(f >= 4 && f <= 6 || f === 12 ? [skew] : []), ...(f === 5 ? [canvas] : [])]);
    seam.project = () => source;
    const r = await cli('doctor', 'index.tsx', '--json');
    expect(r.code).toBe(0);
    const report: DoctorReport = r.json;
    expect(report).toMatchObject({ comp: 'Main', first: 0, last: 19, frames: 20, cleanFrames: 16, unsupportedFrames: 4, cleanShare: 0.8 });
    expect(report.issues).toEqual([
      { element: 'div', property: 'transform', reason: 'skew is not supported', values: ['skewX(10deg)'], paths: ['$0.2 <div>'], ranges: [[4, 6], [12, 12]], frames: 4 },
      { element: 'canvas', property: null, reason: 'element not supported', values: [], paths: ['$0.5 <canvas>'], ranges: [[5, 5]], frames: 1 },
    ]);
    // Every frame of the range, once, in order; and the source is released.
    expect(asked).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(disposed()).toBe(1);
  });

  it('lists every unsupported import and checks what it can', async () => {
    const { source } = stubProject(() => []);
    seam.project = (_entry, options) => {
      options.unsupportedImports?.push({ specifier: '@remotion/three', file: '/p/src/Scene.tsx' }, { specifier: '@remotion/player', file: '/p/src/App.tsx' });
      return source;
    };
    const r = await cli('doctor', 'index.tsx', '--json');
    expect(r.code).toBe(0);
    expect(r.json.unsupportedImports).toEqual([
      { specifier: '@remotion/three', file: '/p/src/Scene.tsx' },
      { specifier: '@remotion/player', file: '/p/src/App.tsx' },
    ]);
    expect(r.json).toMatchObject({ comp: 'Main', frames: 20 });
    const text = await cli('doctor', 'index.tsx');
    expect(text.text).toContain('2 imports of packages Kinetograph does not support');
    expect(text.text).toContain('@remotion/three  imported by');
    expect(text.text).toContain('Main: frames 0..19');
    expect(text.text).not.toContain('nothing is left out');
    expect(text.text).toContain('2 unsupported imports drawn as nothing');
  });

  it('lists the unsupported imports instead of the error when the project cannot be opened', async () => {
    seam.project = (_entry, options) => {
      options.unsupportedImports?.push({ specifier: '@remotion/three', file: '/p/src/Scene.tsx' });
      throw new Error('ThreeCanvas is not a function');
    };
    const r = await cli('doctor', 'index.tsx');
    expect(r.code).toBe(0);
    expect(r.text).toContain('1 import of packages Kinetograph does not support');
    expect(r.text).toContain('@remotion/three  imported by');
    expect(r.text).toContain('the frames could not be checked: ThreeCanvas is not a function');
  });

  it('still fails on an error when no import is unsupported', async () => {
    seam.project = () => {
      throw new Error('boom');
    };
    expect((await cli('doctor', 'index.tsx')).code).not.toBe(0);
  });

  it('reports a scene the render would refuse, by frames, and exits 1', async () => {
    const refusal = 'invalid scene: layer "pill": a preserve3d group cannot have effects; put the group inside another group and give that one what it needs';
    // The scene validation of the addon, refusing frames 3..5 and 9.
    setNativeForTests(
      fakeNative({
        validateScene: (text: string) => {
          const frame = Number((JSON.parse(text) as { id: string }).id.slice(1));
          if ((frame >= 3 && frame <= 5) || frame === 9) throw new Error(refusal);
          return { width: 4, height: 4, fps: 30, durationInFrames: 20, margin: 0 };
        },
      }).native,
    );
    seam.project = () => stubProject(() => []).source;
    const r = await cli('doctor', 'index.tsx', '--json');
    expect(r.code).toBe(1);
    const report: DoctorReport = r.json;
    expect(report.renderErrors).toEqual([{ message: refusal, ranges: [[3, 5], [9, 9]], frames: 4 }]);
    const text = await cli('doctor', 'index.tsx');
    expect(text.code).toBe(1);
    expect(text.text).toContain('1 error: the scene is refused, so a render stops there');
    expect(text.text).toContain(`1. ${refusal}`);
    expect(text.text).toContain('frames 3..5, 9 (4 frames)');
  });

  it('prints the report as text', async () => {
    seam.project = () => stubProject((f) => (f >= 4 && f <= 6 ? [skew] : [])).source;
    const r = await cli('doctor', 'index.tsx');
    expect(r.code).toBe(0);
    expect(r.text).toContain('Main: frames 0..19 (20 frames)');
    expect(r.text).toContain('nothing unsupported in 17 of 20 frames (85.0%); with unsupported content: 3');
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
    expect(r.json).toMatchObject({ first: 5, last: 8, frames: 4, cleanFrames: 2, unsupportedFrames: 2 });
    expect(r.json.issues[0].ranges).toEqual([[5, 6]]);
  });

  it('finds nothing unsupported in a scene file', async () => {
    const file = join(scratch(), 'scene.json');
    const scene: SceneJson = {
      width: 64, height: 36, fps: 30, durationInFrames: 30, background: '#000', fonts: {},
      layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
    };
    writeFileSync(file, JSON.stringify(scene));
    const r = await cli('doctor', file, '--json');
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      comp: 'scene', first: 0, last: 29, frames: 30, cleanFrames: 30, unsupportedFrames: 0, cleanShare: 1, issues: [],
    });
    expect((await cli('doctor', file)).text).toContain('nothing is left out');
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
    expect(r.text).toContain('--range <string>');
  });
});

describe('formatReport', () => {
  const base: DoctorReport = {
    comp: 'Main', first: 0, last: 9, frames: 10, cleanFrames: 10, unsupportedFrames: 0, cleanShare: 1, issues: [],
  };

  it('says so when nothing is unsupported', () => {
    expect(formatReport(base)).toBe(
      'Main: frames 0..9 (10 frames)\nnothing unsupported in 10 of 10 frames (100.0%); with unsupported content: 0\n' +
        'nothing is left out: every frame is drawn in full by the engine',
    );
  });

  it('writes a one-frame range and a single issue plainly', () => {
    const text = formatReport({
      ...base, first: 3, last: 3, frames: 1, cleanFrames: 0, unsupportedFrames: 1, cleanShare: 0,
      issues: [{ element: 'canvas', property: null, reason: 'element not supported', values: [], paths: ['$0 <canvas>'], ranges: [[3, 3]], frames: 1 }],
    });
    expect(text).toContain('Main: frames 3..3 (1 frame)');
    expect(text).toContain('1 issue, most frames first:');
    expect(text).toContain('1. canvas: element not supported\n     frames 3 (1 frame)\n     at $0 <canvas>');
    expect(text).not.toContain('values');
  });

  it('has a line for a report with no frames', () => {
    expect(formatReport({ ...base, frames: 0 })).toBe('Main: no frames checked');
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
        message: 'not supported, so the frame is drawn without it or approximated: div transform: skew is not supported (skewX(10deg)) at $0.2 <div>',
        frames: [10, 15],
      },
    ]);
    const text = await cli('lint', 'index.tsx', '--frames', '0,10,15');
    expect(text.text).toContain('warning compat at frames 10, 15: not supported');
  });
});
