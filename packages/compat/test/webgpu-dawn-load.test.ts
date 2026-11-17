// Finding the Dawn library (src/shim/webgpu-dawn.ts `load`): one clear message that names the cause when the optional "webgpu"
// package is absent, has no binary for the platform, or does not load; the override and the host's loader are used before
// plain resolution; and the default (hand-built) provider never looks for it.

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fresh = async () => {
  vi.resetModules();
  const shim = await import('../src/shim/webgpu-dawn.js');
  shim.setDawnLoader(null);
  return shim;
};

const installed = ((): boolean => {
  try {
    createRequire(import.meta.url).resolve('webgpu');
    return true;
  } catch {
    return false;
  }
})();

const missingError = (message: string): Error => Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' });

beforeEach(() => {
  vi.stubEnv('KINETOGRAPH_DAWN_MODULE', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('finding the Dawn library', () => {
  it('says the optional package is not installed, and how to install it', async () => {
    const { dawnGlobals, setDawnLoader, DAWN_PACKAGE_VERSION } = await fresh();
    setDawnLoader(() => {
      throw missingError("Cannot find module 'webgpu'\nRequire stack:\n- /x/y.js");
    });
    const message = (() => { try { dawnGlobals(); return ''; } catch (error) { return (error as Error).message; } })();
    expect(message).toMatch(/the optional package "webgpu" \(Dawn for Node\) is not installed/);
    expect(message).toContain(`npm install webgpu@${DAWN_PACKAGE_VERSION}`);
    expect(message).toMatch(/Unset KINETOGRAPH_WEBGPU/);
    expect(message.split('\n')).toHaveLength(1);
  });

  it('says the package has no binary for this platform', async () => {
    const { dawnGlobals, setDawnLoader } = await fresh();
    setDawnLoader(() => {
      throw missingError("Cannot find module '/n/webgpu/dist/linux-riscv64/dawn.node'\nRequire stack:\n- /n/webgpu/index.js");
    });
    expect(() => dawnGlobals()).toThrow(new RegExp(`no Dawn binary for this platform \\(${process.platform}-`));
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

  it('does not look for the library unless Dawn is the provider', async () => {
    const shim = await fresh();
    const loader = vi.fn(() => { throw new Error('should not be asked'); });
    shim.setDawnLoader(loader);
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    expect(shim.dawnRequested()).toBe(false);
    await import('../src/shim/index.js');
    expect(loader).not.toHaveBeenCalled();
  });

  it.skipIf(!installed)('finds an installed "webgpu" by Node resolution when nothing else is set', async () => {
    const { dawnGlobals } = await fresh();
    expect(typeof (dawnGlobals() as any).GPUDevice).toBe('function');
  });
});
