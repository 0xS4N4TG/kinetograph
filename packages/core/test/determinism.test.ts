import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installDeterminism,
  realTimers,
  resetVirtualClock,
  setVirtualFrame,
  uninstallDeterminism,
  VIRTUAL_EPOCH_MS,
} from '../src/determinism.js';

const raf = (cb: (t: number) => void): number => (globalThis as any).requestAnimationFrame(cb);
const caf = (id: number): void => (globalThis as any).cancelAnimationFrame(id);

beforeEach(() => {
  installDeterminism();
  resetVirtualClock();
});
afterEach(() => uninstallDeterminism());

describe('virtual time', () => {
  it('derives Date, new Date() and performance.now() from the frame', () => {
    setVirtualFrame(0, 30);
    expect(Date.now()).toBe(VIRTUAL_EPOCH_MS);
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(performance.now()).toBe(0);

    setVirtualFrame(45, 30);
    expect(Date.now()).toBe(VIRTUAL_EPOCH_MS + 1500);
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:01.500Z');
    expect(performance.now()).toBe(1500);

    setVirtualFrame(1, 60);
    expect(performance.now()).toBeCloseTo(1000 / 60, 9);
  });

  it('leaves explicit dates and Date statics alone', () => {
    setVirtualFrame(10, 30);
    expect(new Date(2020, 5, 17).getFullYear()).toBe(2020);
    expect(new Date('2021-03-04T05:06:07Z').toISOString()).toBe('2021-03-04T05:06:07.000Z');
    expect(Date.UTC(2000, 0, 1)).toBe(946684800000);
    expect(Date.parse('1970-01-01T00:00:01Z')).toBe(1000);
    expect(new Date() instanceof Date).toBe(true);
    expect(typeof Date()).toBe('string');
    class Sub extends Date {}
    expect(new Sub(5).getTime()).toBe(5);
  });
});

