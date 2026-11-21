// Dawn with no GPU (src/shim/dawn-software.ts): which software backend is asked for, where the SwiftShader ICD file is found, and that the
// Vulkan loader's environment is set and put back. None of it needs the library.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepSwiftshader, softwareChoice, swiftshaderIcd, useSwiftshader, withSwiftshader } from '../src/shim/dawn-software.js';

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
  it('names the ICD file in both variables, and puts back what was there', () => {
    const env: Record<string, string | undefined> = { VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' };
    const undo = useSwiftshader('/p/angle/vk_swiftshader_icd.json', env);
    expect(env).toEqual({ VK_DRIVER_FILES: '/p/angle/vk_swiftshader_icd.json', VK_ICD_FILENAMES: '/p/angle/vk_swiftshader_icd.json' });
    undo();
    expect(env).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' });
  });
});

describe('the loader\'s environment around the making of an instance', () => {
  const icd = '/p/angle/vk_swiftshader_icd.json';

  it('is SwiftShader\'s while the instance is made, and the process\'s own again right after', () => {
    const env: Record<string, string | undefined> = { VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' };
    const seen = withSwiftshader(icd, () => ({ ...env }), env, true);
    expect(seen).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
    expect(env).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' });
    expect(() => withSwiftshader(icd, () => { throw new Error('no'); }, env, true)).toThrow('no');
    expect(env).toEqual({ VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp.json' });
  });

  it('is left as it is when the process was already pointed at SwiftShader (the main thread chose, before the workers were made)', () => {
    const env: Record<string, string | undefined> = {};
    keepSwiftshader(icd, env, true);
    expect(withSwiftshader(icd, () => 1, env, true)).toBe(1);
    expect(env).toEqual({ VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd });
  });

  it('is never touched in a worker, where it is a copy that native code does not read', () => {
    const env: Record<string, string | undefined> = {};
    expect(withSwiftshader(icd, () => ({ ...env }), env, false)).toEqual({});
    keepSwiftshader(icd, env, false);
    expect(env).toEqual({});
  });
});
