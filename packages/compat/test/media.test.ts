// `<video>` on the virtual clock (../src/shim/media.ts): currentTime is a function of the clock, never of wall time,
// and the events, `play()`, `loop`, seeks, `<source>` choice and video frame callbacks behave as a browser's do.
import { beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon } from '../src/addon.js';
import { domElementFor } from '../src/shim/element.js';
import { pendingMediaLoads, resetMedia, setMediaClock, takeMediaIssues, tickMedia } from '../src/shim/media.js';
import { createHostElement } from '../src/shim/tree.js';
import { setProjectFileResolver } from '../src/shim/element.js';

let now = 0;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const frame = (n: number) => {
  now = (n / 30) * 1000;
  tickMedia();
};
const make = (attrs: Record<string, string> = {}) => {
  const el = domElementFor(createHostElement('video')) as any;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const events: string[] = [];
  for (const type of ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error'])
    el.addEventListener(type, () => events.push(type));
  return { el, events };
};

beforeEach(() => {
  now = 0;
  resetMedia();
  takeMediaIssues();
  setMediaClock(() => now);
  setProjectFileResolver((src: string) => (src.endsWith('.mp4') || src.endsWith('.webm') ? `/p/${src}` : null));
  setDomAddon({ probeMedia: () => ({ width: 64, height: 36, durationInSeconds: 2 }) });
});

describe('a video element', () => {
  it('loads in order, and the load is counted until canplaythrough', async () => {
    const { el, events } = make();
    el.src = 'a.mp4';
    expect(el.readyState).toBe(0);
    expect(pendingMediaLoads()).toBe(1);
    await flush();
    expect(events).toEqual(['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough']);
    expect(pendingMediaLoads()).toBe(0);
    expect([el.readyState, el.videoWidth, el.videoHeight, el.duration]).toEqual([4, 64, 36, 2]);
  });

  it('plays on the virtual clock, with a rate, and a seek', async () => {
    const { el, events } = make({ src: 'a.mp4' });
    await flush();
    const played = el.play();
    await flush();
    await played;
    expect(events.slice(-2)).toEqual(['play', 'playing']);
    frame(15);
    expect(el.currentTime).toBeCloseTo(0.5, 9);
    el.playbackRate = 2;
    frame(30);
    expect(el.currentTime).toBeCloseTo(0.5 + 1, 9);
    el.currentTime = 0.25;
    frame(45);
    expect(el.currentTime).toBeCloseTo(0.25 + 1, 9);
    el.pause();
    frame(60);
    expect(el.currentTime).toBeCloseTo(1.25, 9);
    expect(el.paused).toBe(true);
  });

  it('wraps with loop and ends without it', async () => {
    const a = make({ src: 'a.mp4', loop: '' });
    const b = make({ src: 'a.mp4' });
    await flush();
    void a.el.play();
    void b.el.play();
    await flush();
    frame(75); // 2.5 s of a 2 s file
    expect(a.el.currentTime).toBeCloseTo(0.5, 9);
    expect(b.el.currentTime).toBe(2);
    expect(b.events.slice(-2)).toEqual(['pause', 'ended']);
    expect(b.el.ended).toBe(true);
    expect(a.events).not.toContain('ended');
  });

  it('a seek before the metadata is where playback starts (a play handler that sets currentTime)', async () => {
    const { el } = make({ src: 'a.mp4' });
    el.addEventListener('play', () => (el.currentTime = 1));
    void el.play();
    await flush();
    frame(15);
    expect(el.currentTime).toBeCloseTo(1.5, 9);
  });

  it('takes the first <source> a browser plays that exists', async () => {
    const el = domElementFor(createHostElement('video')) as any;
    for (const [src, type] of [['x.ogv', 'video/ogg; codecs="theora, vorbis"'], ['missing.mkv', 'video/webm'], ['y.mp4', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"']]) {
      const s = domElementFor(createHostElement('source')) as any;
      s.setAttribute('src', src);
      s.setAttribute('type', type);
      el.appendChild(s);
    }
    await flush();
    expect(el.player.currentSrc).toBe('y.mp4');
    expect(el.readyState).toBe(4);
  });

  it('fires requestVideoFrameCallback when the picture changes, not while it holds still', async () => {
    const { el } = make({ src: 'a.mp4' });
    await flush();
    const seen: number[] = [];
    const again = (_now: number, meta: Record<string, number>) => {
      seen.push(meta.mediaTime!);
      el.requestVideoFrameCallback(again);
    };
    el.requestVideoFrameCallback(again);
    frame(0);
    frame(1);
    expect(seen).toEqual([0]);
    void el.play();
    await flush();
    frame(2);
    frame(3);
    expect(seen.length).toBe(3);
    expect(seen[2]).toBeCloseTo(2 / 30, 9);
  });

  it('refuses a file it cannot find with an error event and a report', async () => {
    const { el, events } = make();
    el.src = 'nope.avi';
    await flush();
    expect(events).toContain('error');
    expect(takeMediaIssues()[0]).toMatch(/no such file/);
    await expect(el.play()).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});
