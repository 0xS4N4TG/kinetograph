import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StudioServer } from '../src/index.js';
import { api, cleanup, start, stopAll, writeProject } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let studio: StudioServer;
let dir: string;

beforeAll(async () => {
  ({ dir } = writeProject('Presets'));
  studio = await start(join(dir, 'index.tsx'));
});
afterAll(async () => {
  await stopAll();
  cleanup();
});

const put = (comp: string, name: string, json: unknown) => api(studio, `/api/presets/${comp}/${name}`, { method: 'PUT', json });

describe('presets', () => {
  it('lists none before any is saved', async () => {
    const r = await api(studio, '/api/presets?comp=Main');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ presets: [] });
  });

  it('writes presets/<comp>/<name>.json, pretty with a trailing newline, and lists it', async () => {
    const r = await put('Main', 'warm-2', { title: 'Warm', look: { seed: 3 } });
    expect(r.status).toBe(200);
    expect(readFileSync(join(dir, 'presets/Main/warm-2.json'), 'utf8')).toBe('{\n  "title": "Warm",\n  "look": {\n    "seed": 3\n  }\n}\n');
    await put('Main', 'cool', { title: 'Cool' });
    const list = await api(studio, '/api/presets?comp=Main');
    expect(list.json.presets).toEqual([
      { name: 'cool', props: { title: 'Cool' } },
      { name: 'warm-2', props: { title: 'Warm', look: { seed: 3 } } },
    ]);
    expect((await api(studio, '/api/presets?comp=Other')).json.presets).toEqual([]);
  });

  it('refuses names that do not match the rule', async () => {
    for (const name of ['Warm', '-a', 'a.b', 'a b', 'x'.repeat(65), '..%2Fx']) {
      const r = await put('Main', name, {});
      expect(r.status, name).toBe(400);
      expect(r.json.error.code).toBe('INVALID_ARG');
    }
    expect((await put('Main', 'x'.repeat(64), {})).status).toBe(200);
    expect(existsSync(join(dir, 'x.json'))).toBe(false);
  });

  it('refuses a body that is not an object, a bad composition id, and a missing comp', async () => {
    expect((await put('Main', 'ok', [1])).status).toBe(400);
    expect((await put('Main', 'ok', 'text')).status).toBe(400);
    expect((await put('a%2Fb', 'ok', {})).status).toBe(400);
    expect((await api(studio, '/api/presets')).status).toBe(400);
  });
});
