// scripts/fetch-dawn.mjs cleans its output folder of what is not Dawn's; it refuses a folder that holds other things and was not made by it. On Linux
// and Windows it takes the Vulkan loader from the ANGLE files beside it, only with a SHA-256 fetch-angle.mjs pins, before it downloads anything.

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = new URL('../../../scripts/fetch-dawn.mjs', import.meta.url).href;

describe('fetch-dawn', () => {
  it('does not delete the files of a folder that has no SOURCE.txt', async () => {
    const { fetchDawn } = (await import(/* @vite-ignore */ script)) as { fetchDawn: (platform: string, options: { cacheDir: string; outDir: string }) => Promise<string> };
    const dir = mkdtempSync(join(tmpdir(), 'kg-fetch-dawn-'));
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    await expect(fetchDawn('darwin-arm64', { cacheDir: join(dir, 'cache'), outDir: dir })).rejects.toThrow(/not empty and has no SOURCE\.txt/);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });

  it('wants the Vulkan loader of the ANGLE files beside dawn/ on Linux and Windows, as fetch-angle.mjs pins it', async () => {
    const { fetchDawn } = (await import(/* @vite-ignore */ script)) as { fetchDawn: (platform: string, options: { cacheDir: string; outDir: string }) => Promise<string> };
    const root = mkdtempSync(join(tmpdir(), 'kg-fetch-dawn-'));
    const options = { cacheDir: join(root, 'cache'), outDir: join(root, 'dawn') };
    await expect(fetchDawn('linux-x64-gnu', options)).rejects.toThrow(/angle\/libvulkan\.so\.1 is missing: run `node scripts\/fetch-angle\.mjs linux-x64-gnu --swiftshader` first/);
    await expect(fetchDawn('win32-x64-msvc', options)).rejects.toThrow(/angle\/vulkan-1\.dll is missing/);
    mkdirSync(join(root, 'angle'));
    writeFileSync(join(root, 'angle', 'libvulkan.so.1'), 'not the pinned loader');
    await expect(fetchDawn('linux-x64-gnu', options)).rejects.toThrow(/libvulkan\.so\.1: SHA-256 is \w+, which scripts\/fetch-angle\.mjs does not pin \(c23b764de4fb9c91.*, 7d87578de91b0407/);
    expect(readdirSync(root).sort()).toEqual(['angle']);
  });
});
