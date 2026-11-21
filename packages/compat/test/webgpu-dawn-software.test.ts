// Dawn with no GPU (src/shim/dawn-software.ts): which software backend is asked for, where the SwiftShader ICD file is found, and that the
// Vulkan loader's environment is set and put back. None of it needs the library.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { softwareChoice, swiftshaderIcd, useSwiftshader } from '../src/shim/dawn-software.js';

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
