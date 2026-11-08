import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadVideoMattingModel,
  removeVideoMattingModel,
  separateVideoLayers,
  VideoMattingError,
  type SeparateVideoLayersProgress,
  type StreamTargetChunk,
} from '../src/index.js';
import { resetVideoMattingForTests, setAddonForTests, setFetchForTests, setModelsForTests } from '../src/testing.js';
import { BYTES, fakeAddon, fakeModels, serve, tempDir } from './helpers.js';

let dir: string;
let video: string;
const before = process.env.KINETOGRAPH_MODEL_DIR;

beforeEach(async () => {
  resetVideoMattingForTests();
  dir = tempDir();
  process.env.KINETOGRAPH_MODEL_DIR = join(dir, 'models');
  setModelsForTests(fakeModels());
  setFetchForTests(serve(BYTES, { urls: [], ranges: [] }));
  await downloadVideoMattingModel({ model: 'modnet' });
  video = join(dir, 'in.mp4');
  writeFileSync(video, 'not really a video; the addon is a fake');
});

afterEach(() => {
  resetVideoMattingForTests();
  if (before === undefined) delete process.env.KINETOGRAPH_MODEL_DIR;
  else process.env.KINETOGRAPH_MODEL_DIR = before;
});

const failure = async (p: Promise<unknown>): Promise<VideoMattingError> => (await p.then(() => undefined, (e: unknown) => e)) as VideoMattingError;

