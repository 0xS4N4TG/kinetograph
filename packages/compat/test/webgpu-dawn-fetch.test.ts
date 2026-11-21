// scripts/fetch-dawn.mjs cleans its output folder of what is not Dawn's; it refuses a folder that holds other things and was not made by it.

import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
});
