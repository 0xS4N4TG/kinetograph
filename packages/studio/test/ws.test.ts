import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FrameRequest, RenderJob, ServerMessage } from '../src/index.js';
import { Client, api, cleanup, projectSource, start, stopAll, text, until, writeProject, writeScene } from './helpers.js';

afterEach(() => stopAll());
afterAll(() => cleanup());

const frame = (requestId: number, extra: Partial<FrameRequest> = {}): FrameRequest => ({
  type: 'frame',
  requestId,
  comp: 'Main',
  frame: requestId,
  scale: 0.5,
  format: 'jpeg',
  ...extra,
});

describe('WebSocket /ws', () => {
  it('says hello with the version and the build', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    const hello = (await client.waitForMessage('hello')).kind === 'json' ? client.messages('hello')[0] : undefined;
    expect(hello).toMatchObject({ type: 'hello', buildId: 1, buildError: null });
    expect((hello as Extract<ServerMessage, { type: 'hello' }>).version).toMatch(/^\d+\./);
    client.close();
  });

  it('answers a frame request with one binary message: header, then the image', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry, { props: { base: 1 } });
    const client = await Client.connect(server);
    client.send(frame(7, { frame: 21, scale: 1, format: 'png', props: { more: 2 } }));
    const got = await client.waitFor((r) => r.kind === 'frame');
    if (got.kind !== 'frame') throw new Error('unreachable');
    expect(got.header).toMatchObject({ type: 'frame', requestId: 7, comp: 'Main', frame: 21, buildId: 1, width: 64, height: 36, mime: 'image/png' });
    expect(got.header.ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(text(got.image))).toEqual({ frame: 21, scale: 1, format: 'png', props: { base: 1, more: 2 } });
    client.close();
  });

  it('half-size JPEG frames have the half size', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    client.send(frame(1, { scale: 0.5 }));
    const got = await client.waitFor((r) => r.kind === 'frame');
    expect(got.kind === 'frame' && [got.header.width, got.header.height, got.header.mime]).toEqual([32, 18, 'image/jpeg']);
    client.close();
  });

  it('keeps only the latest request that has not started (latest wins), without replying to the ones dropped', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    const props = { _previewMs: 150 };
    for (let id = 1; id <= 6; id++) client.send(frame(id, { props }));
    await client.waitFor((r) => r.kind === 'frame' && r.header.requestId === 6);
    // Let anything late show up.
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The first was in flight when the rest arrived; of those, only the last is rendered.
    expect(client.frames().map((f) => f.header.requestId)).toEqual([1, 6]);
    expect(client.messages('error')).toEqual([]);
    client.close();
  });

  it('latest wins per connection: another connection’s requests are its own', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const a = await Client.connect(server);
    const b = await Client.connect(server);
    const props = { _previewMs: 100 };
    a.send(frame(1, { props }));
    a.send(frame(2, { props }));
    b.send(frame(11, { props }));
    b.send(frame(12, { props }));
    await a.waitFor((r) => r.kind === 'frame' && r.header.requestId === 2);
    await b.waitFor((r) => r.kind === 'frame' && r.header.requestId === 12);
    expect(a.frames().map((f) => f.header.requestId)).toEqual([1, 2]);
    expect(b.frames().map((f) => f.header.requestId)).toEqual([11, 12]);
    a.close();
    b.close();
  });

  it('answers a request it cannot serve with an error carrying its requestId', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    client.send(frame(1, { comp: 'Nope' }));
    client.send(frame(2, { scale: 3 }));
    const unknown = await client.waitForMessage('error', (m) => m.requestId === 1);
    const scale = await client.waitForMessage('error', (m) => m.requestId === 2);
    expect(unknown.kind === 'json' && unknown.message).toMatchObject({ type: 'error', requestId: 1, error: { code: 'NOT_FOUND' } });
    expect(scale.kind === 'json' && scale.message).toMatchObject({ type: 'error', requestId: 2, error: { code: 'INVALID_ARG' } });
    // The connection is still good.
    client.send(frame(3, { props: { _gpuError: true } }));
    await client.waitForMessage('error', (m) => m.requestId === 3 && m.error.code === 'RENDER');
    client.send(frame(4));
    await client.waitFor((r) => r.kind === 'frame' && r.header.requestId === 4);
    client.close();
  });

  it('answers a message it does not understand with an error without a requestId', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    client.send('not json');
    client.send({ type: 'seek' });
    client.send({ type: 'frame', requestId: 'x' });
    await until(
      () => client.messages('error'),
      (errors) => errors.length === 3,
    );
    for (const message of client.messages('error')) expect(message).toMatchObject({ requestId: null, error: { code: 'INVALID_ARG' } });
    client.close();
  });

  it('refuses a connection from another site, or to another path', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    await expect(Client.connect(server, { headers: { Origin: 'http://evil.example' } })).rejects.toThrow();
    const other = new URL('/elsewhere', server.url);
    const { default: WebSocket } = await import('ws');
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(other.href.replace(/^http/, 'ws'));
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    ).rejects.toThrow();
  });
});

