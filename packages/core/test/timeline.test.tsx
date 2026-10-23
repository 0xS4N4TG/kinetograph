import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createSceneRoot } from '@kinetographdev/react';
import { Freeze, Loop, Sequence, Series, useCurrentFrame, useVideoConfig } from '../src/timeline.js';
import { ids, probe, renderAt, type Seen } from './scene-harness.js';

function run(make: (seen: Seen[]) => ReactElement, frame: number) {
  const seen: Seen[] = [];
  const tree = renderAt(make(seen), frame);
  return { seen, ids: ids(tree.layers).filter((id) => !id.startsWith('$')), layers: tree.layers };
}

describe('hooks', () => {
  it('read the frame and the config of the composition', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return <A />;
    }, 42);
    expect(seen).toEqual([{ name: 'a', frame: 42, duration: 90 }]);
  });

  it('throw outside a composition', () => {
    function Bare() {
      useCurrentFrame();
      return null;
    }
    const root = createSceneRoot();
    try {
      expect(() => root.render(<Bare />)).toThrow(/No timeline/);
    } finally {
      root.unmount();
    }
  });
});

describe('Sequence', () => {
  it('shows its children only inside [from, from + duration) and shifts their frame', () => {
    const make = (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Sequence from={10} durationInFrames={20}>
          <A />
        </Sequence>
      );
    };
    expect(run(make, 9).ids).toEqual([]);
    expect(run(make, 10).seen).toEqual([{ name: 'a', frame: 0, duration: 20 }]);
    expect(run(make, 29).seen).toEqual([{ name: 'a', frame: 19, duration: 20 }]);
    expect(run(make, 30).ids).toEqual([]);
    expect(run(make, 15).ids).toEqual(['a']);
  });

  it('wraps its children in a plain group, or in nothing for layout="none"', () => {
    const make = (layout?: 'none') => (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Sequence from={0} layout={layout}>
          <A />
        </Sequence>
      );
    };
    const grouped = run(make(), 3).layers;
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.type).toBe('group');
    expect((grouped[0] as any).layout).toBeUndefined();
    const bare = run(make('none'), 3).layers;
    expect(bare.map((l) => l.id)).toEqual(['a']);
  });

  it('nests: frames are relative to each enclosing sequence', () => {
    const make = (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Sequence from={10}>
          <Sequence from={5} durationInFrames={10}>
            <A />
          </Sequence>
        </Sequence>
      );
    };
    expect(run(make, 14).ids).toEqual([]);
    expect(run(make, 15).seen).toEqual([{ name: 'a', frame: 0, duration: 10 }]);
    expect(run(make, 24).seen).toEqual([{ name: 'a', frame: 9, duration: 10 }]);
    expect(run(make, 25).ids).toEqual([]);
  });

  it('reports a duration clamped to what is left of the parent', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return (
        <Sequence from={30}>
          <A />
        </Sequence>
      );
    }, 40);
    expect(seen).toEqual([{ name: 'a', frame: 10, duration: 60 }]);
  });

  it('supports a negative from (it started before frame 0)', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return (
        <Sequence from={-20} durationInFrames={30}>
          <A />
        </Sequence>
      );
    }, 0);
    expect(seen).toEqual([{ name: 'a', frame: 20, duration: 30 }]);
  });

  it('follows fractional frames of a motion-blur sub-frame', () => {
    const { seen, ids: shown } = run((s) => {
      const A = probe('a', s);
      return (
        <Sequence from={10} durationInFrames={5}>
          <A />
        </Sequence>
      );
    }, 10.25);
    expect(shown).toEqual(['a']);
    expect(seen[0]!.frame).toBeCloseTo(0.25, 12);
  });

  it('rejects a bad prop', () => {
    expect(() => renderAt(<Sequence from={NaN} />)).toThrow(/from/);
    expect(() => renderAt(<Sequence durationInFrames={-1} />)).toThrow(/negative/);
  });
});

