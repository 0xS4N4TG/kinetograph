import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRender,
  continueRender,
  delayRender,
  openRenderHandles,
  resetRenderState,
  setPublicDir,
  staticFile,
  whenRenderIdle,
} from '../src/assets.js';

afterEach(() => resetRenderState());

describe('staticFile', () => {
  it('looks in KINETOGRAPH_PUBLIC_DIR until setPublicDir says otherwise', async () => {
    const before = process.env.KINETOGRAPH_PUBLIC_DIR;
    try {
      vi.resetModules();
      process.env.KINETOGRAPH_PUBLIC_DIR = '/from/env';
      const fresh = await import('../src/assets.js');
      expect(fresh.staticFile('a.png')).toBe('/from/env/a.png');
      fresh.setPublicDir('/explicit');
      expect(fresh.staticFile('a.png')).toBe('/explicit/a.png');
    } finally {
      if (before === undefined) delete process.env.KINETOGRAPH_PUBLIC_DIR;
      else process.env.KINETOGRAPH_PUBLIC_DIR = before;
    }
  });

  it('is an absolute path inside the public directory', () => {
    setPublicDir('/projects/demo/public');
    expect(staticFile('logo.png')).toBe('/projects/demo/public/logo.png');
    expect(staticFile('img/a b.png')).toBe('/projects/demo/public/img/a b.png');
    expect(staticFile('/leading/slash.png')).toBe('/projects/demo/public/leading/slash.png');
  });

  it('resolves a relative public directory against the cwd', () => {
    setPublicDir('assets');
    expect(staticFile('x.png')).toBe(join(resolve('assets'), 'x.png'));
  });

  it('refuses URLs and empty names', () => {
    expect(() => staticFile('https://example.com/a.png')).toThrow(/not URLs/);
    expect(() => staticFile('')).toThrow(/public folder/);
  });
});

describe('delayRender', () => {
  it('holds the frame until every handle is continued', async () => {
    const a = delayRender('data');
    const b = delayRender();
    expect(openRenderHandles()).toBe(2);
    let idle = false;
    const waiting = whenRenderIdle().then(() => {
      idle = true;
    });
    continueRender(a);
    await Promise.resolve();
    expect(idle).toBe(false);
    continueRender(b);
    await waiting;
    expect(idle).toBe(true);
    expect(openRenderHandles()).toBe(0);
  });

  it('is idle at once when nothing is open, and ignores unknown or repeated handles', async () => {
    await whenRenderIdle();
    const h = delayRender('x');
    continueRender(h);
    continueRender(h);
    continueRender(9999);
    await whenRenderIdle();
  });

  it('numbers its handles', () => {
    const a = delayRender();
    const b = delayRender();
    expect(typeof a).toBe('number');
    expect(b).not.toBe(a);
  });

  it('fails after its timeout, naming the labels still open', async () => {
    delayRender('fetch the colours', { timeoutInMilliseconds: 30 });
    delayRender('other', { timeoutInMilliseconds: 10_000 });
    await expect(whenRenderIdle()).rejects.toThrow(/"fetch the colours".*not cleared after 30ms.*"fetch the colours", "other"/s);
    // the failure stays: later waits fail too
    await expect(whenRenderIdle()).rejects.toThrow(/not cleared/);
  });

  it('does not fail once the handle was continued in time', async () => {
    const h = delayRender('quick', { timeoutInMilliseconds: 40 });
    continueRender(h);
    await new Promise((r) => setTimeout(r, 80));
    await whenRenderIdle();
  });

  it('cancelRender fails a wait in progress and later ones', async () => {
    delayRender('never');
    const waiting = whenRenderIdle();
    cancelRender(new Error('network down'));
    await expect(waiting).rejects.toThrow('network down');
    await expect(whenRenderIdle()).rejects.toThrow('network down');
  });

  it('cancelRender takes a string too', async () => {
    cancelRender('bad data');
    await expect(whenRenderIdle()).rejects.toThrow('bad data');
  });
});
