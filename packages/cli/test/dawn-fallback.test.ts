// Dawn as the provider is decided once before a project runs (src/dawn.ts `prepareCliDawn`): when no adapter can be had, the built-in WebGPU
// layer draws instead, with one warning, and `KINETOGRAPH_WEBGPU` is `builtin` in the environment the render inherits.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCliDawn } from '../src/dawn.js';

afterEach(() => vi.unstubAllEnvs());

describe('Dawn that cannot be used', () => {
  it('gives the render to the built-in WebGPU, said once', async () => {
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '');
    vi.stubEnv('KINETOGRAPH_DAWN_DIR', '/no/such/dawn');
    const said: string[] = [];
    await prepareCliDawn((message) => said.push(message));
    expect(process.env.KINETOGRAPH_WEBGPU).toBe('builtin');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^warning: WebGPU through Dawn cannot be used here, so the built-in WebGPU layer draws this render instead: .*KINETOGRAPH_DAWN_DIR=\/no\/such\/dawn has no dawn\.node/);
    expect(said[0]).not.toMatch(/KINETOGRAPH_WEBGPU=builtin/);
  });

  it('does nothing when the built-in WebGPU is asked for', async () => {
    vi.stubEnv('KINETOGRAPH_WEBGPU', 'builtin');
    const said: string[] = [];
    await prepareCliDawn((message) => said.push(message));
    expect(said).toEqual([]);
  });
});
