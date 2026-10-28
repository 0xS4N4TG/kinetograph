import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOnFrame, onFrame } from '@kinetographdev/audio';
import type { AudioClipJson, SceneJson } from '@kinetographdev/scene';
import { FontDownloadError } from '@kinetographdev/core/google-fonts';
import { toErrorObject } from '../src/errors.js';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { LABEL_FONT_PATH } from '../src/scenes.js';
import { fakeNative, solidPng, sine, writeWav, type Calls } from './helpers.js';

// `openSource` is the one seam to a project's bundle, which needs the real core; tests that need a project give
// it a stand-in `Source`, the others get the real one (scene files).
const seam = vi.hoisted(() => ({ override: undefined as undefined | ((entry: string) => unknown) }));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.override?.(entry) ?? actual.openSource(entry, options) };
});

let calls: Calls;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-cli-test-'));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) }, out, err };
}
async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const captured = io();
  const code = await run(argv, captured.io);
  const text = captured.out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: captured.err.join('') };
}

const sceneObject = (over: Partial<SceneJson> = {}): SceneJson => ({
  width: 64, height: 36, fps: 30, durationInFrames: 90, background: '#000',
  fonts: { 'DM Sans': LABEL_FONT_PATH },
  layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
  ...over,
});
function sceneFile(scene: SceneJson = sceneObject()): string {
  const file = join(scratch(), 'scene.json');
  writeFileSync(file, JSON.stringify(scene));
  return file;
}

/** A project stand-in: each frame's scene carries the frame number in a layer id. */
function fakeProject(options: { audio?: (frame: number) => AudioClipJson[]; failAt?: number; dir?: string; notes?: string[]; artifacts?: { filename: string; content: string | Uint8Array; frame: number }[] } = {}): Source {
  const dir = options.dir ?? scratch();
  return {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: {} },
    async frame(frame) {
      if (frame === options.failAt) throw new Error('component threw');
      const scene = sceneObject({ layers: [{ id: `frame-${frame}`, type: 'shape', shape: { kind: 'rect', width: 8, height: 8 }, fill: '#fff' }] });
      return { sceneJson: JSON.stringify(scene), audio: options.audio?.(frame) ?? [], jsMs: 2, stringifyMs: 0.5 };
    },
    notes: () => options.notes ?? [],
    artifacts: () => (options.artifacts ?? []) as never,
    clearArtifacts() {},
    dispose() {},
  };
}

beforeEach(() => {
  const fake = fakeNative({
    inspect: (_scene: string, frame: number) =>
      JSON.stringify({ width: 64, height: 36, fps: 30, durationInFrames: 90, frame, margin: 0, camera: null, layers: [] }),
  });
  calls = fake.calls;
  setNativeForTests(fake.native);
  seam.override = undefined;
  clearOnFrame();
});
afterEach(() => {
  setNativeForTests(undefined);
  seam.override = undefined;
  clearOnFrame();
});

