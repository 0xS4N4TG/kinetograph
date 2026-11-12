import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFonts, getFonts } from '../src/font-registry.js';
import { registerCssFontFace } from '../src/web-install.js';

describe('a font of a remote stylesheet', () => {
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    clearFonts();
    // A download would put its file under the home folder's cache: this one is empty and checked after.
    home = mkdtempSync(join(tmpdir(), 'kg-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    const dir = mkdtempSync(join(tmpdir(), 'kg-lock-'));
    writeFileSync(join(dir, 'kinetograph.lock.json'), JSON.stringify({ version: 1, files: {} }));
    process.env.KINETOGRAPH_LOCK_FILE = join(dir, 'kinetograph.lock.json');
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.KINETOGRAPH_LOCK_FILE;
    vi.restoreAllMocks();
  });

  it('that is not in the lock is not fetched and not registered, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCssFontFace({ family: 'Remote', url: 'https://fonts.example/f/a.ttf', weight: '400', style: 'normal', remote: true });
    expect(existsSync(join(home, '.cache'))).toBe(false);
    expect(getFonts()).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not downloaded and locked.*fetch-deps/));
  });

  it('that is not https, or names a project file, is never read from the project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCssFontFace({ family: 'Local', url: '/etc/passwd', weight: '400', style: 'normal', remote: true });
    registerCssFontFace({ family: 'Plain', url: 'http://plain.test/a.ttf', weight: '400', style: 'normal', remote: true });
    expect(existsSync(join(home, '.cache'))).toBe(false);
    expect(getFonts()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
