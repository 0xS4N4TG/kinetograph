import { describe, expect, it } from 'vitest';
import {
  isClipVisibleAt,
  localTimelineTime,
  parseStartExpression,
  seekTimelines,
  TimingResolver,
  type TimedElement,
  type TimelineLike,
} from '../src/hyperframes/index.js';
import { styleDeclarations } from '../src/hyperframes/index.js';

class El implements TimedElement {
  parentElement: El | null = null;
  children: El[] = [];
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
  ) {
    if (attrs.id) this.id = attrs.id;
  }
  id = '';
  add(child: El): El {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(selector: string): El[] {
    const m = /^\[id="(.*)"\]$/.exec(selector);
    return this.all().filter((e) => m !== null && e.id === m[1]);
  }
}

const resolver = (root: El, media: Record<string, number> = {}, timelines: Record<string, number> = {}): TimingResolver =>
  new TimingResolver({
    mediaDuration: (el) => media[el.id] ?? null,
    timelineDuration: (id) => timelines[id] ?? null,
    byId: (id) => root.all().find((e) => e.id === id) ?? null,
    byComposition: (id) => [root, ...root.all()].find((e) => e.attrs['data-composition-id'] === id) ?? null,
  });

describe('start expressions', () => {
  it('parses seconds and references', () => {
    expect(parseStartExpression('12.5')).toEqual({ kind: 'seconds', seconds: 12.5 });
    expect(parseStartExpression('intro')).toEqual({ kind: 'ref', id: 'intro', offset: 0 });
    expect(parseStartExpression('intro + 2')).toEqual({ kind: 'ref', id: 'intro', offset: 2 });
    expect(parseStartExpression('intro - 0.5')).toEqual({ kind: 'ref', id: 'intro', offset: -0.5 });
    expect(parseStartExpression('3s')).toBeNull();
    expect(parseStartExpression(null)).toBeNull();
  });
});

describe('clip windows', () => {
  it('is half-open: back-to-back clips never both show the shared instant', () => {
    expect(isClipVisibleAt(1, 0, 1, 10)).toBe(false);
    expect(isClipVisibleAt(1, 1, 2, 10)).toBe(true);
    expect(isClipVisibleAt(0.9999999999, 1, 2, 10)).toBe(true);
    expect(isClipVisibleAt(0.5, 1, 2, 10)).toBe(false);
  });

  it('a clip that runs to the end keeps the last instant', () => {
    expect(isClipVisibleAt(10, 8, 10, 10)).toBe(true);
    expect(isClipVisibleAt(10, 8, 9, 10)).toBe(false);
  });

  it('resolves start, duration and references inside a composition', () => {
    const root = new El('div', { 'data-composition-id': 'main', 'data-start': '0', 'data-duration': '10' });
    const intro = root.add(new El('video', { id: 'intro', 'data-start': '1', 'data-media-start': '2', 'data-playback-rate': '2' }));
    const after = root.add(new El('section', { id: 'after', 'data-start': 'intro + 0.5', 'data-duration': '3' }));
    const overlap = root.add(new El('section', { id: 'overlap', 'data-start': 'intro - 1', 'data-end': '6' }));
    const r = resolver(root, { intro: 10 });
    // (10 - 2) / 2
    expect(r.duration(intro)).toBe(4);
    expect(r.start(after)).toBe(5.5);
    expect(r.end(after)).toBe(8.5);
    expect(r.start(overlap)).toBe(4);
    expect(r.duration(overlap)).toBe(2);
    expect(r.visibleAt(after, 6, 10, root)).toBe(true);
    expect(r.visibleAt(after, 9, 10, root)).toBe(false);
  });

  it('an image with a start and nothing else lasts 3 s', () => {
    const root = new El('div', { 'data-composition-id': 'main' });
    const img = root.add(new El('img', { id: 'pic', 'data-start': '2' }));
    expect(resolver(root).end(img)).toBe(5);
  });
});

