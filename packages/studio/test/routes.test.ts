import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startStudio, type StudioServer } from '../src/index.js';
import { api, cleanup, start, stopAll, text, until, writeProject, STUB_ENGINE } from './helpers.js';

// Workers start slowly on a busy machine: each test spawns several.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let studio: StudioServer;
let dir: string;
let entry: string;

beforeAll(async () => {
  ({ dir, entry } = writeProject('Main'));
  studio = await start(entry, { props: { base: 1 } });
});
afterAll(async () => {
  await stopAll();
  cleanup();
});

const frameJson = async (path: string) => {
  const r = await api(studio, path);
  return { ...r, frame: JSON.parse(text(r.body)) };
};

describe('project and compositions', () => {
  it('GET /api/project', async () => {
    const r = await api(studio, '/api/project');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ entry, cwd: process.cwd(), buildId: 1, buildError: null });
    expect(r.json.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('GET /api/compositions', async () => {
    const r = await api(studio, '/api/compositions');
    expect(r.status).toBe(200);
    expect(r.json.map((c: { id: string }) => c.id)).toEqual(['Main', 'Short']);
    expect(r.json[0]).toMatchObject({ width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: { title: 'hi' } });
  });
});

describe('GET /api/frame', () => {
  it('answers with the image, its mime and the build and frame headers', async () => {
    const r = await frameJson('/api/frame?comp=Main&frame=12&scale=0.5&format=png');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-build')).toBe('1');
    expect(r.headers.get('x-frame')).toBe('12');
    expect(r.frame).toMatchObject({ frame: 12, scale: 0.5, format: 'png' });
  });

  it('defaults to scale 1 and JPEG', async () => {
    const r = await frameJson('/api/frame?comp=Main&frame=0');
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.frame).toMatchObject({ scale: 1, format: 'jpeg' });
  });

  it('merges props over the studio props', async () => {
    const r = await frameJson(`/api/frame?comp=Main&frame=0&props=${encodeURIComponent(JSON.stringify({ extra: 2, base: 3 }))}`);
    expect(r.frame.props).toEqual({ base: 3, extra: 2 });
    expect((await frameJson('/api/frame?comp=Main&frame=0')).frame.props).toEqual({ base: 1 });
  });

  it.each([
    ['no comp', '/api/frame?frame=0'],
    ['no frame', '/api/frame?comp=Main'],
    ['a negative frame', '/api/frame?comp=Main&frame=-1'],
    ['a fractional frame', '/api/frame?comp=Main&frame=1.5'],
    ['a frame past the end', '/api/frame?comp=Main&frame=90'],
    ['a zero scale', '/api/frame?comp=Main&frame=0&scale=0'],
    ['a scale above 1', '/api/frame?comp=Main&frame=0&scale=2'],
    ['a scale that is no number', '/api/frame?comp=Main&frame=0&scale=big'],
    ['an unknown format', '/api/frame?comp=Main&frame=0&format=gif'],
    ['props that are not JSON', '/api/frame?comp=Main&frame=0&props=%7Bnope'],
    ['props that are not an object', '/api/frame?comp=Main&frame=0&props=%5B1%5D'],
  ])('is 400 INVALID_ARG for %s', async (_what, path) => {
    const r = await api(studio, path);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('INVALID_ARG');
    expect(r.json.error.message).toBeTruthy();
  });

  it('is 404 NOT_FOUND for an unknown composition', async () => {
    const r = await api(studio, '/api/frame?comp=Nope&frame=0');
    expect(r.status).toBe(404);
    expect(r.json.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(r.json.error.message).toContain('Main');
  });

  it('is 500 with the engine’s code when rendering fails', async () => {
    const r = await api(studio, `/api/frame?comp=Main&frame=0&props=${encodeURIComponent('{"_gpuError":true}')}`);
    expect(r.status).toBe(500);
    expect(r.json.error).toEqual({ code: 'RENDER', message: 'the GPU is gone' });
    const js = await api(studio, `/api/frame?comp=Main&frame=0&props=${encodeURIComponent('{"_jsError":true}')}`);
    expect(js.status).toBe(500);
    expect(js.json.error.code).toBe('PROJECT_ERROR');
  });
});

describe('GET /api/inspect and /api/timeline', () => {
  it('inspect returns the engine’s result for the frame', async () => {
    const r = await api(studio, '/api/inspect?comp=Main&frame=15');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ frame: 15, width: 64, layers: [{ id: 'bg' }, { id: '$0' }] });
    expect((await api(studio, '/api/inspect?comp=Main')).json.frame).toBe(0);
  });

  it('inspect and timeline reject what frame does', async () => {
    expect((await api(studio, '/api/inspect?comp=Main&frame=-3')).status).toBe(400);
    expect((await api(studio, '/api/inspect?comp=Nope')).status).toBe(404);
    expect((await api(studio, '/api/inspect')).status).toBe(400);
    expect((await api(studio, '/api/timeline?comp=Nope')).status).toBe(404);
    expect((await api(studio, '/api/timeline')).status).toBe(400);
    expect((await api(studio, '/api/timeline?comp=Main&props=x')).status).toBe(400);
  });

  it('timeline is the union over every frame', async () => {
    const r = await api(studio, '/api/timeline?comp=Main');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ comp: 'Main', fps: 30, durationInFrames: 90 });
    // One entry per key, sorted by from, the layer of the first frame each shows on.
    expect(r.json.sequences.map((s: { key: string }) => s.key)).toEqual(['/intro@10+20', '/intro@10+20/inner@12+5', '/outro@50+10']);
    expect(r.json.sequences.map((s: { layer: string }) => s.layer)).toEqual(['$0', '$0', '$0']);
    // A path id means whatever sits there, so `$0` in two Sequences is two layers, each saying which Sequence it is in;
    // a name the author gave (`bg`) stays one layer, in the Sequence it began in (none: it began on frame 0).
    expect(r.json.layers).toEqual([
      { id: 'bg', type: 'shape', parent: null, ranges: [[0, 89]] },
      { id: '$0', type: 'group', parent: null, ranges: [[10, 29]], sequence: '/intro@10+20' },
      { id: '$0.0', type: 'shape', parent: '$0', ranges: [[10, 29]], sequence: '/intro@10+20' },
      { id: '$0', type: 'group', parent: null, ranges: [[50, 59]], sequence: '/outro@50+10' },
      { id: '$0.0', type: 'shape', parent: '$0', ranges: [[50, 59]], sequence: '/outro@50+10' },
    ]);
  });

  it('timeline is cached per build, composition and props', async () => {
    const name = async (path: string) => (await api(studio, path)).json.sequences[0].name;
    const first = await name('/api/timeline?comp=Main');
    expect(await name('/api/timeline?comp=Main')).toBe(first);
    // Other props, other computation (the name carries a per-worker nonce).
    expect(await name(`/api/timeline?comp=Main&props=${encodeURIComponent('{"a":1}')}`)).not.toBe(first);
    // The key is the props, not how they are written.
    const ab = await name(`/api/timeline?comp=Main&props=${encodeURIComponent('{"a":1,"b":2}')}`);
    expect(await name(`/api/timeline?comp=Main&props=${encodeURIComponent('{"b":2,"a":1}')}`)).toBe(ab);
  });

  it('timeline/progress reports how many frames the sweep has read', async () => {
    const slow = encodeURIComponent('{"_frameMs":15}');
    const progress = async () => (await api(studio, `/api/timeline/progress?comp=Main&props=${slow}`)).json;
    expect(await progress()).toEqual({ done: 0, total: 0 });
    const pending = api(studio, `/api/timeline?comp=Main&props=${slow}`);
    let seen = { done: 0, total: 0 };
    for (let i = 0; i < 200 && seen.done === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      seen = await progress();
    }
    expect(seen.total).toBe(90);
    expect(seen.done).toBeGreaterThan(0);
    expect((await pending).status).toBe(200);
    expect(await progress()).toEqual({ done: 90, total: 90 });
    expect((await api(studio, '/api/timeline/progress')).status).toBe(400);
    expect((await api(studio, '/api/timeline/progress?comp=Nope')).status).toBe(404);
  });

  it('timeline of a composition without Sequences has none', async () => {
    const r = await api(studio, '/api/timeline?comp=Short');
    expect(r.json.sequences).toEqual([]);
    expect(r.json.durationInFrames).toBe(6);
  });
});

