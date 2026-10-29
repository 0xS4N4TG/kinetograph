import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StudioServer } from '../src/index.js';
import { api, cleanup, Client, start, stopAll, tokenOf, writeProject } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let studio: StudioServer;
const auth = () => ({ 'x-studio-token': tokenOf(studio)! });

beforeAll(async () => {
  studio = await start(writeProject('Live').entry);
});
afterAll(async () => {
  await stopAll();
  cleanup();
});

describe('live props', () => {
  it('needs the studio token', async () => {
    expect((await api(studio, '/api/live-props')).status).toBe(403);
    expect((await api(studio, '/api/live-props', { headers: { 'x-studio-token': 'wrong' } })).status).toBe(403);
    expect((await api(studio, '/api/live-props', { method: 'PUT', json: { comp: 'Short', props: {} } })).status).toBe(403);
  });

  it('is empty before a window says what it previews, then holds the last props message', async () => {
    expect((await api(studio, '/api/live-props', { headers: auth() })).json).toEqual({ comp: null, props: {} });
    const client = await Client.connect(studio);
    client.send({ type: 'props', comp: 'Short', props: { a: 1 } });
    client.send({ type: 'props', comp: 'Short', props: { a: 2, b: 'x' } });
    await vi.waitFor(async () => {
      expect((await api(studio, '/api/live-props', { headers: auth() })).json).toEqual({ comp: 'Short', props: { a: 2, b: 'x' } });
    });
    // A bad message is answered with an error and changes nothing.
    client.send({ type: 'props', comp: 'Short', props: [1] });
    await client.waitForMessage('error');
    expect((await api(studio, '/api/live-props', { headers: auth() })).json.props).toEqual({ a: 2, b: 'x' });
    client.close();
  });

  it('PUT answers 400 for an unknown composition or a bad body, and broadcasts a good one to every window', async () => {
    const unknown = await api(studio, '/api/live-props', { method: 'PUT', headers: auth(), json: { comp: 'Nope', props: {} } });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.message).toContain('no composition "Nope"');
    expect((await api(studio, '/api/live-props', { method: 'PUT', headers: auth(), json: { comp: 'Short', props: [] } })).status).toBe(400);
    expect((await api(studio, '/api/live-props', { method: 'PUT', headers: auth(), json: { props: {} } })).status).toBe(400);

    const a = await Client.connect(studio);
    const b = await Client.connect(studio);
    const put = await api(studio, '/api/live-props', { method: 'PUT', headers: auth(), json: { comp: 'Short', props: { title: 'pushed' } } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ comp: 'Short', props: { title: 'pushed' } });
    for (const client of [a, b]) {
      const got = await client.waitForMessage('props');
      expect(got).toMatchObject({ message: { type: 'props', comp: 'Short', props: { title: 'pushed' } } });
    }
    expect((await api(studio, '/api/live-props', { headers: auth() })).json).toEqual({ comp: 'Short', props: { title: 'pushed' } });
    a.close();
    b.close();
  });
});