describe('errors', () => {
  it('reports a failed font download as FONT_DOWNLOAD', () => {
    expect(toErrorObject(new FontDownloadError('https://example.com/f.ttf', 404)).code).toBe('FONT_DOWNLOAD');
  });

  it('prints { error: { code, message } } and exits 1 with --json', async () => {
    const r = await cli('compositions', '/no/such/file.tsx', '--json');
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ error: { code: 'ENTRY_NOT_FOUND', message: 'no such file: /no/such/file.tsx' } });
  });

  it('prints a plain message on stderr without --json', async () => {
    const r = await cli('compositions', '/no/such/file.tsx');
    expect(r.code).toBe(1);
    expect(r.text).toBe('');
    expect(r.err).toBe('error: no such file: /no/such/file.tsx\n');
  });

  it('reports argument errors as INVALID_ARG, and an unknown command', async () => {
    const bad = await cli('still', sceneFile(), '--nope', '--json');
    expect(bad.json.error.code).toBe('INVALID_ARG');
    expect((await cli('frobnicate', '--json')).json.error.code).toBe('INVALID_ARG');
    expect((await cli('still', sceneFile(), '3', '--json')).json.error).toEqual({ code: 'INVALID_ARG', message: 'missing -o <output>' });
  });

  it('passes the addon\'s error codes through', async () => {
    setNativeForTests(
      fakeNative({
        validateScene: () => {
          throw Object.assign(new Error('invalid scene: layer "x"'), { code: 'SCENE_INVALID' });
        },
      }).native,
    );
    const r = await cli('compositions', sceneFile(), '--json');
    expect(r.json.error).toEqual({ code: 'SCENE_INVALID', message: 'invalid scene: layer "x"' });
  });

  it('says NATIVE_UNAVAILABLE when the addon cannot be loaded, but still runs effects', async () => {
    setNativeForTests(undefined);
    const effects = await cli('effects', '--json');
    expect(effects.code).toBe(0);
  });

  it('prints help and the version', async () => {
    const help = await cli('--help');
    expect(help.code).toBe(0);
    expect(help.text).toContain('audio analyze');
    expect((await cli('still', '--help')).text).toContain('usage: kinetograph still <entry> <frame>');
    expect((await cli('--version')).text).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('compositions, effects, doctor', () => {
  it('lists the one composition of a scene file, named after the file', async () => {
    const r = await cli('compositions', sceneFile(), '--json');
    expect(r.code).toBe(0);
    expect(r.json.compositions).toEqual([
      { id: 'scene', width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: {} },
    ]);
    expect((await cli('compositions', sceneFile())).text).toContain('scene  64x36  30 fps  90 frames (3.00 s)');
  });

  it('lists the effects of the scene package', async () => {
    const r = await cli('effects', '--json');
    expect(r.json.effects.length).toBeGreaterThan(10);
    expect(r.json.effects.map((e: { type: string }) => e.type)).toContain('dropShadow');
    expect((await cli('effects')).text).toContain('dropShadow:');
  });

  it('reports the addon when given no entry (the compat report is in doctor.test.ts)', async () => {
    const r = await cli('doctor', '--json');
    expect(r.json.addon).toEqual({ loaded: true, version: '0.0.0-test' });
    // On the GPU there is nothing to explain.
    expect(r.json).toMatchObject({ renderer: 'Skia GPU (Metal)', rendererReason: null });
    expect(r.text).not.toContain('why not the GPU');
  });

  it('says why the renderer fell back to the CPU, in the text and in --json', async () => {
    const reason = 'Skia\'s Graphite cannot use the Vulkan device Intel(R) Graphics (MTL), Mesa 24.2.1, Vulkan 1.3.274: R8G8B8A8_UNORM images lack the format features COLOR_ATTACHMENT_BLEND';
    class CpuRenderer {
      backend = () => 'Skia CPU (GPU unusable)';
      backendReason = () => reason;
    }
    setNativeForTests(fakeNative({ Renderer: CpuRenderer }).native);
    const json = await cli('doctor', '--json');
    expect(json.json).toMatchObject({ renderer: 'Skia CPU (GPU unusable)', rendererReason: reason });
    const text = await cli('doctor');
    expect(text.text).toContain('renderer: Skia CPU (GPU unusable)');
    expect(text.text).toContain(`why not the GPU: ${reason}`);
  });
});

describe('still', () => {
  it('hands a scene file to the addon unchanged and writes the PNG', async () => {
    const file = sceneFile();
    const output = join(scratch(), 'sub', 'out.png');
    const r = await cli('still', file, '30', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ output, width: 64, height: 36, frame: 30 });
    expect(calls.still).toHaveLength(1);
    expect(calls.still[0]).toMatchObject({ frame: 30, scene: JSON.parse(readFileSync(file, 'utf8')) });
    expect(calls.still[0]!.baseDir).toBe(join(file, '..'));
    expect(readFileSync(output).subarray(1, 4).toString()).toBe('PNG');
  });

  it('renders a project\'s frame', async () => {
    seam.override = () => fakeProject();
    const output = join(scratch(), 'p.png');
    const r = await cli('still', 'index.tsx', '7', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(JSON.stringify(calls.still[0]!.scene)).toContain('frame-7');
  });

  it('refuses frames outside the composition', async () => {
    const file = sceneFile();
    for (const frame of ['90', '-1']) {
      const r = await cli('still', file, frame, '-o', join(scratch(), 'x.png'), '--json');
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe('FRAME_OUT_OF_RANGE');
    }
    expect(calls.still).toHaveLength(0);
  });
});

describe('check', () => {
  it('lists type errors with file and position, and exits 1', async () => {
    const dir = scratch();
    const entry = join(dir, 'index.ts');
    writeFileSync(entry, 'export const x: number = "a";\n');
    const r = await cli('check', entry, '--json');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, checked: true, errors: 1 });
    expect(r.json.diagnostics[0]).toMatchObject({ line: 1, column: 14, code: 2322 });
    expect((await cli('check', entry)).text).toContain('TS2322');
  });

  it('is ok for a project that type-checks and for a scene file', async () => {
    const dir = scratch();
    const entry = join(dir, 'index.ts');
    writeFileSync(entry, 'export const x: number = 1;\n');
    expect((await cli('check', entry, '--json')).json).toMatchObject({ ok: true, errors: 0 });
    expect((await cli('check', sceneFile(), '--json')).json).toMatchObject({ ok: true, checked: false });
  });
});