describe('separateVideoLayers() through the addon', () => {
  it('gives Remotion\'s result: base and foreground blobs, model, size, duration, frames, and disposes', async () => {
    const addon = fakeAddon({ frames: 4 });
    setAddonForTests(addon);
    const progress: SeparateVideoLayersProgress[] = [];
    const result = await separateVideoLayers({ src: video, onProgress: (p) => progress.push(p) });
    expect(result).toMatchObject({ model: 'modnet', width: 640, height: 360, durationInSeconds: 2, processedFrames: 4, backend: 'cpu' });
    expect(await (await result.foreground.getBlob()).text()).toBe('FOREGROUND-ALPHA');
    expect((await result.base.getBlob()).type).toBe('video/webm');
    expect(await (await result.base.getBlob()).text()).toBe('BASE');

    expect(progress.map((p) => [p.stage, p.progress, p.processedFrames])).toEqual([
      ['processing', 0.25, 1],
      ['processing', 0.5, 2],
      ['processing', 0.75, 3],
      ['processing', 1, 4],
      ['finalizing', null, 4],
    ]);
    expect(progress[1]).toMatchObject({ processedDurationInSeconds: 1, durationInSeconds: 2 });

    // What the addon was asked: the downloaded model, the defaults of Remotion (modnet, audio on the base, very-high), WebM outputs.
    const [call] = addon.calls;
    expect(call).toMatchObject({ input: video, model: 'modnet', keepAudio: true, quality: 'very-high', audio: 'base' });
    expect(call!.modelPath).toContain(join('modnet-' + 'a'.repeat(12), 'model.onnx'));
    expect(call!.foreground.endsWith('.webm') && call!.base!.endsWith('.webm')).toBe(true);

    const files = [call!.foreground, call!.base!];
    await result.foreground.dispose();
    await result.foreground.dispose();
    expect(files.map(existsSync)).toEqual([false, true]);
    await result[Symbol.asyncDispose]();
    expect(files.map(existsSync)).toEqual([false, false]);
    await expect(result.foreground.getBlob()).rejects.toThrow();
  });

  it('maps the options: model, audio, bit rate presets and numbers, keyframes', async () => {
    const addon = fakeAddon();
    setAddonForTests(addon);
    setFetchForTests(serve(BYTES, { urls: [], ranges: [] }));
    await downloadVideoMattingModel({ model: 'ben2-base' });
    for (const [videoBitrate, quality] of [['very-low', 'very-low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['very-high', 'very-high'], [400_000, 'very-low'], [900_000, 'low'], [3_000_000, 'medium'], [8_000_000, 'high'], [20_000_000, 'very-high']] as const) {
      await using r = await separateVideoLayers({ src: video, model: 'ben2-base', audio: 'none', videoBitrate, audioBitrate: 'low', keyframeIntervalInSeconds: 2 });
      const call = addon.calls.at(-1)!;
      expect(call).toMatchObject({ model: 'ben2-base', keepAudio: false, audio: 'none', quality, audioBitrate: 'low', keyframeIntervalInSeconds: 2 });
      expect(call.videoBitrate).toBe(typeof videoBitrate === 'number' ? videoBitrate : undefined);
      expect(r.model).toBe('ben2-base');
    }
    for (const audio of ['foreground', 'both'] as const) {
      await using _r = await separateVideoLayers({ src: video, audio });
      expect(addon.calls.at(-1)).toMatchObject({ keepAudio: true, audio });
    }
  });

  it('writes to the paths given, through a partial file that is renamed, and keeps them on dispose', async () => {
    const addon = fakeAddon();
    setAddonForTests(addon);
    const foreground = join(dir, 'out', 'fg.webm');
    const base = join(dir, 'out', 'base.mov');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'out'));
    const result = await separateVideoLayers({ src: video, outputs: { foreground: { path: foreground }, base: { path: base } } });
    const call = addon.calls[0]!;
    expect(call.foreground).not.toBe(foreground);
    expect(call.foreground.endsWith('.webm')).toBe(true);
    expect(call.base!.endsWith('.mov')).toBe(true);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['base.mov', 'fg.webm']);
    expect(result.foreground.path).toBe(foreground);
    expect((await result.base.getBlob()).type).toBe('video/quicktime');
    await result[Symbol.asyncDispose]();
    expect(readFileSync(foreground, 'utf8')).toBe('FOREGROUND-ALPHA');
    expect(readFileSync(base, 'utf8')).toBe('BASE');
  });

  it('skips the base with outputs.base: false', async () => {
    const addon = fakeAddon();
    setAddonForTests(addon);
    const result = await separateVideoLayers({ src: video, outputs: { base: false } });
    expect(result.base).toBeNull();
    expect(addon.calls[0]!.base).toBeUndefined();
    await result[Symbol.asyncDispose]();
  });

  it('streams a layer into outputWritable in positioned chunks, and getBlob() rejects for it', async () => {
    setAddonForTests(fakeAddon());
    const chunks: StreamTargetChunk[] = [];
    let closed = false;
    const writable = new WritableStream<StreamTargetChunk>({ write: (c) => void chunks.push(c), close: () => void (closed = true) });
    const result = await separateVideoLayers({ src: video, outputs: { foreground: { outputWritable: writable } } });
    expect(closed).toBe(true);
    expect(chunks.map((c) => [c.type, c.position, Buffer.from(c.data).toString()])).toEqual([['write', 0, 'FOREGROUND-ALPHA']]);
    await expect(result.foreground.getBlob()).rejects.toThrow('outputWritable');
    expect(await (await result.base.getBlob()).text()).toBe('BASE');
    await result[Symbol.asyncDispose]();
  });

  it('takes a Blob, a file: URL and a relative path as src, and an http(s) URL by downloading it', async () => {
    const addon = fakeAddon();
    setAddonForTests(addon);
    await (await separateVideoLayers({ src: new Blob(['blob bytes']) }))[Symbol.asyncDispose]();
    const fromBlob = addon.calls.at(-1)!.input;
    expect(existsSync(fromBlob)).toBe(false); // the temporary copy is removed after the job

    await (await separateVideoLayers({ src: new URL(`file://${video}`) }))[Symbol.asyncDispose]();
    expect(addon.calls.at(-1)!.input).toBe(video);
    await (await separateVideoLayers({ src: `file://${video}` }))[Symbol.asyncDispose]();
    expect(addon.calls.at(-1)!.input).toBe(video);

    setFetchForTests(serve(Buffer.from('remote bytes'), { urls: [], ranges: [] }));
    await (await separateVideoLayers({ src: 'https://example.com/clip.mov' }))[Symbol.asyncDispose]();
    expect(addon.calls.at(-1)!.input.endsWith('input.mov')).toBe(true);
  });

  it('refuses bad options before running anything', async () => {
    const addon = fakeAddon();
    setAddonForTests(addon);
    const cases: [string, Parameters<typeof separateVideoLayers>[0], RegExp][] = [
      ['model', { src: video, model: 'rvm' as never }, /Unknown video matting model/],
      ['audio', { src: video, audio: 'left' as never }, /audio must be one of/],
      ['videoBitrate', { src: video, videoBitrate: 'max' as never }, /videoBitrate must be/],
      ['videoBitrate 0', { src: video, videoBitrate: 0 }, /videoBitrate must be/],
      ['audioBitrate', { src: video, audioBitrate: 1.5 }, /audioBitrate must be/],
      ['keyframes', { src: video, keyframeIntervalInSeconds: 0 }, /keyframeIntervalInSeconds/],
      ['web-fs', { src: video, outputs: { foreground: { outputTarget: 'web-fs' } } }, /web-fs/],
      ['combined', { src: video, outputs: { base: { outputTarget: 'arraybuffer', path: join(dir, 'b.webm') } } }, /cannot be combined/],
      ['extension', { src: video, outputs: { foreground: { path: join(dir, 'fg.mp4') } } }, /\.webm .* \.mov/],
      ['missing file', { src: join(dir, 'nope.mp4') }, /does not exist/],
    ];
    for (const [name, options, message] of cases) {
      const error = await failure(separateVideoLayers(options));
      expect(error, name).toBeInstanceOf(VideoMattingError);
      expect(error.message, name).toMatch(message);
    }
    expect(addon.calls).toHaveLength(0);
  });

  it('says what is missing: the download, matting in the build, a backend', async () => {
    setAddonForTests(fakeAddon());
    await removeVideoMattingModel({ model: 'modnet' });
    expect((await failure(separateVideoLayers({ src: video }))).code).toBe('MODEL_NOT_DOWNLOADED');

    setFetchForTests(serve(BYTES, { urls: [], ranges: [] }));
    await downloadVideoMattingModel({ model: 'modnet' });
    setAddonForTests({});
    const none = await failure(separateVideoLayers({ src: video }));
    expect(none.code).toBe('MATTING_UNAVAILABLE');
    expect(none.message).toBe("Video matting isn't in this build of @kinetographdev/native; install a version that includes it");
    setAddonForTests(null);
    expect((await failure(separateVideoLayers({ src: video }))).code).toBe('MATTING_UNAVAILABLE');
    setAddonForTests(fakeAddon({ available: false }));
    expect((await failure(separateVideoLayers({ src: video }))).message).toContain('no backend here');
  });

  it('removes its temporary files when the addon fails, and rethrows', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('kinetograph-matting-'));
    setAddonForTests(fakeAddon({ fail: 'out of memory' }));
    await expect(separateVideoLayers({ src: new Blob(['x']), outputs: { foreground: { path: join(dir, 'fg.webm') } } })).rejects.toThrow('out of memory');
    expect(readdirSync(dir).filter((n) => n.includes('partial'))).toEqual([]);
    expect(existsSync(join(dir, 'fg.webm'))).toBe(false);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('kinetograph-matting-'))).toEqual(before);
  });

  it('rejects at once on abort with the reason, and clears the job\'s files when it ends', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const addon = fakeAddon({ hold });
    setAddonForTests(addon);
    const controller = new AbortController();
    const pending = separateVideoLayers({ src: video, signal: controller.signal, outputs: { foreground: { path: join(dir, 'fg.webm') } } });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir).filter((n) => n.endsWith('.webm'))).toEqual([]);
    await expect(separateVideoLayers({ src: video, signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early');
  });

  it('makes removeVideoMattingModel() wait for a running separation', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    setAddonForTests(fakeAddon({ hold }));
    const running = separateVideoLayers({ src: video });
    await new Promise((r) => setTimeout(r, 20));
    const order: string[] = [];
    const removed = removeVideoMattingModel({ model: 'modnet' }).then(() => order.push('removed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    const result = await running;
    order.push('separated');
    await removed;
    expect(order).toEqual(['separated', 'removed']);
    await result[Symbol.asyncDispose]();
  });
});