describe('nested compositions', () => {
  const build = (): { root: El; host: El; clip: El; r: TimingResolver } => {
    const root = new El('div', { 'data-composition-id': 'main', 'data-start': '0', 'data-duration': '20' });
    const host = root.add(new El('div', { id: 'h', 'data-composition-id': 'scene', 'data-start': '4', 'data-duration': '6' }));
    const clip = host.add(new El('div', { id: 'c', 'data-start': '2', 'data-duration': '1' }));
    return { root, host, clip, r: resolver(root, {}, { scene: 3 }) };
  };

  it('a child clip starts at its host start plus its own', () => {
    const { host, clip, r } = build();
    expect(r.start(host)).toBe(4);
    expect(r.start(clip)).toBe(6);
  });

  it('a host without data-duration takes its timeline length', () => {
    const root = new El('div', { 'data-composition-id': 'main' });
    const host = root.add(new El('div', { 'data-composition-id': 'scene', 'data-start': '1' }));
    expect(resolver(root, {}, { scene: 3 }).end(host)).toBe(4);
  });

  it('a clip is hidden when its host is', () => {
    const { root, clip, r } = build();
    expect(r.visibleAt(clip, 6.5, 20, root)).toBe(true);
    expect(r.visibleAt(clip, 11, 20, root)).toBe(false);
    expect(r.visibleAt(clip, 3, 20, root)).toBe(false);
  });

  it('seeks the child timeline to its local time, held at both ends', () => {
    const clock = { start: 4, hiddenFrom: 10, playbackStart: 0, rate: 1 };
    expect(localTimelineTime(clock, 3, 5)).toBe(0);
    expect(localTimelineTime(clock, 6.5, 5)).toBe(2.5);
    expect(localTimelineTime(clock, 9.5, 5)).toBe(5);
    expect(localTimelineTime(clock, 15, 8)).toBe(6);
    expect(localTimelineTime({ ...clock, playbackStart: 1, rate: 2 }, 5, null)).toBe(3);
  });
});

describe('timeline seeking', () => {
  const fake = (duration: number): TimelineLike & { calls: [number, boolean | undefined][]; paused: number } => {
    const t = {
      calls: [] as [number, boolean | undefined][],
      paused: 0,
      pause() {
        t.paused++;
      },
      totalTime(time?: number, suppress?: boolean) {
        if (time !== undefined) t.calls.push([time, suppress]);
      },
      totalDuration: () => duration,
    };
    return t;
  };

  it('seeks the root to the time (held at its end) and the others to their local time, paused, every call', () => {
    const root = fake(5);
    const child = fake(3);
    const registry = { main: root, scene: child };
    const clockOf = (id: string) => (id === 'scene' ? { start: 2, hiddenFrom: 4, playbackStart: 0, rate: 1 } : null);
    seekTimelines(registry, 'main', 3, clockOf);
    seekTimelines(registry, 'main', 7, clockOf);
    seekTimelines(registry, 'main', 3, clockOf);
    expect(root.calls).toEqual([[3, false], [5, false], [3, false]]);
    expect(child.calls).toEqual([[1, false], [2, false], [1, false]]);
    expect(root.paused).toBe(3);
  });

  it('is a function of the time alone: the same times in another order give the same seeks', () => {
    const a = fake(5);
    const b = fake(5);
    for (const t of [0, 1, 2, 3]) seekTimelines({ main: a }, 'main', t, () => null);
    for (const t of [3, 0, 2, 1]) seekTimelines({ main: b }, 'main', t, () => null);
    const at = (tl: ReturnType<typeof fake>, time: number) => tl.calls.find(([x]) => x === time);
    for (const t of [0, 1, 2, 3]) expect(at(a, t)).toEqual(at(b, t));
  });

  it('passes suppressEvents on and survives a timeline that throws', () => {
    const bad: TimelineLike = {
      totalTime: () => {
        throw new Error('boom');
      },
    };
    const good = fake(5);
    expect(() => seekTimelines({ bad, main: good }, 'main', 1, () => null, true)).not.toThrow();
    expect(good.calls).toEqual([[1, true]]);
  });
});

describe('style attributes', () => {
  it('splits declarations outside quotes and parentheses', () => {
    expect(styleDeclarations("color: red; background: url('a;b.png'); --x: 1")).toEqual([
      ['color', 'red'],
      ['background', "url('a;b.png')"],
      ['--x', '1'],
    ]);
  });
});
