import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MattingModule } from '../src/index.js';
import type { MattingJob } from '../src/protocol.js';
import { api, cleanup, Client, start, stopAll, tempDir, tokenOf, until, writeProject } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** A stand-in for @kinetographdev/video-matting: the models, a cache set, and a download or separation the test releases. */
function fakeMatting() {
  const cached = new Set<string>(['modnet']);
  const calls: { fn: string; args: unknown }[] = [];
  let release: ((blob?: Blob) => void) | null = null;
  let fail: Error | null = null;
  let progress: ((p: { stage: 'processing' | 'finalizing'; progress: number | null }) => void) | null = null;
  const disposed: string[] = [];
  const module: MattingModule = {
    async canUseVideoMatting() {
      return { supported: true };
    },
    getAvailableModels: () => [
      { name: 'modnet', modelId: 'Xenova/modnet', purpose: 'people', webGpuDownloadSize: 25_900_000 },
      { name: 'ben2-base', modelId: 'onnx-community/BEN2-ONNX', purpose: 'any foreground subject (experimental)', webGpuDownloadSize: 223_000_000 },
    ],
    async isVideoMattingModelCached({ model }) {
      return cached.has(model);
    },
    async downloadVideoMattingModel({ model, onProgress, signal }) {
      calls.push({ fn: 'download', args: { model } });
      onProgress?.({ file: null, progress: 0.5, loadedBytes: 5, totalBytes: 10 });
      await new Promise<void>((resolve, reject) => {
        release = () => resolve();
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
      cached.add(model);
      return { alreadyDownloaded: false };
    },
    async removeVideoMattingModel({ model }) {
      calls.push({ fn: 'remove', args: { model } });
      cached.delete(model);
    },
    async separateVideoLayers(options) {
      calls.push({ fn: 'separate', args: { ...options, signal: undefined, onProgress: undefined } });
      progress = options.onProgress ?? null;
      options.onProgress?.({ stage: 'processing', progress: 0.25 });
      const blob = await new Promise<Blob>((resolve, reject) => {
        release = (b) => (fail ? reject(fail) : resolve(b ?? new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])])));
        options.signal?.addEventListener('abort', () => reject(options.signal!.reason ?? new Error('aborted')));
      });
      return {
        foreground: { getBlob: async () => blob, dispose: () => void disposed.push('foreground') },
        base: { dispose: () => void disposed.push('base') },
      };
    },
  };
  return {
    module,
    cached,
    calls,
    disposed,
    release: (blob?: Blob) => release?.(blob),
    emit: (p: { stage: 'processing' | 'finalizing'; progress: number | null }) => progress?.(p),
    failWith: (e: Error | null) => (fail = e),
  };
}

let dir: string;
let video: string;
beforeAll(() => {
  dir = writeProject('Matting').dir;
  video = join(dir, 'public', 'person.mp4');
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(video, 'not really a video');
});
afterEach(async () => {
  await stopAll();
});
afterAll(() => cleanup());

async function boot(loader: () => Promise<MattingModule>) {
  const server = await start(join(dir, 'index.tsx'), { matting: loader });
  const h = { headers: { 'X-Studio-Token': tokenOf(server)! } };
  const get = (path: string) => api(server, path, h);
  const post = (path: string, json?: unknown) => api(server, path, { ...h, method: 'POST', json: json ?? {} });
  const del = (path: string) => api(server, path, { ...h, method: 'DELETE' });
  return { server, get, post, del };
}

const called = (fake: ReturnType<typeof fakeMatting>, fn: string) => until(() => fake.calls.some((c) => c.fn === fn), (found) => found);

