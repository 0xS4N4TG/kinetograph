// Dawn or the built-in WebGPU is decided by the studio's own process before its first worker (src/server.ts, `prepareCliDawn`): with a Dawn
// that cannot load, the built-in layer draws, said once, and a project still loads in the workers. Its own file: the decision is the
// process's, and Dawn, once loaded by another test, would stay loaded.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { api, cleanup, start, stopAll, tempDir } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await stopAll();
  cleanup();
  vi.unstubAllEnvs();
});

const SOURCE = `
import { Composition, Rect, registerRoot } from 'remotion';
const Main = () => <Rect id="bg" width={64} height={36} fill="#000" />;
registerRoot(() => <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={4} />);
`;

describe.skipIf(!addon)('the studio with a Dawn that cannot load', () => {
  it('decides for the built-in WebGPU before the workers start, and loads the project', async () => {
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '');
    vi.stubEnv('KINETOGRAPH_DAWN_DIR', '/no/such/dawn');
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const entry = join(dir, 'index.tsx');
    writeFileSync(entry, SOURCE);
    const said: string[] = [];
    const server = await start(entry, { engine: undefined, log: (message) => said.push(message) });

    expect(process.env.KINETOGRAPH_WEBGPU).toBe('builtin');
    expect(said.filter((m) => m.includes('WebGPU through Dawn'))).toEqual([expect.stringMatching(/^warning: WebGPU through Dawn cannot be used here.*KINETOGRAPH_DAWN_DIR=\/no\/such\/dawn has no dawn\.node/)]);
    expect((await api(server, '/api/project')).json).toMatchObject({ buildId: 1, buildError: null });
    expect((await api(server, '/api/compositions')).json).toMatchObject([{ id: 'Main' }]);
    const inspected = await api(server, '/api/inspect?comp=Main&frame=1');
    expect(inspected.status).toBe(200);
    expect(JSON.stringify(inspected.json.layers)).toContain('"id":"bg"');
  });
});
