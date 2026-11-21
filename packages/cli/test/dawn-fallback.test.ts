// Dawn as the provider is decided once before a project runs (src/dawn.ts `prepareCliDawn`): when no adapter can be had, the built-in WebGPU
// layer draws instead, with one warning, and `KINETOGRAPH_WEBGPU` is `builtin` in the environment the render inherits.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The Vulkan loader's environment the process (and so its workers, the compositor, ANGLE) ends up with on Linux, decided on the main thread with a
// stand-in for dawn.node (fixtures/fake-dawn.cjs) whose adapters are the drivers that environment would give the loader.
describe('the Vulkan loader\'s environment Dawn leaves the process (Linux)', () => {
  const NAMES = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'VK_ADD_DRIVER_FILES'] as const;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const angle = mkdtempSync(join(tmpdir(), 'kg-angle-'));
  const icd = join(angle, 'vk_swiftshader_icd.json');
  writeFileSync(icd, '{}');
  writeFileSync(join(angle, 'libvk_swiftshader.so'), '');
  const empty = mkdtempSync(join(tmpdir(), 'kg-xdg-'));
  const withDriver = mkdtempSync(join(tmpdir(), 'kg-xdg-'));
  mkdirSync(join(withDriver, 'vulkan', 'icd.d'), { recursive: true });
  writeFileSync(join(withDriver, 'vulkan', 'icd.d', 'host_icd.json'), '{}');

  beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }));
  afterEach(() => Object.defineProperty(process, 'platform', platform));

  async function decide(host: string, { loader = 'new', forced = false } = {}): Promise<{ env: Record<string, string>; said: string[] }> {
    for (const name of NAMES) vi.stubEnv(name, undefined);
    vi.stubEnv('KINETOGRAPH_WEBGPU', '');
    vi.stubEnv('KINETOGRAPH_WEBGPU_BACKEND', forced ? 'swiftshader' : '');
    vi.stubEnv('KINETOGRAPH_DAWN_MODULE', fileURLToPath(new URL('./fixtures/fake-dawn.cjs', import.meta.url)));
    vi.stubEnv('KINETOGRAPH_ANGLE_DIR', angle);
    vi.stubEnv('FAKE_VULKAN_HOST', host);
    vi.stubEnv('FAKE_VULKAN_LOADER', loader);
    for (const name of ['XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME']) vi.stubEnv(name, empty);
    vi.stubEnv('XDG_DATA_DIRS', host === '' ? empty : withDriver);
    // What the process remembers of Dawn (the probe's instance, SwiftShader's): each case is a new process.
    const shared = (globalThis as any)[Symbol.for('kinetograph.dawn.shared')];
    if (shared) Object.assign(shared, { adapter: null, probe: null, softwareInstances: [] });
    const said: string[] = [];
    await prepareCliDawn((message) => said.push(message));
    const env: Record<string, string> = {};
    for (const name of [...NAMES, 'KINETOGRAPH_WEBGPU'] as const) if (process.env[name]) env[name] = process.env[name]!;
    return { env, said };
  }

  it('is untouched with a GPU Dawn takes, and on a host whose only driver is lavapipe (the system\'s fallback adapter, before SwiftShader)', async () => {
    expect(await decide('gpu')).toEqual({ env: {}, said: [] });
    expect(await decide('lavapipe')).toEqual({ env: {}, said: [] });
    expect(await decide('lavapipe', { loader: 'old' })).toEqual({ env: {}, said: [] });
  });

  it('names SwiftShader in place of the drivers on a host with none, which every loader reads', async () => {
    expect(await decide('')).toEqual({ env: { VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd }, said: [] });
    expect(await decide('', { loader: 'old' })).toEqual({ env: { VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd }, said: [] });
  });

  it('adds SwiftShader beside a GPU that Dawn refuses, or when it is forced on a host with drivers, so the compositor keeps the GPU', async () => {
    expect(await decide('gpu-dawn-refuses')).toEqual({ env: { VK_ADD_DRIVER_FILES: icd }, said: [] });
    expect(await decide('gpu', { forced: true })).toEqual({ env: { VK_ADD_DRIVER_FILES: icd }, said: [] });
    expect(await decide('lavapipe', { forced: true })).toEqual({ env: { VK_ADD_DRIVER_FILES: icd }, said: [] });
    expect(await decide('', { forced: true })).toEqual({ env: { VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd }, said: [] });
  });

  it('gives the render to the built-in WebGPU, and leaves the drivers alone, where the loader is too old to add SwiftShader beside them', async () => {
    for (const [host, forced] of [['gpu-dawn-refuses', false], ['gpu', true]] as const) {
      const { env, said } = await decide(host, { loader: 'old', forced });
      expect(env).toEqual({ KINETOGRAPH_WEBGPU: 'builtin' });
      expect(said).toEqual([expect.stringMatching(/^warning: WebGPU through Dawn cannot be used here.*Vulkan loader 1\.3\.234 or newer/)]);
    }
  });
});
