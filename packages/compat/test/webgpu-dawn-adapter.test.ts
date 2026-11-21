// Which adapter Dawn is given (src/shim/webgpu-dawn.ts): the backend named explicitly, one policy whatever the page asks for, the adapter that
// was chosen kept for `doctor`, and a clear message when there is none or the flags name one Dawn does not have.

import { createRequire } from 'node:module';
import { loadDawnBinary } from '../src/shim/dawn-binary.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dawnFlags } from '../src/shim/webgpu-dawn.js';

const missing = ((): string | null => {
  try {
    (process.env.KINETOGRAPH_DAWN_MODULE ? createRequire(import.meta.url)(process.env.KINETOGRAPH_DAWN_MODULE) : loadDawnBinary());
    return null;
  } catch (error) {
    return `Dawn cannot be loaded (${(error as Error).message.split('\n')[0]})`;
  }
})();

afterEach(() => vi.unstubAllEnvs());

describe('the flags Dawn is given', () => {
  it('name the platform\'s own backend, and what the environment names instead', () => {
    expect(dawnFlags({}, 'darwin')).toEqual(['backend=metal']);
    expect(dawnFlags({}, 'win32')).toEqual(['backend=d3d12']);
    expect(dawnFlags({}, 'linux')).toEqual(['backend=vulkan']);
    expect(dawnFlags({}, 'freebsd')).toEqual([]);
    expect(dawnFlags({ KINETOGRAPH_DAWN_BACKEND: 'opengles' }, 'linux')).toEqual(['backend=opengles']);
    expect(dawnFlags({ KINETOGRAPH_DAWN_ADAPTER: 'Apple M4' }, 'darwin')).toEqual(['backend=metal', 'adapter=Apple M4']);
  });
});

if (missing !== null) describe('the adapter Dawn gives', () => it.skip(`skipped: ${missing}`, () => {}));

async function fresh() {
  vi.resetModules();
  const shim = await import('../src/shim/webgpu-dawn.js');
  return { shim, gpu: shim.installDawn({ track: (work) => work, rasterize: () => null }) };
}

describe.skipIf(missing !== null)('the adapter Dawn gives', () => {
  // The backend this platform does not have: Dawn has no adapter for it.
  const absent = process.platform === 'darwin' ? 'vulkan' : 'metal';

  it('is null, with a frame warning that says why, when the backend has no adapter, and `describeDawn` says it too', async () => {
    vi.stubEnv('KINETOGRAPH_DAWN_BACKEND', absent);
    const { shim, gpu } = await fresh();
    expect(await gpu.requestAdapter()).toBeNull();
    const said = shim.takeDawnReports().join('\n');
    expect(said).toMatch(new RegExp(`Dawn found no adapter \\(backend=${absent};`));
    expect(said).toMatch(/KINETOGRAPH_DAWN_BACKEND or KINETOGRAPH_DAWN_ADAPTER/);
    const status = await shim.describeDawn();
    expect(status.ok).toBe(false);
    expect(shim.dawnAdapter()).toBeNull();
  });

  it('says what the library lists when a flag names a backend or an adapter it does not have', async () => {
    vi.stubEnv('KINETOGRAPH_DAWN_BACKEND', 'no-such-backend');
    const { shim, gpu } = await fresh();
    await expect(gpu.requestAdapter()).rejects.toThrow(/Dawn could not start with backend=no-such-backend: .*Possible backends/);
    const status = await shim.describeDawn();
    expect(status.ok).toBe(false);
    vi.stubEnv('KINETOGRAPH_DAWN_BACKEND', '');
    vi.stubEnv('KINETOGRAPH_DAWN_ADAPTER', 'no-such-adapter');
    const named = await fresh();
    await expect(named.gpu.requestAdapter()).rejects.toThrow(/Dawn could not start with .*adapter=no-such-adapter: .*Available adapters/);
  });

  it('is the same whatever the page asks for, is kept once for `doctor`, and shows the page the fixed one', async () => {
    vi.stubEnv('KINETOGRAPH_DAWN_BACKEND', '');
    vi.stubEnv('KINETOGRAPH_DAWN_ADAPTER', '');
    const { shim, gpu } = await fresh();
    const adapter = await gpu.requestAdapter({ powerPreference: 'low-power', forceFallbackAdapter: true });
    expect(adapter).not.toBeNull();
    expect(adapter.info.vendor).toBe('kinetograph');
    const chosen = shim.dawnAdapter();
    expect(chosen).not.toBeNull();
    expect(chosen!.backend).toBe({ darwin: 'metal', win32: 'd3d12', linux: 'vulkan' }[process.platform as string] ?? null);
    expect(chosen!.vendor).not.toBe('kinetograph');
    // A second request does not replace what was said.
    await gpu.requestAdapter();
    expect(shim.dawnAdapter()).toBe(chosen);
    const status = await shim.describeDawn();
    expect(status).toEqual({ ok: true, flags: dawnFlags(), adapter: chosen });
  });
});

describe.skipIf(missing !== null)('the instance `describeDawn` asks', () => {
  it('is made once, not for every project a process opens (Studio opens one for each preview and render)', async () => {
    vi.resetModules();
    Object.assign((globalThis as any)[Symbol.for('kinetograph.dawn.shared')], { probe: null, adapter: null });
    const real = loadDawnBinary();
    let made = 0;
    const { setDawnLoader, describeDawn } = await import('../src/shim/webgpu-dawn.js');
    setDawnLoader(() => ({ ...real, create: (flags: string[]) => { made++; return real.create(flags); } }));
    vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '');
    const first = await describeDawn();
    const second = await describeDawn();
    expect(first.ok && second.ok).toBe(true);
    expect(made).toBe(1);
  });
});
