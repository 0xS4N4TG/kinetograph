import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { seekTimelines } from '../src/hyperframes/index.js';

const loaded = createRequire(import.meta.url)('gsap') as { gsap?: typeof import('gsap').gsap; default?: typeof import('gsap').gsap };
const gsap = (loaded.gsap ?? loaded.default ?? loaded) as typeof import('gsap').gsap;

describe('seeking a GSAP timeline as HyperFrames does', () => {
  it('applies the set()s at time 0 on a timeline that has never rendered', () => {
    const target = { opacity: 0 };
    const tl = gsap.timeline({ paused: true });
    tl.set(target, { opacity: 1 }, 0);
    seekTimelines({ main: tl as never }, 'main', 0, () => null);
    expect(target.opacity).toBe(1);
  });

  it('lands the steps at one instant in authored order, whichever way the playhead comes', () => {
    const target = { x: 0 };
    const tl = gsap.timeline({ paused: true });
    tl.set(target, { x: 1 }, 1);
    tl.set(target, { x: 2 }, 1);
    tl.to(target, { x: 10, duration: 1, ease: 'none' }, 2);
    const at = (t: number): number => {
      seekTimelines({ main: tl as never }, 'main', t, () => null);
      return target.x;
    };
    expect(at(1)).toBe(2);
    expect(at(2.5)).toBeCloseTo(6, 9);
    expect(at(1)).toBe(2);
    expect(at(0)).toBe(0);
    expect(at(3)).toBe(10);
  });

  it('does not run the callback of a zero-length tween twice', () => {
    let runs = 0;
    const tl = gsap.timeline({ paused: true });
    tl.call(() => runs++, [], 1);
    seekTimelines({ main: tl as never }, 'main', 1, () => null);
    expect(runs).toBe(1);
  });

  it('reports a seek that failed instead of dropping it', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ v: 0 }, { v: 1, duration: 1, onUpdate: () => { throw new Error('boom'); } }, 0);
    const failures: string[] = [];
    seekTimelines({ main: tl as never }, 'main', 0.5, () => null, false, (m) => failures.push(m));
    expect(failures.join()).toContain('boom');
  });
});