describe('matting routes', () => {
  it('needs the window token', async () => {
    const fake = fakeMatting();
    const { server } = await boot(async () => fake.module);
    expect((await api(server, '/api/matting')).status).toBe(403);
    expect((await api(server, '/api/matting', { headers: { 'X-Studio-Token': 'x'.repeat(64) } })).status).toBe(403);
  });

  it('lists the models with their size and whether they are cached', async () => {
    const fake = fakeMatting();
    const { get } = await boot(async () => fake.module);
    const r = await get('/api/matting');
    expect(r.status).toBe(200);
    expect(r.json.available).toBe(true);
    expect(r.json.models).toEqual([
      { name: 'modnet', modelId: 'Xenova/modnet', purpose: 'people', size: 25_900_000, cached: true },
      { name: 'ben2-base', modelId: 'onnx-community/BEN2-ONNX', purpose: 'any foreground subject (experimental)', size: 223_000_000, cached: false },
    ]);
  });

  it('says so in plain words when this build has no matting', async () => {
    const { get, post } = await boot(async () => {
      throw new Error("Cannot find package '@kinetographdev/video-matting'");
    });
    const r = await get('/api/matting');
    expect(r.status).toBe(200);
    expect(r.json.available).toBe(false);
    expect(r.json.message).toMatch(/not in this build/);
    expect(r.json.models).toEqual([]);
    const job = await post('/api/matting/jobs', { input: video, output: 'x.webm' });
    expect(job.status).toBe(501);
    expect(job.json.error.code).toBe('UNAVAILABLE');
  });

  it('says why when the computer cannot run the model', async () => {
    const fake = fakeMatting();
    fake.module.canUseVideoMatting = async () => ({ supported: false, reason: 'webgpu-unavailable', detailedReason: 'no adapter' });
    const { get } = await boot(async () => fake.module);
    const r = await get('/api/matting');
    expect(r.json.available).toBe(false);
    expect(r.json.message).toBe('This computer has no GPU the background-removal model can run on. no adapter');
    expect(r.json.models).toHaveLength(2);
  });

  it('downloads a model as a job with progress, and the model is cached after', async () => {
    const fake = fakeMatting();
    const { server, get, post } = await boot(async () => fake.module);
    const client = await Client.connect(server);
    const started = await post('/api/matting/models/ben2-base');
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ kind: 'download', model: 'ben2-base', status: 'running', stage: 'downloading' });
    await client.waitForMessage('matting', (m) => m.job.progress === 0.5);
    expect((await post('/api/matting/models/ben2-base')).status).toBe(400); // already running
    fake.release();
    await client.waitForMessage('matting', (m) => m.job.status === 'done');
    expect((await get('/api/matting')).json.models[1].cached).toBe(true);
    client.close();
  });

  it('cancels a download, and refuses an unknown model', async () => {
    const fake = fakeMatting();
    const { post, del } = await boot(async () => fake.module);
    const job = (await post('/api/matting/models/ben2-base')).json as MattingJob;
    const cancelled = await del(`/api/matting/jobs/${job.id}`);
    expect(cancelled.json.status).toBe('cancelled');
    expect(fake.cached.has('ben2-base')).toBe(false);
    expect((await post('/api/matting/models/nope')).status).toBe(400);
    expect((await del('/api/matting/jobs/99')).status).toBe(404);
  });

  it('removes a model, but not one a job is using', async () => {
    const fake = fakeMatting();
    const { post, del, get } = await boot(async () => fake.module);
    expect((await del('/api/matting/models/modnet')).status).toBe(200);
    expect(fake.calls).toContainEqual({ fn: 'remove', args: { model: 'modnet' } });
    expect((await get('/api/matting')).json.models[0].cached).toBe(false);
    await post('/api/matting/models/modnet');
    expect((await del('/api/matting/models/modnet')).status).toBe(400);
  });

  it('removes a background: runs the package, reports progress, and writes the WebM into public/', async () => {
    const fake = fakeMatting();
    const { server, post, get } = await boot(async () => fake.module);
    const client = await Client.connect(server);
    const started = await post('/api/matting/jobs', { input: video, output: 'person-no-background.webm', quality: 'high', audio: 'drop' });
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ kind: 'matte', model: 'modnet', status: 'running', stage: 'processing', output: 'public/person-no-background.webm', staticName: 'person-no-background.webm' });
    await client.waitForMessage('matting', (m) => m.job.progress === 0.25);
    fake.emit({ stage: 'finalizing', progress: null });
    await client.waitForMessage('matting', (m) => m.job.stage === 'finalizing' && m.job.progress === null);
    fake.release();
    await client.waitForMessage('matting', (m) => m.job.status === 'done' && m.job.error === null);
    expect([...readFileSync(join(dir, 'public/person-no-background.webm'))]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(fake.calls.find((c) => c.fn === 'separate')!.args).toMatchObject({ src: video, model: 'modnet', audio: 'none', videoBitrate: 'high' });
    expect(fake.disposed.sort()).toEqual(['base', 'foreground']);
    // A window that opens later finds the job in the status.
    expect((await get('/api/matting')).json.jobs.at(-1).status).toBe('done');
    client.close();
  });

  it('keeps the original audio by default (the foreground carries it) at very-high quality', async () => {
    const fake = fakeMatting();
    const { post } = await boot(async () => fake.module);
    await post('/api/matting/jobs', { input: video, output: 'a.webm' });
    await called(fake, 'separate');
    expect(fake.calls.find((c) => c.fn === 'separate')!.args).toMatchObject({ audio: 'foreground', videoBitrate: 'very-high' });
  });

  it('downloads a model that is not cached before it separates', async () => {
    const fake = fakeMatting();
    const { server, post } = await boot(async () => fake.module);
    const client = await Client.connect(server);
    const started = await post('/api/matting/jobs', { input: video, output: 'b.webm', model: 'ben2-base' });
    expect(started.json.stage).toBe('downloading');
    await client.waitForMessage('matting', (m) => m.job.progress === 0.5);
    fake.release(); // the download
    await called(fake, 'separate');
    fake.release();
    await client.waitForMessage('matting', (m) => m.job.status === 'done');
    client.close();
  });

  it('fails the job with the error of the package, and writes nothing', async () => {
    const fake = fakeMatting();
    fake.failWith(new Error('the decoder gave up'));
    const { server, post } = await boot(async () => fake.module);
    const client = await Client.connect(server);
    await post('/api/matting/jobs', { input: video, output: 'c.webm' });
    await called(fake, 'separate');
    fake.release();
    await client.waitForMessage('matting', (m) => m.job.status === 'failed' && m.job.error?.message === 'the decoder gave up');
    expect(existsSync(join(dir, 'public/c.webm'))).toBe(false);
    client.close();
  });

  it('cancels a running separation and writes nothing', async () => {
    const fake = fakeMatting();
    const { post, del, get } = await boot(async () => fake.module);
    const job = (await post('/api/matting/jobs', { input: video, output: 'd.webm' })).json as MattingJob;
    expect((await post('/api/matting/jobs', { input: video, output: 'e.webm' })).status).toBe(400); // one at a time
    expect((await del(`/api/matting/jobs/${job.id}`)).json.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dir, 'public/d.webm'))).toBe(false);
    expect((await get('/api/matting')).json.jobs.find((j: MattingJob) => j.id === job.id).status).toBe('cancelled');
  });

  it('refuses bad requests and never writes outside public/', async () => {
    const fake = fakeMatting();
    const { post } = await boot(async () => fake.module);
    const bad = async (body: unknown, pattern: RegExp) => {
      const r = await post('/api/matting/jobs', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toMatch(pattern);
    };
    await bad({ input: 'person.mp4', output: 'x.webm' }, /absolute path/);
    await bad({ input: join(dir, 'missing.mp4'), output: 'x.webm' }, /no such video/);
    for (const output of ['../x.webm', 'a/../../x.webm', '/etc/x.webm', 'x.mp4', '', 'x', '.hidden.webm', 'a//b.webm']) {
      await bad({ input: video, output }, /output must/);
    }
    await bad({ input: video, output: 'person.mp4.webm', model: 'nope' }, /no model "nope"/);
    await bad({ input: video, output: 'x.webm', quality: 'ultra' }, /quality must be/);
    await bad({ input: video, output: 'x.webm', audio: 'both' }, /audio must be/);
    writeFileSync(join(dir, 'public/taken.webm'), 'x');
    await bad({ input: video, output: 'taken.webm' }, /already exists/);
    const outside = tempDir();
    symlinkSync(outside, join(dir, 'public/escape'));
    const r = await post('/api/matting/jobs', { input: video, output: 'escape/x.webm' });
    expect(r.status).toBe(403);
    expect(existsSync(join(outside, 'x.webm'))).toBe(false);
  });
});
