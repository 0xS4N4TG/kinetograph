import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Audio,
  Config,
  Experimental,
  getStaticFiles,
  Html5Audio,
  Html5Video,
  MediaPlaybackError,
  prefetch,
  setPublicDir,
  staticFile,
  Video,
  watchStaticFile,
} from '../src/index.js';
import { renderAt } from './scene-harness.js';
import { resetWarnings } from '../src/warn.js';

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-public-'));
  setPublicDir(dir);
  resetWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('getStaticFiles', () => {
  it('lists the public folder, nested files included, in the order of their names', () => {
    writeFileSync(join(dir, 'b.txt'), 'bb');
    writeFileSync(join(dir, 'a.png'), '12345');
    mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'deep', 'c.mp3'), '1');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    const files = getStaticFiles();
    expect(files.map((f) => f.name)).toEqual(['a.png', 'b.txt', 'sub/deep/c.mp3']);
    expect(files.map((f) => f.sizeInBytes)).toEqual([5, 2, 1]);
    expect(files.map((f) => f.src)).toEqual(['a.png', 'b.txt', 'sub/deep/c.mp3'].map((name) => staticFile(name)));
    for (const file of files) expect(file.lastModified).toBeGreaterThan(0);
  });

  it('is empty without a public folder', () => {
    setPublicDir(join(dir, 'missing'));
    expect(getStaticFiles()).toEqual([]);
  });
});

describe('watchStaticFile', () => {
  it('does nothing, says so once, and hands back a cancel', () => {
    const callback = vi.fn();
    const watcher = watchStaticFile('a.png', callback);
    watchStaticFile('b.png', callback);
    expect(() => watcher.cancel()).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('prefetch', () => {
  it('resolves at once with the source, minus its hash fragment', async () => {
    const handle = prefetch(`${staticFile('clip.mp4')}#t=2`);
    await expect(handle.waitUntilDone()).resolves.toBe(staticFile('clip.mp4'));
    expect(() => handle.free()).not.toThrow();
  });

  it('refuses a remote URL like every other offline call', () => {
    expect(() => prefetch('https://example.com/clip.mp4')).toThrow(/remote URLs are not available.*offline/);
  });
});

describe('MediaPlaybackError', () => {
  it('is an Error that keeps the source', () => {
    const error = new MediaPlaybackError({ message: 'cannot decode', src: 'a.mp4' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MediaPlaybackError');
    expect(error.message).toBe('cannot decode');
    expect(error.src).toBe('a.mp4');
  });
});

describe('Html5Audio and Html5Video', () => {
  it('are the engine\'s <Audio> and <Video>', () => {
    expect(Html5Audio).toBe(Audio);
    expect(Html5Video).toBe(Video);
  });
});

describe('Experimental', () => {
  it('throws for the removed components, as Remotion does, and has no player', () => {
    const Clipper = Experimental.Clipper;
    const Null = Experimental.Null;
    expect(() => renderAt(<Clipper />)).toThrow(/<Clipper> has been removed/);
    expect(() => renderAt(<Null />)).toThrow(/<Null> has been removed/);
    let isPlayer: boolean | undefined;
    function Probe() {
      isPlayer = Experimental.useIsPlayer();
      return null;
    }
    renderAt(<Probe />);
    expect(isPlayer).toBe(false);
  });
});

describe('Config', () => {
  it('accepts any call through any group, does nothing, and says where the options go once', () => {
    expect(() => Config.Rendering.setImageFormat('jpeg')).not.toThrow();
    Config.Bundling.overrideWebpackConfig((c: unknown) => c);
    Config.setCodec('h264');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/no remotion\.config\.ts/);
  });
});
