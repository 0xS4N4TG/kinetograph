// The Web Animations API on the virtual clock (../src/shim/animations.ts): values against Chrome for Testing
// (fixtures/waapi-chrome.json, made by tools/waapi-chrome.mjs from fixtures/waapi-cases.json), and the timing model:
// pending tasks, finish and cancel, events and promises, getAnimations.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { animatedStyleOf, AnimationShim, KeyframeEffectShim, resetAnimations, setAnimationClock, tickAnimations } from '../src/shim/animations.js';
import { parseColor } from '../src/shim/css-color.js';
import { domElementFor } from '../src/shim/element.js';
import type { HostElement } from '../src/shim/host.js';
import { cssTransformMatrix } from '../src/shim/svg-transform.js';
import { createHostElement } from '../src/shim/tree.js';

let now = 0;
beforeEach(() => {
  now = 0;
  setAnimationClock(() => now);
  resetAnimations();
});
afterEach(() => resetAnimations());

const element = (style: Record<string, string> = {}) => {
  const host = createHostElement('div');
  const el = domElementFor(host) as any;
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  return { host, el };
};
const valueOf = (host: HostElement, property: string): string => animatedStyleOf(host)?.get(property) ?? '';

/** Every number in a CSS value (a colour as its rgba), with `calc(a + b)` of px and % summed against a 400 px box. */
function numbers(property: string, value: string): number[] {
  if (property === 'transform') {
    const m = cssTransformMatrix(value, '0px 0px', { x: 0, y: 0, width: 200, height: 100 });
    return m ?? [1, 0, 0, 1, 0, 0];
  }
  // A shadow's colour first, wherever it was written.
  if (/shadow/.test(property)) value = value.split(/,(?![^(]*\))/).map((item) => {
    const color = /(?:rgba?|oklab)\([^)]*\)/.exec(item)?.[0] ?? '';
    return `${color} ${item.replace(color, '')}`;
  }).join(',');
  const resolved = value
    .replace(/calc\(([^()]*)\)/g, (_, body: string) => {
      let px = 0;
      for (const m of body.matchAll(/([+-]?\s*[\d.]+)(px|%)/g)) px += m[2] === '%' ? (parseFloat(m[1]!.replace(/\s/g, '')) / 100) * 400 : parseFloat(m[1]!.replace(/\s/g, ''));
      return `${px}px`;
    })
    .replace(/(?:rgba?|oklab|oklch)\([^)]*\)/g, (c) => {
      const color = parseColor(c)!;
      return ` ${color.rgb.map((v) => v * 255).join(' ')} ${color.alpha} `;
    })
    .replace(/(\d)%/g, (_, d) => `${d}`);
  return [...resolved.matchAll(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/g)].map((m) => Number(m[0]));
}

const here = new URL('./fixtures/', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('waapi-cases.json', here), 'utf8')) as Array<Record<string, any>>;
const chrome = JSON.parse(readFileSync(new URL('waapi-chrome.json', here), 'utf8')) as { results: Array<{ name: string; values: string[] }> };

describe('values, against Chrome', () => {
  for (const c of cases) {
    it(c.name, () => {
      const want = chrome.results.find((r) => r.name === c.name)!.values;
      const got = (c.times as number[]).map((t) => {
        resetAnimations();
        const { host, el } = element(c.style);
        const animations = [el.animate(c.keyframes, c.options)];
        if (c.second) animations.push(el.animate(c.second.keyframes, c.second.options));
        for (const a of animations) {
          a.pause();
          if (c.playbackRate !== undefined) a.playbackRate = c.playbackRate;
          a.currentTime = t;
        }
        const v = valueOf(host, c.property);
        // Chrome's value with nothing animating is the element's own; this shim lays nothing over it then.
        return v === '' ? (c.style?.[c.property] ?? (c.property === 'opacity' ? '1' : '')) : v;
      });
      got.forEach((value, i) => {
        const a = numbers(c.property, value);
        const b = numbers(c.property, want[i]!);
        expect(a.length, `${c.name} at ${c.times[i]}: ${value} vs Chrome ${want[i]}`).toBe(b.length);
        // Colours to within one 8-bit step (Chrome stores legacy colours in 8 bits), the rest to 1e-3.
        a.forEach((x, k) => expect(Math.abs(x - b[k]!), `${c.name} at ${c.times[i]}: ${value} vs Chrome ${want[i]}`).toBeLessThan(/color|shadow/.test(c.property) ? 0.75 : 2e-3));
      });
    });
  }
});

