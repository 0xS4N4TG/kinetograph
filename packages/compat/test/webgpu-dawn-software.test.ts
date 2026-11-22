// Dawn with no GPU (src/shim/dawn-software.ts): which software backend is asked for, where the SwiftShader ICD file is found, and that the
// Vulkan loader's environment is set and put back. None of it needs the library.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { icdFolders, keepSwiftshader, otherVulkanDrivers, softwareChoice, swiftshaderIcd, useSwiftshader, withSwiftshader } from '../src/shim/dawn-software.js';

/** A platform package's folders: `dawn/` and a sibling `angle/` that holds the ICD file and the driver library of the platform. */
function platformPackage(library: string | null): { dawn: string; angle: string } {
  const root = mkdtempSync(join(tmpdir(), 'kg-dawn-sw-'));
  const dawn = join(root, 'dawn');
  const angle = join(root, 'angle');
  mkdirSync(dawn);
  mkdirSync(angle);
  writeFileSync(join(angle, 'vk_swiftshader_icd.json'), '{"file_format_version": "1.0.0", "ICD": {"library_path": "./libvk_swiftshader.so"}}');
  if (library !== null) writeFileSync(join(angle, library), '');
  return { dawn, angle };
}

describe('the software backend that is asked for', () => {
  it('is none unless KINETOGRAPH_WEBGPU_BACKEND says swiftshader, and refuses a name it does not know', () => {
    expect(softwareChoice({})).toBeNull();
    expect(softwareChoice({ KINETOGRAPH_WEBGPU_BACKEND: '' })).toBeNull();
    expect(softwareChoice({ KINETOGRAPH_WEBGPU_BACKEND: 'swiftshader' })).toBe('swiftshader');
    expect(() => softwareChoice({ KINETOGRAPH_WEBGPU_BACKEND: 'lavapipe' })).toThrow(/is not a backend; the one there is: swiftshader/);
  });
});

describe('the SwiftShader ICD file', () => {
  it('is the angle/ folder beside the dawn/ folder, when the driver library is there too', () => {
    const { dawn, angle } = platformPackage('libvk_swiftshader.so');
    expect(swiftshaderIcd(dawn, {}, 'linux')).toBe(join(angle, 'vk_swiftshader_icd.json'));
  });

  it('is none for a package made without the driver library (the ICD file alone names a library that is not there)', () => {
    const { dawn } = platformPackage(null);
    expect(swiftshaderIcd(dawn, {}, 'linux')).toBeNull();
  });

  it('is KINETOGRAPH_ANGLE_DIR first, when it is an absolute path', () => {
    const own = platformPackage('libvk_swiftshader.so');
    const other = platformPackage('libvk_swiftshader.so');
    expect(swiftshaderIcd(other.dawn, { KINETOGRAPH_ANGLE_DIR: own.angle }, 'linux')).toBe(join(own.angle, 'vk_swiftshader_icd.json'));
    expect(swiftshaderIcd(null, { KINETOGRAPH_ANGLE_DIR: 'relative/angle' }, 'linux')).toBeNull();
    expect(swiftshaderIcd(null, {}, 'linux')).toBeNull();
  });
});