describe('inspect and lint', () => {
  it('prints the addon\'s InspectResult', async () => {
    const r = await cli('inspect', sceneFile(), '--frame', '12', '--json');
    expect(r.json).toMatchObject({ width: 64, frame: 12, layers: [] });
  });

  it('lints text running off the canvas, with frame and layer, and exits 1 on errors', async () => {
    const overflowing = {
      width: 64, height: 36, fps: 30, durationInFrames: 90, frame: 0, margin: 0, camera: null,
      layers: [{
        id: 'title', type: 'text', opacity: 1, blendMode: 'normal',
        transform: {}, matrix: [1, 0, 0, 1, 40, 5], box: { x: 0, y: 0, width: 100, height: 20 }, bounds: null,
        effects: [], clip: null, mask: false, matte: null, matteSource: false, motionBlur: null,
        text: { text: 'long', font: 'DM Sans', size: 20, width: 100, height: 20, maxWidth: null, lines: [{ text: 'long', top: 0, bottom: 20, baseline: 15 }] },
      }],
    };
    setNativeForTests(fakeNative({ inspect: () => JSON.stringify(overflowing) }).native);
    const r = await cli('lint', sceneFile(), '--frames', '0,45', '--json');
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.framesChecked).toEqual([0, 45]);
    expect(r.json.issues).toEqual([
      expect.objectContaining({ rule: 'text-overflow-canvas', layer: 'title', severity: 'error', frames: [0, 45] }),
    ]);
  });

  it('finds a text layer whose font is not registered, and survives the addon refusing the scene', async () => {
    const scene = sceneObject({ layers: [{ id: 'label', type: 'text', text: 'x', font: 'Nope', size: 10 }] });
    setNativeForTests(
      fakeNative({
        inspect: () => {
          throw Object.assign(new Error('font "Nope" is not in the scene'), { code: 'SCENE_INVALID' });
        },
      }).native,
    );
    const r = await cli('lint', sceneFile(scene), '--frames', '0', '--json');
    expect(r.code).toBe(1);
    expect(r.json.issues.map((i: { rule: string }) => i.rule)).toEqual(['missing-font', 'inspect-failed']);
    expect(r.json.issues.find((i: { rule: string }) => i.rule === 'missing-font').layer).toBe('label');
  });

  it('reports a type error in the project as a lint error without a frame', async () => {
    const dir = scratch();
    const entry = join(dir, 'index.ts');
    writeFileSync(entry, 'export const x: number = "a";\n');
    seam.override = () => fakeProject();
    const r = await cli('lint', entry, '--frames', '0', '--json');
    expect(r.code).toBe(1);
    expect(r.json.issues).toEqual([
      expect.objectContaining({ rule: 'type-error', severity: 'error', layer: null, frames: [] }),
    ]);
    expect(r.json.issues[0].message).toContain('TS2322');
    expect((await cli('lint', entry, '--frames', '0')).text).toContain('error type-error: ');
  });

  it('reports what the project noted (a font that did not download) as a warning instead of aborting', async () => {
    const dir = scratch();
    const entry = join(dir, 'index.ts');
    writeFileSync(entry, 'export const x: number = 1;\n');
    const note = 'FontFace "Gone": Downloading the font from https://example.com/gone.ttf failed with HTTP status 404; the font is not registered';
    seam.override = () => fakeProject({ notes: [note] });
    const r = await cli('lint', entry, '--frames', '0', '--json');
    expect(r.code).toBe(0);
    expect(r.json.issues).toEqual([expect.objectContaining({ rule: 'project-note', severity: 'warning', message: note, frames: [] })]);
  });

  it('is ok with no issues, spreading 8 frames by default', async () => {
    const r = await cli('lint', sceneFile(), '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, errors: 0, warnings: 0 });
    expect(r.json.framesChecked).toHaveLength(8);
    expect(r.json.framesChecked[0]).toBe(0);
    expect(r.json.framesChecked.at(-1)).toBe(89);
  });
});

