// Finding the Dawn library (src/shim/webgpu-dawn.ts `load`): one clear message that names the cause when the platform
// package's dawn.node is absent, has no binary for the platform, or does not load; the override and the host's loader are used before
// plain resolution; and the default (hand-built) provider never looks for it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dawnDirectory } from '../src/shim/dawn-binary.js';

const fresh = async () => {
  vi.resetModules();
  const shim = await import('../src/shim/webgpu-dawn.js');
  shim.setDawnLoader(null);
  return shim;
};

const installed = ((): boolean => {
  try {
    dawnDirectory();
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('finding the Dawn library', () => {
  it('says the platform package has no dawn.node in the folder KINETOGRAPH_DAWN_DIR names', async () => {
    const { dawnGlobals } = await fresh();
    vi.stubEnv('KINETOGRAPH_DAWN_DIR', '/no/such/dawn');
    const message = (() => { try { dawnGlobals(); return ''; } catch (error) { return (error as Error).message; } })();
    expect(message).toMatch(/KINETOGRAPH_DAWN_DIR=\/no\/such\/dawn has no dawn\.node/);
    expect(message).toMatch(/KINETOGRAPH_WEBGPU=builtin/);
    expect(message.split('\n')).toHaveLength(1);
  });

  it('wants KINETOGRAPH_DAWN_DIR to be an absolute path', async () => {
    const { dawnGlobals } = await fresh();
    vi.stubEnv('KINETOGRAPH_DAWN_DIR', 'relative/dawn');
    expect(() => dawnGlobals()).toThrow(/KINETOGRAPH_DAWN_DIR must be an absolute path/);
  });

  it('names the platform packages and the fetch script when none holds a dawn.node', async () => {
    const { dawnDirectory } = await import('../src/shim/dawn-binary.js');
    const from = new URL('file:///no/such/place/x.js').href;
    expect(() => dawnDirectory(from, {})).toThrow(/scripts\/fetch-dawn\.mjs|is not installed|no Dawn binary for this platform/);
  });

  it('says a binary that does not load is that, with its first line', async () => {
    const { dawnGlobals, setDawnLoader } = await fresh();
    setDawnLoader(() => {
      throw Object.assign(new Error('libc.so.6: version `GLIBC_2.34\' not found\nmore'), { code: 'ERR_DLOPEN_FAILED' });
    });
    expect(() => dawnGlobals()).toThrow(/cannot be loaded on this system.*GLIBC_2\.34' not found/);
  });

  it('names the override when KINETOGRAPH_DAWN_MODULE is set and does not load, and ignores the host loader', async () => {
    const { dawnGlobals, setDawnLoader } = await fresh();
    const loader = vi.fn();
    setDawnLoader(loader);
    vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '/no/such/webgpu');
    expect(() => dawnGlobals()).toThrow(/KINETOGRAPH_DAWN_MODULE=\/no\/such\/webgpu cannot be loaded/);
    expect(loader).not.toHaveBeenCalled();
  });

  it('refuses a module that is not Dawn for Node', async () => {
    const { dawnGlobals, setDawnLoader } = await fresh();
    setDawnLoader(() => ({}));
    expect(() => dawnGlobals()).toThrow(/it is not Dawn for Node/);
  });

  it('does not look for the library when the built-in WebGPU is the provider', async () => {
    const shim = await fresh();
    const loader = vi.fn(() => { throw new Error('should not be asked'); });
    shim.setDawnLoader(loader);
    vi.stubEnv('KINETOGRAPH_WEBGPU', 'builtin');
    expect(shim.dawnRequested()).toBe(false);
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    expect(shim.dawnRequested()).toBe(true);
    vi.stubEnv('KINETOGRAPH_WEBGPU', 'builtin');
    await import('../src/shim/index.js');
    expect(loader).not.toHaveBeenCalled();
  });

  it('falls back to the built-in WebGPU, said once, when a host installs the page globals and Dawn cannot load', async () => {
    await fresh();
    const { installDomGlobals } = await import('../src/shim/web.js');
    const { GPU_GLOBALS } = await import('@kinetographdev/scene');
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    vi.stubEnv('KINETOGRAPH_DAWN_DIR', '/no/such/dawn');
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => installDomGlobals()).not.toThrow();
      installDomGlobals();
      const warnings = said.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('WebGPU through Dawn'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^warning: WebGPU through Dawn cannot be used here, so the built-in WebGPU layer draws instead: .*KINETOGRAPH_DAWN_DIR=\/no\/such\/dawn has no dawn\.node/);
    } finally {
      said.mockRestore();
    }
    expect(process.env.KINETOGRAPH_WEBGPU).toBe('builtin');
    expect((globalThis as any).GPUBufferUsage).toBe(GPU_GLOBALS.GPUBufferUsage);
  });

  it.skipIf(!installed)('finds the platform package\'s dawn.node when nothing else is set', async () => {
    const { dawnGlobals } = await fresh();
    expect(typeof (dawnGlobals() as any).GPUDevice).toBe('function');
  });
});
