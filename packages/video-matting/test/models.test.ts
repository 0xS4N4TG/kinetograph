import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canUseVideoMatting,
  disposeVideoMattingModel,
  downloadVideoMattingModel,
  getAvailableModels,
  isVideoMattingModelCached,
  loadVideoMattingModel,
  removeVideoMattingModel,
  videoMattingCacheDir,
  VideoMattingError,
  type DownloadProgress,
} from '../src/index.js';
import { resetVideoMattingForTests, setAddonForTests, setFetchForTests, setModelsForTests } from '../src/testing.js';
import { BYTES, fakeAddon, fakeModels, serve, SHA, tempDir, type FetchLog } from './helpers.js';

let dir: string;
let log: FetchLog;
const before = process.env.KINETOGRAPH_MODEL_DIR;

beforeEach(() => {
  resetVideoMattingForTests();
  dir = tempDir();
  process.env.KINETOGRAPH_MODEL_DIR = dir;
  log = { urls: [], ranges: [] };
  setModelsForTests(fakeModels());
});

afterEach(() => {
  resetVideoMattingForTests();
  if (before === undefined) delete process.env.KINETOGRAPH_MODEL_DIR;
  else process.env.KINETOGRAPH_MODEL_DIR = before;
});

const modelFolder = () => join(dir, `modnet-${'a'.repeat(12)}`);
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as VideoMattingError | undefined)?.code;

describe('getAvailableModels()', () => {
  it('lists the two models with their sources, licences and sizes, pinned to commits', async () => {
    resetVideoMattingForTests();
    expect(getAvailableModels()).toEqual([
      { name: 'modnet', modelId: 'Xenova/modnet', purpose: 'People', license: 'Apache-2.0', webGpuDownloadSize: 25_888_640 },
      { name: 'ben2-base', modelId: 'onnx-community/BEN2-ONNX', purpose: 'General foreground subjects', license: 'MIT', webGpuDownloadSize: 219_121_675 },
    ]);
    // Remotion lists 25.9 MB and 219.1 MB.
    expect(getAvailableModels().map((m) => (m.webGpuDownloadSize / 1e6).toFixed(1))).toEqual(['25.9', '219.1']);
  });

  it('downloads the pinned Hugging Face file, not a mirror', async () => {
    resetVideoMattingForTests();
    process.env.KINETOGRAPH_MODEL_DIR = dir;
    setFetchForTests(serve(Buffer.alloc(0), log, { status: 404 }));
    await code(downloadVideoMattingModel({ model: 'modnet' }));
    await code(downloadVideoMattingModel({ model: 'ben2-base' }));
    expect(log.urls).toEqual([
      'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx',
      'https://huggingface.co/onnx-community/BEN2-ONNX/resolve/c552aa82688edce09f0ac9d2e31ad53d9d629010/onnx/model_fp16.onnx',
    ]);
  });
});

describe('the cache directory', () => {
  it('is $KINETOGRAPH_MODEL_DIR when set, else the OS cache directory plus kinetograph/models', () => {
    expect(videoMattingCacheDir()).toBe(dir);
    delete process.env.KINETOGRAPH_MODEL_DIR;
    expect(videoMattingCacheDir().replaceAll('\\', '/')).toMatch(/kinetograph\/models$/);
    if (process.platform === 'darwin') expect(videoMattingCacheDir()).toContain('Library/Caches');
  });
});