describe('Math.random', () => {
  it('is reseeded from the frame number', () => {
    setVirtualFrame(7, 30);
    const first = [Math.random(), Math.random(), Math.random()];
    setVirtualFrame(8, 30);
    const other = [Math.random(), Math.random(), Math.random()];
    setVirtualFrame(7, 30);
    const again = [Math.random(), Math.random(), Math.random()];
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
    for (const v of [...first, ...other]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('starts from a fixed seed before the first frame', () => {
    resetVirtualClock();
    const a = [Math.random(), Math.random()];
    resetVirtualClock();
    expect([Math.random(), Math.random()]).toEqual(a);
  });

  it('can keep a frame seed while the clock sits on a sub-frame', () => {
    setVirtualFrame(12, 30);
    const main = Math.random();
    setVirtualFrame(11.75, 30, { seedFrame: 12, fireTimers: false });
    expect(Math.random()).toBe(main);
  });
});

describe('crypto', () => {
  it('draws getRandomValues and randomUUID from the seeded generator', () => {
    setVirtualFrame(7, 30);
    const a = [crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];
    setVirtualFrame(7, 30);
    const b = [crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    setVirtualFrame(8, 30);
    expect(crypto.randomUUID()).not.toBe(a[0]);
  });
});

describe('virtual timers', () => {
  it('fires setTimeout callbacks in due order when the clock passes them', () => {
    const log: string[] = [];
    setVirtualFrame(0, 30);
    setTimeout(() => log.push('b'), 100);
    setTimeout(() => log.push('a'), 50);
    setTimeout(() => log.push('c'), 100);
    setTimeout((x: string) => log.push(x), 10_000, 'late');
    expect(log).toEqual([]);

    setVirtualFrame(1, 30); // 33.3 ms
    expect(log).toEqual([]);
    setVirtualFrame(2, 30); // 66.7 ms
    expect(log).toEqual(['a']);
    setVirtualFrame(4, 30); // 133 ms
    expect(log).toEqual(['a', 'b', 'c']);
    setVirtualFrame(299, 30);
    expect(log).toEqual(['a', 'b', 'c']);
    setVirtualFrame(301, 30); // 10033 ms
    expect(log).toEqual(['a', 'b', 'c', 'late']);
  });

  it('clearTimeout cancels, by handle or by number', () => {
    const log: string[] = [];
    setVirtualFrame(0, 30);
    const a = setTimeout(() => log.push('a'), 10);
    const b = setTimeout(() => log.push('b'), 10);
    clearTimeout(a);
    clearTimeout(Number(b));
    setVirtualFrame(5, 30);
    expect(log).toEqual([]);
  });

  it('gives callbacks the virtual time of their due moment', () => {
    const seen: number[] = [];
    setVirtualFrame(0, 30);
    setTimeout(() => seen.push(performance.now()), 40);
    setVirtualFrame(30, 30);
    expect(seen).toEqual([40]);
    expect(performance.now()).toBe(1000);
  });

  it('re-arms setInterval from its due time and stops when cleared', () => {
    const times: number[] = [];
    setVirtualFrame(0, 30);
    const handle = setInterval(() => times.push(performance.now()), 250);
    setVirtualFrame(30, 30); // 1000 ms
    expect(times).toEqual([250, 500, 750, 1000]);
    clearInterval(handle);
    setVirtualFrame(60, 30);
    expect(times.length).toBe(4);
  });

  it('runs timers set from inside a callback that are already due', () => {
    const log: string[] = [];
    setVirtualFrame(0, 30);
    setTimeout(() => {
      log.push('first');
      setTimeout(() => log.push('second'), 20);
    }, 10);
    setVirtualFrame(3, 30); // 100 ms
    expect(log).toEqual(['first', 'second']);
  });

  it('does not fire timers while the clock is only repositioned', () => {
    const log: string[] = [];
    setVirtualFrame(0, 30);
    setTimeout(() => log.push('x'), 10);
    setVirtualFrame(30, 30, { fireTimers: false });
    expect(log).toEqual([]);
    setVirtualFrame(30, 30);
    expect(log).toEqual(['x']);
  });

  it('refuses a self-re-arming zero-delay interval instead of hanging', () => {
    setVirtualFrame(0, 30);
    setInterval(() => undefined, 0);
    expect(() => setVirtualFrame(10_000, 30)).toThrow(/more than 100000 times/);
  });

  it('gives Node-style handles', () => {
    const handle = setTimeout(() => undefined, 5);
    expect(typeof handle.unref).toBe('function');
    expect(handle.hasRef()).toBe(true);
    expect(typeof Number(handle)).toBe('number');
  });

  it('keeps the real timers for the shim itself', () => {
    expect(realTimers.setTimeout).not.toBe(globalThis.setTimeout);
    expect(typeof realTimers.setImmediate).toBe('function');
  });
});

describe('requestAnimationFrame', () => {
  it('runs each callback once, on the next frame, with the virtual time', () => {
    const calls: [string, number][] = [];
    setVirtualFrame(0, 30);
    raf((t: number) => {
      calls.push(['a', t]);
      raf((u: number) => calls.push(['again', u]));
    });
    const cancelled = raf(() => calls.push(['no', -1]));
    caf(cancelled);
    expect(calls).toEqual([]);

    setVirtualFrame(3, 30);
    expect(calls).toEqual([['a', 100]]);
    setVirtualFrame(4, 30);
    expect(calls).toEqual([['a', 100], ['again', (4 / 30) * 1000]]);
    setVirtualFrame(5, 30);
    expect(calls.length).toBe(2);
  });
});

describe('install', () => {
  it('is idempotent and reversible', () => {
    installDeterminism();
    installDeterminism();
    uninstallDeterminism();
    expect(Date.now()).toBeGreaterThan(VIRTUAL_EPOCH_MS);
    const real = [Math.random(), Math.random()];
    expect(real[0]).not.toBe(real[1]);
    expect(typeof (globalThis as any).requestAnimationFrame).toBe('undefined');
    installDeterminism();
  });
});