describe('render', () => {
  it('sends a scene file to the addon whole; --draft wraps it at half size', async () => {
    const file = sceneFile();
    const out = join(scratch(), 'a.mp4');
    const full = await cli('render', file, '-o', out, '--range', '0..10', '--json');
    expect(full.code).toBe(0);
    expect(calls.render[0]).toMatchObject({ output: out, scene: JSON.parse(readFileSync(file, 'utf8')), options: { range: '0..10' } });

    await cli('render', file, '-o', out, '--draft', '--encoder', 'libx264', '--json');
    const draft = calls.render[1]!.scene as SceneJson;
    expect(draft).toMatchObject({ width: 32, height: 18 });
    expect(draft.layers).toHaveLength(1);
    expect(draft.layers[0]).toMatchObject({ type: 'group', transform: { scale: 0.5 } });
    expect(calls.render[1]!.options).toMatchObject({ encoder: 'libx264' });
  });

  it('pushes a project\'s frames in order and finishes without audio when there is none', async () => {
    seam.override = () => fakeProject();
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '10..14', '--json');
    expect(r.code).toBe(0);
    expect(calls.begun[0]!.options).toMatchObject({ width: 64, height: 36, fps: 30 });
    expect(calls.pushed.map((p) => p.frame)).toEqual([10, 11, 12, 13]);
    expect(JSON.stringify(calls.pushed[2]!.scene)).toContain('frame-12');
    expect(calls.finished).toEqual([undefined]);
    expect(r.json).toMatchObject({ frames: 3, audio: false });
  });

  it('writes the <Artifact> files of the rendered frames next to the video: text, bytes and a thumbnail', async () => {
    seam.override = () =>
      fakeProject({
        artifacts: [
          { filename: 'notes.txt', content: 'hello', frame: 11 },
          { filename: 'sub/data.bin', content: new Uint8Array([1, 2, 3]), frame: 12 },
          { filename: 'thumb.png', content: 'thumbnail' as never, frame: 12 },
          { filename: 'later.txt', content: 'outside the range', frame: 40 },
        ],
      });
    const dir = scratch();
    const r = await cli('render', 'index.tsx', '-o', join(dir, 'p.mp4'), '--range', '10..14', '--json');
    expect(r.code).toBe(0);
    expect(r.json.artifacts).toEqual(['notes.txt', 'sub/data.bin', 'thumb.png']);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('hello');
    expect([...readFileSync(join(dir, 'sub', 'data.bin'))]).toEqual([1, 2, 3]);
    expect(existsSync(join(dir, 'later.txt'))).toBe(false);
    expect(calls.still.map((s) => s.frame)).toEqual([12]);
    expect(existsSync(join(dir, 'thumb.png'))).toBe(true);
  });

  it('mixes onFrame synthesis and joined <Audio> clips and passes the PCM to finish', async () => {
    const { dir, name } = writeWav(sine(440, 0.5, 2, 48000), 48000);
    const clip = (volume: number): AudioClipJson => ({
      id: 'music', src: name, from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume, loop: false, muted: false,
    });
    onFrame(0, (ctx, t) => {
      const src = ctx.createConstantSource();
      src.offset.value = 2; // louder than full scale: the encoder is promised -1..1
      src.connect(ctx.destination);
      src.start(t);
      src.stop(t + 0.1);
    });
    seam.override = () => fakeProject({ dir, audio: (frame) => (frame < 30 ? [clip(1)] : []) });
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..60', '--json');
    expect(r.code).toBe(0);
    expect(r.json.audio).toBe(true);
    const pcm = calls.finished[0] as { sampleRate: number; channels: Float32Array[] };
    expect(pcm.sampleRate).toBe(48000);
    expect(pcm.channels).toHaveLength(2);
    expect(pcm.channels[0]!.length).toBe(2 * 48000);
    let peak = 0;
    let tail = 0;
    pcm.channels[0]!.forEach((v, i) => {
      peak = Math.max(peak, Math.abs(v));
      if (i > 1.2 * 48000) tail = Math.max(tail, Math.abs(v));
    });
    expect(peak).toBe(1); // clamped
    expect(tail).toBe(0); // the clip played in frames 0..29 only
  });

  it('halves the writer and the scenes of a project with --draft', async () => {
    seam.override = () => fakeProject();
    await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..2', '--draft', '--json');
    expect(calls.begun[0]!.options).toMatchObject({ width: 32, height: 18 });
    expect(calls.pushed[0]!.scene).toMatchObject({ width: 32, height: 18, layers: [{ type: 'group', transform: { scale: 0.5 } }] });
  });

  it('aborts the video and reports the error when a frame fails', async () => {
    seam.override = () => fakeProject({ failAt: 2 });
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..5', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.message).toBe('component threw');
    expect(calls.aborted).toBe(1);
    expect(calls.finished).toHaveLength(0);
  });
});

