// `render --sequence`: one image file per frame instead of a video. The addon is a fake (test/helpers.ts) and so is the
// project; the parallel test runs the real `renderInParallel` and `render-worker` with `Worker` replaced by an
// in-process stand-in, so the same files must come out of one worker and of several. Pixels are for the M4.

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOnFrame, onFrame } from '@kinetographdev/audio';
import type { AudioClipJson, SceneJson } from '@kinetographdev/scene';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { LABEL_FONT_PATH } from '../src/scenes.js';
import { fakeNative, type Calls } from './helpers.js';

// Small chunks, so a short range is shared between workers. Read when parallel-render.ts is first imported.
const chunk = vi.hoisted(() => (process.env.KINETOGRAPH_CHUNK = '4'));

const seam = vi.hoisted(() => ({ override: undefined as undefined | ((entry: string) => unknown), fake: undefined as unknown }));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.override?.(entry) ?? actual.openSource(entry, options) };
});

// `Worker` runs render-worker.ts in this process, with a message port of its own and the fake addon.
const port = vi.hoisted(() => ({ parentPort: undefined as unknown, workerData: undefined as unknown, spawned: 0, queue: Promise.resolve() }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWorker extends EventEmitter {
    private readonly inbox = new EventEmitter();
    constructor(_url: unknown, options: { workerData: unknown }) {
      super();
      port.spawned += 1;
      const outbox = this;
      const parentPort = {
        postMessage: (message: unknown) => setImmediate(() => outbox.emit('message', structuredClone(message))),
        on: (event: string, listener: (message: unknown) => void) => outbox.inbox.on(event, listener),
      };
      // One module evaluation at a time: it reads `parentPort` and `workerData` as it is evaluated.
      port.queue = port.queue.then(async () => {
        vi.resetModules();
        port.parentPort = parentPort;
        port.workerData = options.workerData;
        (await import('../src/native.js')).setNativeForTests(seam.fake as never);
        await import('../src/render-worker.js');
      });
    }
    postMessage(message: unknown): void {
      setImmediate(() => this.inbox.emit('message', structuredClone(message)));
    }
    async terminate(): Promise<void> {}
  }
  return {
    Worker: FakeWorker,
    get parentPort() {
      return port.parentPort;
    },
    get workerData() {
      return port.workerData;
    },
  };
});

let calls: Calls;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-seq-test-'));

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

const sceneObject = (over: Partial<SceneJson> = {}): SceneJson => ({
  width: 64, height: 36, fps: 30, durationInFrames: 120, background: '#000',
  fonts: { 'DM Sans': LABEL_FONT_PATH },
  layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
  ...over,
});

/** A project stand-in: each frame's scene carries the frame number in a layer id; 120 frames, so frame numbers have 3 digits. */
function fakeProject(options: { audio?: (frame: number) => AudioClipJson[]; failAt?: number; unsupportedAt?: number; notes?: string[]; artifacts?: { filename: string; content: string; frame: number }[] } = {}): Source {
  const dir = scratch();
  return {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 120, defaultProps: {} },
    worker: { entry: join(dir, 'index.tsx'), comp: 'Main', bundleFile: join(dir, 'bundle.js') },
    async frame(frame) {
      if (frame === options.failAt) throw new Error('component threw');
      const scene = sceneObject({ layers: [{ id: `frame-${frame}`, type: 'shape', shape: { kind: 'rect', width: 8, height: 8 }, fill: '#fff' }] });
      return { sceneJson: JSON.stringify(scene), audio: options.audio?.(frame) ?? [],
        unsupported: frame === options.unsupportedAt ? [{ path: '$0 <div>', element: 'div', property: 'filter', value: 'blur(2px)', reason: 'not drawn' }] : [],
        jsMs: 2,
        stringifyMs: 0.5,
      };
    },
    notes: () => options.notes ?? [],
    artifacts: () => (options.artifacts ?? []) as never,
    clearArtifacts() {},
    dispose() {},
  };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const startsWith = (file: string, magic: number[]): boolean => [...readFileSync(file).subarray(0, magic.length)].every((b, i) => b === magic[i]);