describe('render queue routes', () => {
  it('POST /api/renders queues a job (201), which runs to done', async () => {
    const r = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Main', range: '0..4' } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      comp: 'Main',
      output: join(dir, 'out', 'Main.mp4'),
      range: [0, 3],
      framesTotal: 4,
      props: { base: 1 },
      error: null,
    });
    expect(['queued', 'running']).toContain(r.json.status);
    expect(r.json.id).toMatch(/^\d+$/);

    const done = await until(
      async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === r.json.id),
      (job) => job.status === 'done',
    );
    expect(done).toMatchObject({ framesDone: 4, framesTotal: 4, error: null });
    expect(done.summary).toMatchObject({ frames: 4, first: 0, last: 3 });
    expect(done.msPerFrame).toBeGreaterThan(0);
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.queuedAt);
    expect(readFileSync(join(dir, 'out', 'Main.mp4'), 'utf8')).toBe('stub video Main 0..3');
  });

  it('takes the output, encoder, draft and props, and ids count up from the first', async () => {
    const r = await api(studio, '/api/renders', {
      method: 'POST',
      json: { comp: 'Short', output: 'renders/short.mov', encoder: 'libx264', draft: true, range: '2..=5', props: { x: 1 } },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ output: join(dir, 'renders', 'short.mov'), range: [2, 5], props: { base: 1, x: 1 } });
    const done = await until(
      async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === r.json.id),
      (job) => job.status === 'done',
    );
    expect(done.summary.encoder).toBe('libx264');
    expect(readFileSync(join(dir, 'renders', 'short.mov'), 'utf8')).toBe('stub video Short 2..5 draft');
    const ids = (await api(studio, '/api/renders')).json.map((j: { id: string }) => Number(j.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('rejects a bad request with 400 and an unknown composition with 404', async () => {
    const post = (json: unknown) => api(studio, '/api/renders', { method: 'POST', json });
    for (const body of [
      {},
      { comp: 3 },
      { comp: 'Main', output: 'out/x.avi' },
      { comp: 'Main', output: '' },
      { comp: 'Main', range: 'soon' },
      { comp: 'Main', draft: 'yes' },
      { comp: 'Main', props: [1] },
      { comp: 'Main', encoder: 7 },
      [],
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('INVALID_ARG');
    }
    expect((await post({ comp: 'Nope' })).status).toBe(404);
    const notJson = await api(studio, '/api/renders', { method: 'POST', body: '{"comp":"Main"}', headers: { 'Content-Type': 'text/plain' } });
    expect(notJson.status).toBe(400);
    const broken = await api(studio, '/api/renders', { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
    expect(broken.status).toBe(400);
  });

  it('DELETE /api/renders/:id cancels a running job, leaves a finished one, and 404s for an unknown one', async () => {
    const slow = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Main', props: { _renderFrameMs: 40 } } });
    await until(async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === slow.json.id), (job) => job.status === 'running' && job.framesDone > 0);
    const queuedBehind = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Short' } });
    expect(queuedBehind.json.status).toBe('queued');

    const cancelled = await api(studio, `/api/renders/${slow.json.id}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    const job = await until(async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === slow.json.id), (j) => j.status === 'cancelled');
    expect(job.framesDone).toBeLessThan(job.framesTotal);

    // The job behind it still runs.
    await until(async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === queuedBehind.json.id), (j) => j.status === 'done');
    const again = await api(studio, `/api/renders/${queuedBehind.json.id}`, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('done');

    const missing = await api(studio, '/api/renders/9999', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('NOT_FOUND');
  });

  it('a queued job can be cancelled before it starts', async () => {
    const slow = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Main', props: { _renderFrameMs: 30 }, range: '0..30' } });
    const waiting = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Short' } });
    const r = await api(studio, `/api/renders/${waiting.json.id}`, { method: 'DELETE' });
    expect(r.json).toMatchObject({ status: 'cancelled', framesDone: 0 });
    expect(r.json.finishedAt).not.toBeNull();
    await api(studio, `/api/renders/${slow.json.id}`, { method: 'DELETE' });
    await until(async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === slow.json.id), (j) => j.status === 'cancelled');
  });

  it('a failing job is failed with the engine’s error', async () => {
    const r = await api(studio, '/api/renders', { method: 'POST', json: { comp: 'Main', props: { _renderFail: true } } });
    const job = await until(async () => (await api(studio, '/api/renders')).json.find((j: { id: string }) => j.id === r.json.id), (j) => j.status === 'failed');
    expect(job.error).toEqual({ code: 'ENCODE', message: 'the encoder said no' });
    expect(job.summary).toBeNull();
  });
});

describe('other requests', () => {
  it('an unknown API route, or the wrong method, is 404 NOT_FOUND', async () => {
    for (const [method, path] of [['GET', '/api/nope'], ['POST', '/api/project'], ['PUT', '/api/renders'], ['GET', '/api/renders/1']] as const) {
      const r = await api(studio, path, { method });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error.code).toBe('NOT_FOUND');
    }
  });

  it('serves the UI at / (or says it is not built), and the same page for an unknown path', async () => {
    const root = await api(studio, '/');
    const deep = await api(studio, '/some/client/route');
    expect(root.status).toBe(200);
    expect(deep.status).toBe(200);
    expect(text(deep.body)).toBe(text(root.body));
    const built = existsSync(new URL('../ui/dist/index.html', import.meta.url));
    expect(root.headers.get('content-type')).toContain(built ? 'text/html' : 'text/plain');
    if (!built) expect(text(root.body)).toContain('not built');
  });

  it('refuses a request from another site, or to another host name', async () => {
    const foreign = await api(studio, '/api/project', { headers: { Origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
    const same = await api(studio, '/api/project', { headers: { Origin: new URL(studio.url).origin } });
    expect(same.status).toBe(200);
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL('/api/project', studio.url);
      request({ host: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'rebind.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    expect(status).toBe(403);
  });
});

describe('starting and stopping', () => {
  it('a taken port is an INVALID_ARG error', async () => {
    const port = Number(new URL(studio.url).port);
    await expect(startStudio({ entry, port, open: false, engine: STUB_ENGINE })).rejects.toMatchObject({ code: 'INVALID_ARG' });
  });

  it('a missing entry is an error before anything starts', async () => {
    await expect(startStudio({ entry: join(dir, 'nope.tsx'), port: 0, open: false, engine: STUB_ENGINE })).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
  });

  it('close() stops serving', async () => {
    const other = await start(entry);
    expect((await api(other, '/api/project')).status).toBe(200);
    await other.close();
    await expect(fetch(new URL('/api/project', other.url))).rejects.toThrow();
  });

  it('a project that fails to build leaves the server up with 409 BUILD and the error in /api/project', async () => {
    const broken = writeProject('x');
    // Not valid TypeScript: the first build fails.
    writeFileSync(broken.entry, 'const = ;');
    const logged: string[] = [];
    const s = await start(broken.entry, { log: (m) => logged.push(m) });
    const project = await api(s, '/api/project');
    expect(project.json.buildId).toBe(0);
    expect(project.json.buildError.code).toBe('BUNDLE_FAILED');
    for (const path of ['/api/compositions', '/api/frame?comp=A&frame=0', '/api/inspect?comp=A', '/api/timeline?comp=A']) {
      const r = await api(s, path);
      expect(r.status, path).toBe(409);
      expect(r.json.error.code).toBe('BUILD');
    }
    expect((await api(s, '/api/renders', { method: 'POST', json: { comp: 'A' } })).status).toBe(409);
    expect(logged.join('\n')).toContain('build failed');
  });
});