describe('downloadVideoMattingModel()', () => {
  it('downloads, verifies the SHA-256, writes atomically and reports progress', async () => {
    setFetchForTests(serve(BYTES, log));
    const progress: DownloadProgress[] = [];
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(false);
    const result = await downloadVideoMattingModel({ model: 'modnet', onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ alreadyDownloaded: false });
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(true);
    expect(readFileSync(join(modelFolder(), 'model.onnx')).equals(BYTES)).toBe(true);
    // No half-written file is left beside the model.
    expect(readdirSync(modelFolder())).toEqual(['model.onnx']);
    const whole = progress.filter((p) => p.file === null);
    expect(whole[0]!.progress).toBeLessThan(0.1);
    expect(whole.at(-1)).toEqual({ file: null, progress: 1, loadedBytes: BYTES.length, totalBytes: BYTES.length });
    expect(progress.some((p) => p.file === 'model.onnx')).toBe(true);
    for (let i = 1; i < whole.length; i++) expect(whole[i]!.progress).toBeGreaterThanOrEqual(whole[i - 1]!.progress);
  });

  it('is a cache hit the second time: no request, alreadyDownloaded', async () => {
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'modnet' });
    const second = await downloadVideoMattingModel({ model: 'modnet', onProgress: () => expect.unreachable() });
    expect(second).toEqual({ alreadyDownloaded: true });
    expect(log.urls).toHaveLength(1);
  });

  it('refuses a download whose SHA-256 differs and leaves nothing in the cache', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[100] ^= 0xff;
    setFetchForTests(serve(tampered, log));
    const error = await downloadVideoMattingModel({ model: 'modnet' }).catch((e: VideoMattingError) => e);
    expect(error).toBeInstanceOf(VideoMattingError);
    expect((error as VideoMattingError).code).toBe('MODEL_CHECKSUM');
    expect((error as VideoMattingError).message).toContain(SHA);
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(false);
    expect(readdirSync(modelFolder())).toEqual([]);
  });

  it('refuses a download of the wrong size', async () => {
    setFetchForTests(serve(BYTES.subarray(0, 8192), log));
    expect(await code(downloadVideoMattingModel({ model: 'modnet' }))).toBe('MODEL_CHECKSUM');
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(false);
  });

  it('treats a file of the wrong size in the cache as not cached', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(modelFolder(), { recursive: true });
    writeFileSync(join(modelFolder(), 'model.onnx'), 'short');
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(false);
  });

  it('reports an HTTP failure and keeps no file', async () => {
    setFetchForTests(serve(BYTES, log, { status: 503 }));
    const error = await downloadVideoMattingModel({ model: 'modnet' }).catch((e: VideoMattingError) => e);
    expect((error as VideoMattingError).code).toBe('MODEL_DOWNLOAD');
    expect((error as VideoMattingError).message).toContain('503');
    expect(existsSync(join(modelFolder(), 'model.onnx'))).toBe(false);
  });

  it('carries on from a partial file after a dropped connection (a range request), and still verifies', async () => {
    setFetchForTests(serve(BYTES, log, { failAfter: 8192 }));
    expect(await code(downloadVideoMattingModel({ model: 'modnet' }))).toBe('MODEL_DOWNLOAD');
    const part = join(modelFolder(), 'model.onnx.part');
    expect(statSync(part).size).toBe(8192);
    expect(existsSync(join(modelFolder(), 'model.onnx'))).toBe(false);

    const progress: DownloadProgress[] = [];
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'modnet', onProgress: (p) => progress.push(p) });
    expect(log.ranges).toEqual([null, 'bytes=8192-']);
    expect(readFileSync(join(modelFolder(), 'model.onnx')).equals(BYTES)).toBe(true);
    expect(existsSync(part)).toBe(false);
    // Progress counts the resumed bytes; loadedBytes only this call's.
    expect(progress[0]!.progress).toBeCloseTo(8192 / BYTES.length, 5);
    expect(progress.at(-1)!.loadedBytes).toBe(BYTES.length - 8192);
  });

  it('starts over when the server ignores the range, and when the partial file is a corrupt prefix', async () => {
    setFetchForTests(serve(BYTES, log, { failAfter: 4096 }));
    await code(downloadVideoMattingModel({ model: 'modnet' }));
    setFetchForTests(serve(BYTES, log, { ignoreRange: true }));
    await downloadVideoMattingModel({ model: 'modnet' });
    expect(readFileSync(join(modelFolder(), 'model.onnx')).equals(BYTES)).toBe(true);

    await removeVideoMattingModel({ model: 'modnet' });
    // A leftover that is not the start of the file fails its checksum, is deleted, and the next call succeeds.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(modelFolder(), { recursive: true });
    writeFileSync(join(modelFolder(), 'model.onnx.part'), Buffer.alloc(4096, 9));
    setFetchForTests(serve(BYTES, log));
    expect(await code(downloadVideoMattingModel({ model: 'modnet' }))).toBe('MODEL_CHECKSUM');
    expect(existsSync(join(modelFolder(), 'model.onnx.part'))).toBe(false);
    await downloadVideoMattingModel({ model: 'modnet' });
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(true);
  });

  it('rejects with the signal\'s reason when aborted, and removes the incomplete file', async () => {
    const controller = new AbortController();
    setFetchForTests(serve(BYTES, log, { stall: controller }));
    const reason = await downloadVideoMattingModel({ model: 'modnet', signal: controller.signal }).catch((e: unknown) => e);
    expect((reason as Error).message).toBe('stopped by the test');
    expect(readdirSync(modelFolder())).toEqual([]);
    // Already aborted: no request at all.
    log.urls.length = 0;
    await expect(downloadVideoMattingModel({ model: 'modnet', signal: AbortSignal.abort(new Error('no')) })).rejects.toThrow('no');
    expect(log.urls).toEqual([]);
  });

  it('serialises two downloads of one model: one request', async () => {
    setFetchForTests(serve(BYTES, log));
    const [a, b] = await Promise.all([downloadVideoMattingModel({ model: 'modnet' }), downloadVideoMattingModel({ model: 'modnet' })]);
    expect([a.alreadyDownloaded, b.alreadyDownloaded].sort()).toEqual([false, true]);
    expect(log.urls).toHaveLength(1);
  });
});