describe('strip and onion', () => {
  it('renders the sampled frames, then a labelled grid scene, and cleans up', async () => {
    seam.override = () => fakeProject();
    const output = join(scratch(), 'sheet.png');
    const r = await cli('strip', 'index.tsx', '-n', '4', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(r.json.frames).toEqual([0, 30, 59, 89]);
    expect(calls.still.map((c) => c.frame)).toEqual([0, 30, 59, 89, 0]);
    const sheet = calls.still[4]!.scene as SceneJson;
    expect(sheet.layers.filter((l) => l.type === 'image')).toHaveLength(4);
    expect(sheet.layers.filter((l) => l.type === 'text').map((l) => (l as { text: string }).text)[1]).toBe('f30  1.00s');
    expect(sheet.fonts).toEqual({ 'DM Sans': LABEL_FONT_PATH });
    expect(readFileSync(output).subarray(1, 4).toString()).toBe('PNG');
    // The PNGs of the frames were in the sheet's base directory, which is gone.
    expect(existsSync(calls.still[4]!.baseDir!)).toBe(false);
    expect(r.json.width).toBe(sheet.width);
  });

  it('blends the frames of a range for onion', async () => {
    seam.override = () => fakeProject();
    const output = join(scratch(), 'onion.png');
    const r = await cli('onion', 'index.tsx', '10..40', '-n', '3', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(r.json.frames).toEqual([10, 25, 39]);
    const scene = calls.still.at(-1)!.scene as SceneJson;
    expect(scene.layers.map((l) => l.opacity)).toEqual([1, 0.5, 1 / 3]);
  });

  it('limits n', async () => {
    seam.override = () => fakeProject();
    const r = await cli('strip', 'index.tsx', '-n', '500', '-o', join(scratch(), 's.png'), '--json');
    expect(r.json.error.code).toBe('INVALID_ARG');
  });
});

describe('bench', () => {
  it('reports the addon\'s stages for a scene file, with no JS stages', async () => {
    const r = await cli('bench', sceneFile(), '--frame', '5', '--runs', '4', '--json');
    expect(r.code).toBe(0);
    expect(calls.bench[0]!.options).toEqual({ frame: 5, runs: 4 });
    expect(Object.keys(r.json.stages)).toEqual(['handoff', 'resolve', 'raster', 'composite', 'readback', 'total']);
    expect(r.json.stages.total.mean).toBeCloseTo(20);
  });

  it('adds js and stringify for a project and counts them in the total', async () => {
    seam.override = () => fakeProject();
    const r = await cli('bench', 'index.tsx', '--runs', '3', '--json');
    expect(Object.keys(r.json.stages).slice(0, 3)).toEqual(['js', 'stringify', 'handoff']);
    expect(r.json.stages.js.mean).toBe(2);
    expect(r.json.stages.stringify.mean).toBe(0.5);
    expect(r.json.stages.total.mean).toBeCloseTo(22.5);
  });

  it('times a project range frame by frame', async () => {
    seam.override = () => fakeProject();
    const r = await cli('bench', 'index.tsx', '--range', '0..4', '--json');
    expect(calls.bench.map((b) => (b.options as { frame: number }).frame)).toEqual([0, 1, 2, 3]);
    expect(r.json.frames).toHaveLength(4);
  });

  it('does not take --range with --frame', async () => {
    const r = await cli('bench', sceneFile(), '--range', '0..4', '--frame', '1', '--json');
    expect(r.json.error.code).toBe('INVALID_ARG');
  });
});

describe('snapshot', () => {
  it('fails on a missing snapshot, approves with --update, then matches', async () => {
    const file = sceneFile();
    const missing = await cli('snapshot', file, '--frames', '0,10', '--json');
    expect(missing.code).toBe(1);
    expect(missing.json.results.map((r: { status: string }) => r.status)).toEqual(['missing', 'missing']);

    const update = await cli('snapshot', file, '--frames', '0,10', '--update', '--json');
    expect(update.code).toBe(0);
    expect(update.json.results.map((r: { status: string }) => r.status)).toEqual(['created', 'created']);
    expect(existsSync(join(file, '..', '__snapshots__', 'scene.f10.png'))).toBe(true);

    const again = await cli('snapshot', file, '--frames', '0,10', '--json');
    expect(again).toMatchObject({ code: 0 });
    expect(again.json.ok).toBe(true);

    // A different render (the fake paints the frame number into the red channel, so 10 and 0 differ by 10).
    writeFileSync(join(file, '..', '__snapshots__', 'scene.f10.png'), solidPng(4, 4, [0, 0, 0, 255]));
    const changed = await cli('snapshot', file, '--frames', '0,10', '--json');
    expect(changed.code).toBe(1);
    expect(changed.json.results[1]).toMatchObject({ frame: 10, status: 'mismatch', maxDiff: 10 });
  });
});

describe('audio analyze', () => {
  it('mixes the project\'s audio and measures it', async () => {
    onFrame(0, (ctx, t) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 997;
      gain.gain.value = 0.1;
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 3);
    });
    seam.override = () => fakeProject();
    const r = await cli('audio', 'analyze', 'index.tsx', '--range', '0..90', '--scenes', '0..30,30..90', '--json');
    expect(r.code).toBe(0);
    expect(r.json.integratedLufs).toBeCloseTo(-20, 0);
    expect(r.json.truePeakDb).toBeCloseTo(-20, 0);
    expect(r.json.clippedSamples).toBe(0);
    expect(r.json.scenes).toHaveLength(2);
    expect(r.json.scenes[1]).toMatchObject({ from: 1, to: 3, fromFrame: 30, toFrame: 90 });
    expect(r.json.scenes[0]).toMatchObject({ fromFrame: 0, toFrame: 30 });
    expect(r.json.durationSeconds).toBe(3);
  });

  it('says NO_AUDIO for a project without any', async () => {
    seam.override = () => fakeProject();
    const r = await cli('audio', 'analyze', 'index.tsx', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('NO_AUDIO');
  });

  it('prints silence as null in JSON', async () => {
    onFrame(0, () => {});
    seam.override = () => fakeProject();
    const r = await cli('audio', 'analyze', 'index.tsx', '--json');
    expect(r.json.integratedLufs).toBeNull();
    expect(r.json.truePeakDb).toBeNull();
    expect(r.json.silences).toEqual([{ start: 0, end: 3 }]);
  });
});
