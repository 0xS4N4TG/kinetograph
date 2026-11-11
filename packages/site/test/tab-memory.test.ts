import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ENGINE_KEY, pickTab, readEngine, subscribeEngine, writeEngine } from '../src/lib/tab-memory';

function fakeBrowser(storage: Storage | null) {
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    dispatchEvent: (e: Event) => listeners.get(e.type)?.forEach((fn) => fn()),
  });
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as Storage;
}

describe('pickTab', () => {
  it('opens the remembered project type, else the first tab', () => {
    expect(pickTab(['remotion', 'hyperframes'], 'hyperframes')).toBe(1);
    expect(pickTab(['remotion', 'hyperframes'], null)).toBe(0);
    expect(pickTab(['macos', 'linux'], 'hyperframes')).toBe(0);
  });
});

describe('engine memory', () => {
  beforeEach(() => fakeBrowser(memoryStorage()));

  it('keeps the choice in one shared key and tells every group', () => {
    const seen = vi.fn();
    const off = subscribeEngine(seen);
    expect(readEngine()).toBeNull();
    writeEngine('hyperframes');
    expect(localStorage.getItem(ENGINE_KEY)).toBe('hyperframes');
    expect(readEngine()).toBe('hyperframes');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    writeEngine('remotion');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored value that is not a project type', () => {
    localStorage.setItem(ENGINE_KEY, 'macos');
    expect(readEngine()).not.toBe('macos');
  });

  it('still remembers for the page when storage is blocked', () => {
    fakeBrowser({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage);
    writeEngine('hyperframes');
    expect(readEngine()).toBe('hyperframes');
  });
});