describe('removeVideoMattingModel()', () => {
  it('deletes the model and an unfinished download, and is quiet when there is nothing', async () => {
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'modnet' });
    await removeVideoMattingModel({ model: 'modnet' });
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(false);
    expect(existsSync(modelFolder())).toBe(false);
    await removeVideoMattingModel({ model: 'modnet' });
    // The other model is untouched.
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'ben2-base' });
    await removeVideoMattingModel({ model: 'modnet' });
    expect(await isVideoMattingModelCached({ model: 'ben2-base' })).toBe(true);
  });
});

describe('bad model ids', () => {
  it('are refused by every function, with the valid names in the message', async () => {
    const bad = 'gpt-9' as never;
    for (const call of [
      () => isVideoMattingModelCached({ model: bad }),
      () => downloadVideoMattingModel({ model: bad }),
      () => loadVideoMattingModel({ model: bad }),
      () => removeVideoMattingModel({ model: bad }),
      () => disposeVideoMattingModel({ model: bad }),
      () => canUseVideoMatting({ model: bad }),
    ]) {
      const error = await call().catch((e: VideoMattingError) => e);
      expect((error as VideoMattingError).code).toBe('UNKNOWN_MODEL');
      expect((error as VideoMattingError).message).toContain('modnet, ben2-base');
    }
    expect(await code(isVideoMattingModelCached({} as never))).toBe('UNKNOWN_MODEL');
  });
});

describe('canUseVideoMatting()', () => {
  it('says why not when the addon has no matting, when no backend is available, and when it can be loaded', async () => {
    setAddonForTests({});
    const none = await canUseVideoMatting();
    expect(none).toMatchObject({ supported: false, reason: 'native-unavailable' });
    expect((none as { detailedReason: string }).detailedReason).toContain("isn't in this build");

    setAddonForTests(fakeAddon({ available: false }));
    expect(await canUseVideoMatting({ model: 'ben2-base' })).toEqual({ supported: false, reason: 'backend-unavailable', detailedReason: 'no backend here' });

    setAddonForTests(fakeAddon({ backend: 'coreml' }));
    expect(await canUseVideoMatting()).toEqual({ supported: true, backend: 'coreml' });

    setAddonForTests(null);
    expect(await canUseVideoMatting()).toMatchObject({ supported: false, reason: 'native-unavailable' });
  });
});

describe('loadVideoMattingModel() and disposeVideoMattingModel()', () => {
  it('needs the download first', async () => {
    setAddonForTests(fakeAddon());
    expect(await code(loadVideoMattingModel({ model: 'modnet' }))).toBe('MODEL_NOT_DOWNLOADED');
  });

  it('refuses a build without matting', async () => {
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'modnet' });
    setAddonForTests({});
    const error = await loadVideoMattingModel({ model: 'modnet' }).catch((e: VideoMattingError) => e);
    expect((error as VideoMattingError).code).toBe('MATTING_UNAVAILABLE');
    expect((error as VideoMattingError).message).toContain("isn't in this build");
  });

  it('reports alreadyLoaded, progress, and releases with await using or dispose', async () => {
    setFetchForTests(serve(BYTES, log));
    await downloadVideoMattingModel({ model: 'modnet' });
    setAddonForTests(fakeAddon());
    const seen: unknown[] = [];
    {
      await using first = await loadVideoMattingModel({ model: 'modnet', onProgress: (p) => seen.push(p) });
      expect(first.alreadyLoaded).toBe(false);
      expect(seen).toEqual([
        { status: 'initializing', file: null, progress: null, loadedBytes: null, totalBytes: null },
        { status: 'ready', file: null, progress: 1, loadedBytes: null, totalBytes: null },
      ]);
      const second = await loadVideoMattingModel({ model: 'modnet' });
      expect(second.alreadyLoaded).toBe(true);
      await second[Symbol.asyncDispose]();
      expect((await loadVideoMattingModel({ model: 'modnet' })).alreadyLoaded).toBe(true);
      await disposeVideoMattingModel({ model: 'modnet' });
    }
    // disposeVideoMattingModel released every hold; the file stays.
    expect((await loadVideoMattingModel({ model: 'modnet' })).alreadyLoaded).toBe(false);
    await disposeVideoMattingModel();
    expect(await isVideoMattingModelCached({ model: 'modnet' })).toBe(true);
    expect((await loadVideoMattingModel({ model: 'modnet' })).alreadyLoaded).toBe(false);
  });
});