const files = (dir: string): string[] => readdirSync(dir).sort();

beforeEach(() => {
  port.spawned = 0;
  const fake = fakeNative();
  calls = fake.calls;
  seam.fake = fake.native;
  setNativeForTests(fake.native);
  seam.override = () => fakeProject();
  clearOnFrame();
});
afterEach(() => {
  setNativeForTests(undefined);
  seam.override = undefined;
  clearOnFrame();
});

describe('render --sequence flags', () => {
  it.each([
    [['--codec', 'h264'], '--codec'],
    [['--encoder', 'libx264'], '--encoder'],
    [['--crf', '20'], '--crf'],
    [['--x264-preset', 'slow'], '--x264-preset'],
    [['--video-bitrate', '8M'], '--video-bitrate'],
    [['--pixel-format', 'yuv444p'], '--pixel-format'],
    [['--prores-profile', 'hq'], '--prores-profile'],
    [['--audio-codec', 'aac'], '--audio-codec'],
    [['--audio-bitrate', '320k'], '--audio-bitrate'],
    [['--every-nth-frame', '2'], '--every-nth-frame'],
  ])('refuses %j before the project is opened or a frame is drawn', async (flags, name) => {
    let opened = false;
    seam.override = () => {
      opened = true;
      return fakeProject();
    };
    const r = await cli('render', 'index.tsx', '--sequence', '-o', join(scratch(), 'frames'), ...flags, '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('INVALID_ARG');
    expect(r.json.error.message).toContain(name);
    expect(r.json.error.message).toContain('--sequence');
    expect(opened).toBe(false);
    expect(calls.still).toHaveLength(0);
    expect(calls.begun).toHaveLength(0);
  });

  it('refuses an unknown --image-format, and --image-format without --sequence', async () => {
    const dir = join(scratch(), 'frames');
    const bad = await cli('render', 'index.tsx', '--sequence', '--image-format', 'tiff', '-o', dir, '--json');
    expect(bad.json.error).toMatchObject({ code: 'INVALID_ARG' });
    expect(bad.json.error.message).toContain('png');
    expect(bad.json.error.message).toContain('jpeg');
    const alone = await cli('render', 'index.tsx', '--image-format', 'png', '-o', join(scratch(), 'v.mp4'), '--json');
    expect(alone.json.error).toMatchObject({ code: 'INVALID_ARG' });
    expect(alone.json.error.message).toContain('--sequence');
    expect(calls.still).toHaveLength(0);
  });

  it('refuses an -o that is a file or looks like one, before the project is opened', async () => {
    let opened = false;
    seam.override = () => {
      opened = true;
      return fakeProject();
    };
    const dir = scratch();
    const file = join(dir, 'taken');
    writeFileSync(file, 'x');
    for (const out of [file, join(dir, 'v.mp4'), join(dir, 'frame.png'), join(dir, 'x.JPEG')]) {
      const r = await cli('render', 'index.tsx', '--sequence', '-o', out, '--json');
      expect(r.code).toBe(1);
      expect(r.json.error).toMatchObject({ code: 'INVALID_ARG' });
      expect(r.json.error.message).toContain('--sequence');
    }
    expect(opened).toBe(false);
    expect(existsSync(join(dir, 'v.mp4'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('does not ask the addon to plan a video, and keeps --scale and --draft', async () => {
    const resolved = vi.fn();
    const fake = fakeNative({ resolveExport: resolved });
    setNativeForTests(fake.native);
    const dir = join(scratch(), 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--draft', '--range', '0..2', '-o', dir, '--json');
    expect(r.code).toBe(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(fake.calls.begun).toHaveLength(0);
    expect(fake.calls.still[0]!.scene).toMatchObject({ width: 32, height: 18, layers: [{ type: 'group', transform: { scale: 0.5 } }] });
    expect(r.json).toMatchObject({ width: 32, height: 18 });
  });
});

describe('render --sequence', () => {
  it('writes one PNG per frame, named by the absolute frame number padded to the last frame of the composition', async () => {
    const dir = join(scratch(), 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--range', '10..14', '-o', dir, '--json');
    expect(r.code).toBe(0);
    expect(files(dir)).toEqual(['Main-010.png', 'Main-011.png', 'Main-012.png', 'Main-013.png']);
    for (const f of files(dir)) expect(startsWith(join(dir, f), PNG_MAGIC)).toBe(true);
    expect(calls.still.map((s) => s.frame)).toEqual([10, 11, 12, 13]);
    expect(JSON.stringify(calls.still[2]!.scene)).toContain('frame-12');
    expect(calls.preview).toHaveLength(0);
    expect(calls.begun).toHaveLength(0);
    expect(r.json).toMatchObject({ output: dir, frames: 4, first: 10, last: 13, width: 64, height: 36, fps: 30, codec: 'png', audio: false });
  });

  it('writes JPEGs with --image-format jpeg', async () => {
    const dir = join(scratch(), 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--image-format', 'jpeg', '--range', '98..=100', '-o', dir, '--json');
    expect(r.code).toBe(0);
    expect(files(dir)).toEqual(['Main-098.jpeg', 'Main-099.jpeg', 'Main-100.jpeg']);
    for (const f of files(dir)) expect(startsWith(join(dir, f), JPEG_MAGIC)).toBe(true);
    expect(calls.preview.map((p) => p.frame)).toEqual([98, 99, 100]);
    expect(calls.preview[0]!.options).toMatchObject({ format: 'jpeg' });
    expect(calls.still).toHaveLength(0);
    expect(r.json.codec).toBe('jpeg');
  });

  it('numbers the whole composition from 0 and creates the folder', async () => {
    const dir = join(scratch(), 'a', 'b');
    const r = await cli('render', 'index.tsx', '--sequence', '-o', dir, '--json');
    expect(r.code).toBe(0);
    const names = files(dir);
    expect(names).toHaveLength(120);
    expect(names[0]).toBe('Main-000.png');
    expect(names[119]).toBe('Main-119.png');
  });

  it('draws a .json scene frame by frame too', async () => {
    seam.override = undefined;
    const scene = join(scratch(), 'scene.json');
    writeFileSync(scene, JSON.stringify(sceneObject({ durationInFrames: 12 })));
    const dir = join(scratch(), 'frames');
    const r = await cli('render', scene, '--sequence', '--range', '8..', '-o', dir, '--json');
    expect(r.code).toBe(0);
    expect(files(dir)).toEqual(['scene-08.png', 'scene-09.png', 'scene-10.png', 'scene-11.png']);
    expect(calls.render).toHaveLength(0);
  });

  it('warns that audio is not written when the frames have sound, and says nothing when they have none', async () => {
    const clip: AudioClipJson = { id: 'music', src: 'm.wav', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false };
    seam.override = () => fakeProject({ audio: () => [clip] });
    // Progress goes to stderr, and not with --json.
    const loud = await cli('render', 'index.tsx', '--sequence', '--range', '0..2', '--concurrency', '1', '-o', join(scratch(), 'f'));
    expect(loud.code).toBe(0);
    expect(loud.err).toContain('audio is not written');
    expect(loud.text).toContain('no audio');
    // --json hides progress, so the result carries the warning.
    const json = await cli('render', 'index.tsx', '--sequence', '--range', '0..2', '--concurrency', '1', '-o', join(scratch(), 'f'), '--json');
    expect(json.json.warnings).toEqual([expect.stringContaining('audio is not written')]);
    const workers = await cli('render', 'index.tsx', '--sequence', '--range', '0..9', '--concurrency', '2', '-o', join(scratch(), 'f'));
    expect(workers.err).toContain('audio is not written');
    seam.override = () => fakeProject();
    const quiet = await cli('render', 'index.tsx', '--sequence', '--range', '0..2', '-o', join(scratch(), 'f'));
    expect(quiet.code).toBe(0);
    expect(quiet.err).not.toContain('audio');
    const quietJson = await cli('render', 'index.tsx', '--sequence', '--range', '0..2', '-o', join(scratch(), 'f'), '--json');
    expect(quietJson.json.warnings).toEqual([]);
    onFrame(1, () => {});
    const synth = await cli('render', 'index.tsx', '--sequence', '--range', '0..2', '-o', join(scratch(), 'f'));
    expect(synth.err).toContain('audio is not written');
  });

  it('stops at a frame that fails, keeping the files written before it', async () => {
    seam.override = () => fakeProject({ failAt: 2 });
    const dir = join(scratch(), 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--range', '0..5', '--concurrency', '1', '-o', dir, '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.message).toBe('component threw');
    expect(files(dir)).toEqual(['Main-000.png', 'Main-001.png']);
  });
});

describe('render --sequence artifacts and --strict', () => {
  it('writes <Artifact> files beside the folder, so the frames folder holds frames only', async () => {
    seam.override = () =>
      fakeProject({ artifacts: [{ filename: 'notes.txt', content: 'hello', frame: 11 }, { filename: 'thumb.png', content: 'thumbnail', frame: 12 }] });
    const parent = scratch();
    const dir = join(parent, 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--range', '10..14', '--concurrency', '1', '-o', dir, '--json');
    expect(r.code).toBe(0);
    expect(r.json.artifacts).toEqual(['notes.txt', 'thumb.png']);
    expect(readFileSync(join(parent, 'notes.txt'), 'utf8')).toBe('hello');
    expect(existsSync(join(parent, 'thumb.png'))).toBe(true);
    expect(files(dir)).toEqual(['Main-010.png', 'Main-011.png', 'Main-012.png', 'Main-013.png']);
  });

  it('--strict with workers fails on the first frame with unsupported content, with only the frames before it written', async () => {
    seam.override = () => fakeProject({ unsupportedAt: 25 });
    const dir = join(scratch(), 'frames');
    const r = await cli('render', 'index.tsx', '--sequence', '--strict', '--range', '10..=45', '--concurrency', '3', '-o', dir, '--json');
    expect(port.spawned).toBe(3);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('UNSUPPORTED_CONTENT');
    expect(r.json.error.message).toContain('frame 25');
    expect(files(dir)).toEqual(Array.from({ length: 15 }, (_, i) => `Main-0${10 + i}.png`));
  });
});

describe('render (video) --concurrency', () => {
  it('feeds the writer every frame once, in order, from the workers', async () => {
    const r = await cli('render', 'index.tsx', '--range', '10..=45', '--concurrency', '3', '-o', join(scratch(), 'p.mp4'), '--json');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(port.spawned).toBe(3);
    // Pushed by frame number, as this thread pushes its own frames when it draws the rest.
    expect(calls.yuv.map((y) => y.index)).toEqual(Array.from({ length: 36 }, (_, i) => 10 + i));
    // The frame the worker drew at each: frame 10 + its place.
    expect(calls.yuv.map((y) => (y.data[0]! << 8) | y.data[1]!)).toEqual(Array.from({ length: 36 }, (_, i) => 10 + i));
    expect(calls.finished).toEqual([undefined]);
    expect(calls.pushed).toHaveLength(0);
  });
});

describe('render --sequence --concurrency', () => {
  const run3 = async (format: string, concurrency: number) => {
    const dir = join(scratch(), `frames-${concurrency}`);
    const r = await cli('render', 'index.tsx', '--sequence', '--image-format', format, '--range', '10..=45', '--concurrency', String(concurrency), '-o', dir, '--json');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    return { dir, json: r.json };
  };

  it.each(['png', 'jpeg'])('writes the same %s files as one worker', async (format) => {
    const serial = await run3(format, 1);
    expect(port.spawned).toBe(0);
    const parallel = await run3(format, 3);
    expect(port.spawned).toBe(3);
    const names = files(serial.dir);
    expect(names).toHaveLength(36);
    expect(files(parallel.dir)).toEqual(names);
    for (const name of names) expect(readFileSync(join(parallel.dir, name)).equals(readFileSync(join(serial.dir, name)))).toBe(true);
    expect(existsSync(join(parallel.dir, `Main-045.${format === 'png' ? 'png' : 'jpeg'}`))).toBe(true);
    expect(parallel.json).toMatchObject({ frames: 36, first: 10, last: 45 });
  });
});
