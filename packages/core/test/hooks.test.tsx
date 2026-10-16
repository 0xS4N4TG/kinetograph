import { describe, expect, it } from 'vitest';
import {
  continueRender,
  delayRender,
  Freeze,
  useBufferState,
  useCurrentScale,
  useDelayRender,
  useIsInsideNonPremountFreeze,
  usePixelDensity,
  useRemotionEnvironment,
  getRemotionEnvironment,
  cancelRender,
} from '../src/index.js';
import { renderAt } from './scene-harness.js';

/** Renders `hook` once, in a composition, and returns what it gave. */
function read<T>(hook: () => T, wrap: (node: React.ReactNode) => React.ReactNode = (node) => node): T {
  let value!: T;
  function Probe() {
    value = hook();
    return null;
  }
  renderAt(wrap(<Probe />));
  return value;
}

describe('the preview-state hooks', () => {
  it('give what a render sees: scale 1 and pixel density 1, with or without the outside-Remotion option', () => {
    expect(read(() => useCurrentScale())).toBe(1);
    expect(read(() => useCurrentScale({ dontThrowIfOutsideOfRemotion: true }))).toBe(1);
    expect(read(() => usePixelDensity())).toBe(1);
    expect(read(() => usePixelDensity({ dontThrowIfOutsideOfRemotion: true }))).toBe(1);
  });

  it('useRemotionEnvironment is getRemotionEnvironment, and the same object every time', () => {
    const env = read(() => useRemotionEnvironment());
    expect(env).toEqual(getRemotionEnvironment());
    expect(env.isRendering).toBe(true);
    expect(read(() => useRemotionEnvironment())).toBe(env);
  });

  it('useBufferState has nothing to hold: delayPlayback hands back an unblock that does nothing', () => {
    const buffer = read(() => useBufferState());
    const handle = buffer.delayPlayback();
    expect(() => {
      handle.unblock();
      handle.unblock();
    }).not.toThrow();
    expect(read(() => useBufferState())).toBe(buffer);
  });

  it('useIsInsideNonPremountFreeze is true inside an active Freeze only', () => {
    expect(read(() => useIsInsideNonPremountFreeze())).toBe(false);
    expect(read(() => useIsInsideNonPremountFreeze(), (node) => <Freeze frame={3}>{node}</Freeze>)).toBe(true);
    expect(read(() => useIsInsideNonPremountFreeze(), (node) => <Freeze frame={3} active={false}>{node}</Freeze>)).toBe(false);
  });
});

describe('useDelayRender', () => {
  it('hands out the delayRender family, which holds the frame like the global functions', () => {
    const hook = read(() => useDelayRender());
    expect(hook).toEqual({ delayRender, continueRender, cancelRender });
    const handle = hook.delayRender('data');
    expect(typeof handle).toBe('number');
    hook.continueRender(handle);
  });
});