describe('the timing model', () => {
  it('starts a played animation when it was played, ready at the next tick', async () => {
    now = 1000;
    const { host, el } = element();
    const a = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    expect(a.pending).toBe(true);
    expect(a.startTime).toBeNull();
    expect(a.currentTime).toBe(0);
    expect(valueOf(host, 'opacity')).toBe('0');
    now = 1250;
    tickAnimations();
    expect(a.pending).toBe(false);
    expect(a.startTime).toBe(1000);
    expect(a.currentTime).toBe(250);
    expect(Number(valueOf(host, 'opacity'))).toBeCloseTo(0.25, 9);
    await expect(a.ready).resolves.toBe(a);
  });

  it('finishes on the tick that passes its end: finished, onfinish, then nothing is laid over the style', async () => {
    const { host, el } = element();
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 }) as AnimationShim;
    const seen: string[] = [];
    a.onfinish = (e) => seen.push(`onfinish ${e.currentTime}`);
    a.addEventListener('finish', () => seen.push('listener'));
    tickAnimations();
    now = 50;
    tickAnimations();
    expect(a.playState).toBe('running');
    now = 150;
    tickAnimations();
    expect(a.playState).toBe('finished');
    expect(seen).toEqual(['onfinish 100', 'listener']);
    await expect(a.finished).resolves.toBe(a);
    expect(animatedStyleOf(host)).toBeNull();
  });

  it('holds the end with fill forwards, and finish() jumps there', () => {
    const { host, el } = element();
    const a = el.animate({ opacity: [0, 0.5] }, { duration: 1000, fill: 'forwards' }) as AnimationShim;
    tickAnimations();
    a.finish();
    expect(a.currentTime).toBe(1000);
    expect(valueOf(host, 'opacity')).toBe('0.5');
    now = 5000;
    tickAnimations();
    expect(valueOf(host, 'opacity')).toBe('0.5');
    expect(el.getAnimations()).toEqual([a]);
  });

  it('pauses where it was asked to, and plays on from there', () => {
    const { el } = element();
    const a = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    tickAnimations();
    now = 300;
    a.pause();
    now = 400;
    tickAnimations();
    expect(a.playState).toBe('paused');
    expect(a.currentTime).toBe(300);
    now = 900;
    a.play();
    now = 1000;
    tickAnimations();
    expect(a.startTime).toBe(600);
    expect(a.currentTime).toBe(400);
  });

  it('cancels: finished rejects with AbortError, oncancel fires, the style is the element own', async () => {
    const { host, el } = element({ opacity: '0.3' });
    const a = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    const finished = a.finished;
    let cancelled = 0;
    a.oncancel = () => cancelled++;
    tickAnimations();
    a.cancel();
    await expect(finished).rejects.toMatchObject({ name: 'AbortError' });
    tickAnimations();
    expect(cancelled).toBe(1);
    expect(a.playState).toBe('idle');
    expect(animatedStyleOf(host)).toBeNull();
    expect(el.getAnimations()).toEqual([]);
  });

  it('follows a start time set by hand, as Motion sets it', () => {
    now = 2000;
    const { host, el } = element();
    const a = el.animate({ transform: ['translateX(0px)', 'translateX(100px)'] }, { duration: 1000, fill: 'both' }) as AnimationShim;
    a.startTime = 2500;
    expect(a.pending).toBe(false);
    expect(valueOf(host, 'transform')).toBe('translateX(0px)');
    now = 3000;
    expect(valueOf(host, 'transform')).toBe('translateX(50px)');
  });

  it('commits styles to the inline style', () => {
    const { el } = element();
    const a = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    a.currentTime = 250;
    a.commitStyles();
    a.cancel();
    expect(el.style.opacity).toBe('0.25');
  });

  it('builds an animation from a KeyframeEffect, and lists animations in the order they were made', () => {
    const { el } = element();
    const effect = new KeyframeEffectShim(el, { opacity: [1, 0] }, { duration: 500, easing: 'steps(2)' });
    const a = new AnimationShim(effect);
    const b = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    a.play();
    expect(el.getAnimations()).toEqual([a, b]);
    expect(effect.getComputedTiming()).toMatchObject({ duration: 500, activeDuration: 500, endTime: 500, progress: 0 });
    expect(effect.getKeyframes()).toMatchObject([{ offset: null, computedOffset: 0, opacity: '1' }, { offset: null, computedOffset: 1, opacity: '0' }]);
    expect(() => new KeyframeEffectShim(el, { opacity: [0, 1] }, { easing: 'bounce' })).toThrow(TypeError);
  });

  it('shows a sub-frame time without moving anything on', () => {
    const { host, el } = element();
    const a = el.animate({ opacity: [0, 1] }, 1000) as AnimationShim;
    tickAnimations();
    now = 100;
    tickAnimations();
    // A motion-blur sample: the clock is read, no tick.
    now = 116;
    expect(Number(valueOf(host, 'opacity'))).toBeCloseTo(0.116, 9);
    now = 100;
    expect(Number(valueOf(host, 'opacity'))).toBeCloseTo(0.1, 9);
    expect(a.playState).toBe('running');
  });
});