describe('the Vulkan loader\'s environment', () => {
  const icd = '/p/angle/vk_swiftshader_icd.json';
  /** A folder the loader reads manifests from, holding `names`. */
  const folder = (...names: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-icd-'));
    for (const name of names) writeFileSync(join(dir, name), '{}');
    return dir;
  };

  it('names the ICD file in place of the drivers when the host has none, and puts back what was there', () => {
    const env: Record<string, string | undefined> = {};
    const undo = useSwiftshader(icd, env, [folder(), '/no/such/icd.d']);
    expect(env).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
    undo();
    expect(env).toEqual({});
  });

  it('adds the ICD file beside the host\'s drivers (a GPU\'s, lavapipe), so the rest of the process keeps them', () => {
    const env: Record<string, string | undefined> = {};
    const undo = useSwiftshader(icd, env, [folder('lvp_icd.x86_64.json')]);
    expect(env).toEqual({ VK_ADD_DRIVER_FILES: icd });
    undo();
    expect(env).toEqual({});
    // Drivers named by hand are the host's too, and an addition made by hand is kept.
    const named: Record<string, string | undefined> = { VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia.json', VK_ADD_DRIVER_FILES: '/opt/extra.json' };
    useSwiftshader(icd, named, []);
    expect(named).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia.json', VK_ADD_DRIVER_FILES: `${icd}:/opt/extra.json` });
  });

  it('finds the host\'s drivers in the loader\'s folders, which the XDG variables move, and not when the variables name SwiftShader alone', () => {
    expect(icdFolders({ HOME: '/home/u' })).toEqual([
      '/home/u/.config/vulkan/icd.d', '/etc/xdg/vulkan/icd.d', '/etc/vulkan/icd.d', '/home/u/.local/share/vulkan/icd.d', '/usr/local/share/vulkan/icd.d', '/usr/share/vulkan/icd.d',
    ]);
    expect(icdFolders({ XDG_DATA_DIRS: '/a:/b', XDG_CONFIG_DIRS: '/c' })).toEqual(['/c/vulkan/icd.d', '/etc/vulkan/icd.d', '/a/vulkan/icd.d', '/b/vulkan/icd.d']);
    expect(otherVulkanDrivers(icd, {}, [folder('notes.txt')])).toBe(false);
    expect(otherVulkanDrivers(icd, {}, [folder('radeon_icd.json')])).toBe(true);
    expect(otherVulkanDrivers(icd, { VK_DRIVER_FILES: icd }, [folder('radeon_icd.json')])).toBe(false);
  });
});

describe('the loader\'s environment around the making of an instance', () => {
  const icd = '/p/angle/vk_swiftshader_icd.json';

  it('has SwiftShader while the instance is made, and is the process\'s own again right after', async () => {
    const env: Record<string, string | undefined> = { VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' };
    const seen = await withSwiftshader(icd, () => ({ ...env }), env, true, []);
    expect(seen).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json', VK_ADD_DRIVER_FILES: icd });
    expect(env).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' });
    await expect(withSwiftshader(icd, () => { throw new Error('no'); }, env, true, [])).rejects.toThrow('no');
    expect(env).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' });
  });

  it('has SwiftShader until the work settles, not only while it is started', async () => {
    const env: Record<string, string | undefined> = {};
    const seen = await withSwiftshader(icd, async () => { await new Promise((resolve) => setImmediate(resolve)); return { ...env }; }, env, true, []);
    expect(seen).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
    expect(env).toEqual({});
  });

  it('runs two scopes at once one after the other, each with SwiftShader, and leaves the environment as it was before either', async () => {
    const env: Record<string, string | undefined> = { VK_ADD_DRIVER_FILES: '/opt/extra.json' };
    const seen: (string | undefined)[] = [];
    const later = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(env.VK_ADD_DRIVER_FILES);
    };
    await Promise.all([withSwiftshader(icd, later, env, true, ['/no/such/icd.d']), withSwiftshader(icd, later, env, true, ['/no/such/icd.d'])]);
    expect(seen).toEqual([`${icd}:/opt/extra.json`, `${icd}:/opt/extra.json`]);
    expect(env).toEqual({ VK_ADD_DRIVER_FILES: '/opt/extra.json' });
  });

  it('runs a scope opened inside another in it, and keeps for the process what `keepSwiftshader` asks for during one', async () => {
    const env: Record<string, string | undefined> = {};
    const inner = await withSwiftshader(icd, () => withSwiftshader(icd, async () => { await null; return { ...env }; }, env, true, []), env, true, []);
    expect(inner).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
    expect(env).toEqual({});
    await withSwiftshader(icd, async () => { await null; keepSwiftshader(icd, env, true, []); }, env, true, []);
    expect(env).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
  });

  it('is left as it is when the process was already pointed at SwiftShader (the main thread chose, before the workers were made)', async () => {
    for (const env of [{}, { VK_ADD_DRIVER_FILES: '/opt/extra.json' }] as Record<string, string | undefined>[]) {
      keepSwiftshader(icd, env, true, []);
      const kept = { ...env };
      expect(await withSwiftshader(icd, () => 1, env, true, [])).toBe(1);
      keepSwiftshader(icd, env, true, []);
      expect(env).toEqual(kept);
    }
  });

  it('is never touched in a worker, where it is a copy that native code does not read', async () => {
    const env: Record<string, string | undefined> = {};
    expect(await withSwiftshader(icd, () => ({ ...env }), env, false, [])).toEqual({});
    keepSwiftshader(icd, env, false, []);
    expect(env).toEqual({});
  });
});

// A Dawn whose Vulkan loader reads its variables on a later tick of the first adapter request, or when the instance is made
// (fixtures/fake-dawn-late.cjs), on a Linux host with no Vulkan driver: SwiftShader is found either way, and the variables are put back after.
describe('the loader\'s environment for a Dawn that reads it late', () => {
  const NAMES = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'VK_ADD_DRIVER_FILES'] as const;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const { angle } = platformPackage('libvk_swiftshader.so');
  const empty = mkdtempSync(join(tmpdir(), 'kg-xdg-'));

  beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }));
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  });

  it('has SwiftShader until the adapter request settles, and while the instance is made, found or forced', async () => {
    for (const [reads, forced] of [['later', false], ['create', false], ['later', true], ['create', true]] as const) {
      for (const name of NAMES) vi.stubEnv(name, undefined);
      for (const name of ['KINETOGRAPH_DAWN_BACKEND', 'KINETOGRAPH_DAWN_ADAPTER']) vi.stubEnv(name, '');
      vi.stubEnv('KINETOGRAPH_WEBGPU_BACKEND', forced ? 'swiftshader' : '');
      vi.stubEnv('KINETOGRAPH_DAWN_MODULE', fileURLToPath(new URL('./fixtures/fake-dawn-late.cjs', import.meta.url)));
      vi.stubEnv('KINETOGRAPH_ANGLE_DIR', angle);
      vi.stubEnv('FAKE_DAWN_READS', reads);
      for (const name of ['XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_DATA_DIRS']) vi.stubEnv(name, empty);
      const shared = (globalThis as any)[Symbol.for('kinetograph.dawn.shared')];
      if (shared) Object.assign(shared, { adapter: null, probe: null, softwareInstances: new Map() });
      vi.resetModules();
      const { describeDawn } = await import('../src/shim/webgpu-dawn.js');
      expect(await describeDawn(), `${reads}${forced ? ', forced' : ''}`).toMatchObject({ ok: true, adapter: { via: 'swiftshader' } });
      expect(NAMES.map((name) => process.env[name])).toEqual([undefined, undefined, undefined]);
    }
  });
});