describe('render progress over the socket', () => {
  it('sends the job’s states, at most ten messages a second, ending with done', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    const posted = await api(server, '/api/renders', { method: 'POST', json: { comp: 'Main', range: '0..60', props: { _renderFrameMs: 20 } } });
    const id = posted.json.id as string;
    const last = (): RenderJob | undefined => (client.messages('render') as { job: RenderJob }[]).filter((m) => m.job.id === id).at(-1)?.job;
    await until(last, (job) => job?.status === 'done', 15000);

    const stamps = client.received.filter((r) => r.kind === 'json' && r.message.type === 'render').map((r) => r.at);
    const jobs = (client.messages('render') as { job: RenderJob }[]).map((m) => m.job);
    expect(jobs[0]!.status).toMatch(/queued|running/);
    expect(jobs.at(-1)).toMatchObject({ status: 'done', framesDone: 60, framesTotal: 60, error: null });
    // Progress only moves forward, and arrives in several steps (the job takes over a second).
    const done = jobs.map((j) => j.framesDone);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(jobs.length).toBeGreaterThan(4);
    // 100 ms between messages (a little less to forgive timer and receive jitter).
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 1]!, `message ${i}`).toBeGreaterThanOrEqual(80);
    client.close();
  });

  it('sends cancelled when a job is cancelled', async () => {
    const { entry } = writeProject('Main');
    const server = await start(entry);
    const client = await Client.connect(server);
    const posted = await api(server, '/api/renders', { method: 'POST', json: { comp: 'Main', props: { _renderFrameMs: 30 } } });
    await client.waitForMessage('render', (m) => m.job.status === 'running');
    await api(server, `/api/renders/${posted.json.id}`, { method: 'DELETE' });
    const gone = await client.waitForMessage('render', (m) => m.job.status === 'cancelled');
    expect(gone.kind === 'json' && gone.message).toMatchObject({ type: 'render', job: { id: posted.json.id, status: 'cancelled' } });
    client.close();
  });
});

describe('rebuilding on a change', () => {
  it('reloads on a good build, keeps the last good one on a bad build, and recovers', async () => {
    const { entry } = writeProject('one');
    const server = await start(entry);
    const client = await Client.connect(server);
    await client.waitForMessage('hello');
    expect((await api(server, '/api/compositions')).json[0].id).toBe('one');

    // A good build.
    writeFileSync(entry, projectSource('two'));
    await client.waitForMessage('reload', (m) => m.buildId === 2);
    expect((await api(server, '/api/compositions')).json[0].id).toBe('two');
    expect((await api(server, '/api/project')).json).toMatchObject({ buildId: 2, buildError: null });
    // The frame is from the new build, and carries its id.
    client.send(frame(1, { comp: 'two' }));
    const first = await client.waitFor((r) => r.kind === 'frame' && r.header.requestId === 1);
    expect(first.kind === 'frame' && first.header.buildId).toBe(2);

    // A build that fails: told to everyone, the last good build keeps serving, its id does not move.
    writeFileSync(entry, 'const = ;');
    const failed = await client.waitForMessage('buildError');
    expect(failed.kind === 'json' && failed.message).toMatchObject({ type: 'buildError', error: { code: 'BUNDLE_FAILED' } });
    const project = (await api(server, '/api/project')).json;
    expect(project.buildId).toBe(2);
    expect(project.buildError.message).toContain('index.tsx');
    expect((await api(server, '/api/compositions')).json[0].id).toBe('two');
    const stale = await api(server, '/api/frame?comp=two&frame=3');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-build')).toBe('2');
    // A client that connects now is told.
    const late = await Client.connect(server);
    const hello = await late.waitForMessage('hello');
    expect(hello.kind === 'json' && hello.message).toMatchObject({ buildId: 2, buildError: { code: 'BUNDLE_FAILED' } });
    late.close();

    // The next good build clears the error.
    writeFileSync(entry, projectSource('three'));
    await client.waitForMessage('reload', (m) => m.buildId === 3);
    expect((await api(server, '/api/project')).json).toMatchObject({ buildId: 3, buildError: null });
    expect((await api(server, '/api/compositions')).json[0].id).toBe('three');
    client.close();
  });

  it('treats a project that fails while loading as a failed build', async () => {
    const { entry } = writeProject('fine');
    const server = await start(entry);
    const client = await Client.connect(server);
    writeFileSync(entry, projectSource('boom'));
    const failed = await client.waitForMessage('buildError');
    expect(failed.kind === 'json' && failed.message).toMatchObject({ error: { code: 'PROJECT_ERROR', message: 'the project failed while loading' } });
    expect((await api(server, '/api/project')).json.buildId).toBe(1);
    expect((await api(server, '/api/compositions')).json[0].id).toBe('fine');
    client.close();
  });

  it('a frame in flight during a rebuild finishes on the build it started on', async () => {
    const { entry } = writeProject('old');
    const server = await start(entry);
    const client = await Client.connect(server);
    client.send(frame(1, { comp: 'old', props: { _previewMs: 400 } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(entry, projectSource('new'));
    await client.waitForMessage('reload', (m) => m.buildId === 2);
    const done = await client.waitFor((r) => r.kind === 'frame' && r.header.requestId === 1);
    expect(done.kind === 'frame' && done.header.buildId).toBe(1);
    client.close();
  });

  it('reloads when a .json scene file changes', async () => {
    const { entry } = writeScene('first');
    const server = await start(entry);
    const client = await Client.connect(server);
    expect((await api(server, '/api/compositions')).json[0].id).toBe('first');
    writeFileSync(entry, JSON.stringify({ id: 'second' }));
    await client.waitForMessage('reload', (m) => m.buildId === 2);
    expect((await api(server, '/api/compositions')).json[0].id).toBe('second');
    writeFileSync(entry, JSON.stringify({ id: 'x', boom: true }));
    const failed = await client.waitForMessage('buildError');
    expect(failed.kind === 'json' && failed.message).toMatchObject({ error: { code: 'SCENE_INVALID' } });
    client.close();
  });
});
