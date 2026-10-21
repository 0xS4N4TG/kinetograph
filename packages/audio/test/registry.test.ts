import { afterEach, describe, expect, it } from 'vitest';
import { clearOnFrame, hasOnFrame, onFrame } from '../src/index.js';
import { registeredCallbacks } from '../src/registry.js';

afterEach(() => clearOnFrame());

describe('onFrame registry', () => {
  it('lives on globalThis under Symbol.for, so every copy of the package shares it', () => {
    const noop = (): void => {};
    onFrame(3, noop);
    const holder = globalThis as unknown as Record<symbol, { entries: { frame: number }[] }>;
    expect(holder[Symbol.for('kinetograph.audio')]!.entries.map((e) => e.frame)).toEqual([3]);
  });

  it('returns the callbacks of a range in frame order, then registration order', () => {
    const order: string[] = [];
    onFrame(10, () => order.push('c'));
    onFrame(2, () => order.push('a'));
    onFrame(2, () => order.push('b'));
    onFrame(50, () => order.push('out of range'));
    const picked = registeredCallbacks(0, 20);
    expect(picked.map((p) => p.frame)).toEqual([2, 2, 10]);
    for (const p of picked) p.callback(undefined as never, 0);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(hasOnFrame(0, 20)).toBe(true);
    expect(hasOnFrame(11, 49)).toBe(false);
  });

  it('clears', () => {
    onFrame(1, () => {});
    clearOnFrame();
    expect(hasOnFrame(0, 100)).toBe(false);
  });

  it('takes a fractional frame, for a cue between two frames', () => {
    onFrame(1.5, () => {});
    expect(registeredCallbacks(0, 3).map((p) => p.frame)).toEqual([1.5]);
    expect(registeredCallbacks(2, 3)).toEqual([]);
  });

  it('rejects a frame that is not a finite number from 0, and a callback that is not a function', () => {
    expect(() => onFrame(-1, () => {})).toThrow(RangeError);
    expect(() => onFrame(Number.NaN, () => {})).toThrow(RangeError);
    expect(() => onFrame(Infinity, () => {})).toThrow(RangeError);
    expect(() => onFrame(0, 'x' as never)).toThrow(TypeError);
  });
});