describe('Series', () => {
  const make = (s: Seen[]) => {
    const A = probe('a', s);
    const B = probe('b', s);
    const C = probe('c', s);
    return (
      <Series>
        <Series.Sequence durationInFrames={10}>
          <A />
        </Series.Sequence>
        <Series.Sequence durationInFrames={20} offset={5}>
          <B />
        </Series.Sequence>
        <Series.Sequence durationInFrames={10} offset={-5}>
          <C />
        </Series.Sequence>
      </Series>
    );
  };

  it('plays sequences back to back, with offsets', () => {
    // a: 0..10, b: 15..35, c: 30..40
    expect(run(make, 0).ids).toEqual(['a']);
    expect(run(make, 9).ids).toEqual(['a']);
    expect(run(make, 12).ids).toEqual([]);
    expect(run(make, 15).seen).toEqual([{ name: 'b', frame: 0, duration: 20 }]);
    expect(run(make, 34).ids).toEqual(['b', 'c']);
    expect(run(make, 34).seen).toContainEqual({ name: 'c', frame: 4, duration: 10 });
    expect(run(make, 35).ids).toEqual(['c']);
    expect(run(make, 40).ids).toEqual([]);
  });

  it('allows an open-ended last sequence', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return (
        <Series>
          <Series.Sequence durationInFrames={Infinity}>
            <A />
          </Series.Sequence>
        </Series>
      );
    }, 50);
    expect(seen).toEqual([{ name: 'a', frame: 50, duration: 90 }]);
  });

  it('skips a zero-length sequence but still lays out the ones after it', () => {
    const { ids: shown } = run((s) => {
      const A = probe('a', s);
      const B = probe('b', s);
      return (
        <Series>
          <Series.Sequence durationInFrames={0}>
            <A />
          </Series.Sequence>
          <Series.Sequence durationInFrames={5}>
            <B />
          </Series.Sequence>
        </Series>
      );
    }, 2);
    expect(shown).toEqual(['b']);
  });

  it('only accepts Series.Sequence children', () => {
    expect(() =>
      renderAt(
        <Series>
          <div />
        </Series>,
      ),
    ).toThrow(/only accepts a list of <Series.Sequence/);
  });
});

describe('Loop', () => {
  it('repeats the frame of its children', () => {
    const make = (times?: number) => (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Loop durationInFrames={10} times={times}>
          <A />
        </Loop>
      );
    };
    expect(run(make(), 0).seen[0]).toEqual({ name: 'a', frame: 0, duration: 10 });
    expect(run(make(), 9).seen[0]!.frame).toBe(9);
    expect(run(make(), 10).seen[0]!.frame).toBe(0);
    expect(run(make(), 47).seen[0]!.frame).toBe(7);
    // three times = 30 frames, then nothing
    expect(run(make(3), 29).seen[0]!.frame).toBe(9);
    expect(run(make(3), 30).ids).toEqual([]);
  });

  it('works inside a sequence', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return (
        <Sequence from={5}>
          <Loop durationInFrames={4}>
            <A />
          </Loop>
        </Sequence>
      );
    }, 14);
    expect(seen[0]).toEqual({ name: 'a', frame: 1, duration: 4 });
  });

  it('rejects a non-positive duration', () => {
    expect(() => renderAt(<Loop durationInFrames={0} />)).toThrow(/greater than 0/);
  });
});

describe('Freeze', () => {
  it('shows its children as of a fixed frame', () => {
    const seen: Seen[] = [];
    const A = probe('a', seen);
    renderAt(
      <Freeze frame={12}>
        <A />
      </Freeze>,
      50,
    );
    expect(seen).toEqual([{ name: 'a', frame: 12, duration: 90 }]);
  });

  it('can be switched on by a function of the frame', () => {
    const make = (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Freeze frame={3} active={(frame) => frame >= 20}>
          <A />
        </Freeze>
      );
    };
    expect(run(make, 19).seen[0]!.frame).toBe(19);
    expect(run(make, 20).seen[0]!.frame).toBe(3);
    expect(run(make, 80).seen[0]!.frame).toBe(3);
  });

  it('does not freeze when inactive', () => {
    const { seen } = run((s) => {
      const A = probe('a', s);
      return (
        <Freeze frame={3} active={false}>
          <A />
        </Freeze>
      );
    }, 30);
    expect(seen[0]!.frame).toBe(30);
  });

  it('keeps sequences inside relative to the frozen frame', () => {
    const make = (s: Seen[]) => {
      const A = probe('a', s);
      return (
        <Freeze frame={12}>
          <Sequence from={10} durationInFrames={5}>
            <A />
          </Sequence>
        </Freeze>
      );
    };
    expect(run(make, 0).seen[0]).toEqual({ name: 'a', frame: 2, duration: 5 });
    expect(run(make, 89).seen[0]).toEqual({ name: 'a', frame: 2, duration: 5 });
  });
});
