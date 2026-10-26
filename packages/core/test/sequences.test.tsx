// The timeline data (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4): every <Sequence> in the tree is recorded whether or not it is showing,
// and recording changes none of the automatic ids.

import { Fragment, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Layer, Rect } from '@kinetographdev/react';
import type { SequenceJson } from '@kinetographdev/scene';
import { Freeze, Loop, Sequence, Series, useCurrentFrame, useVideoConfig } from '../src/timeline.js';
import { TransitionSeries, linearTiming } from '../src/transitions/index.js';
import { fade } from '../src/transitions/fade.js';
import { ids, renderAt } from './scene-harness.js';

const R = ({ id }: { id?: string }) => <Rect id={id} width={1} height={1} fill="#fff" />;

function sequencesAt(node: ReactNode, frame: number): SequenceJson[] {
  return renderAt(node, frame).sequences;
}

function shown(node: ReactNode, frame: number): string[] {
  return ids(renderAt(node, frame).layers);
}

describe('Sequence records itself', () => {
  const make = () => (
    <Sequence from={10} durationInFrames={20}>
      <R id="a" />
    </Sequence>
  );

  it('with its key, absolute from, duration and the group its children are in', () => {
    expect(sequencesAt(make(), 15)).toEqual([
      { key: '/Sequence@10+20', name: null, from: 10, durationInFrames: 20, parent: null, layer: '$0' },
    ]);
  });

  it('while it is not showing, with no layer', () => {
    for (const frame of [0, 9, 30, 89]) {
      expect(sequencesAt(make(), frame), `frame ${frame}`).toEqual([
        { key: '/Sequence@10+20', name: null, from: 10, durationInFrames: 20, parent: null, layer: null },
      ]);
      expect(shown(make(), frame)).toEqual([]);
    }
  });

  it('under the same key on every frame', () => {
    const keys = new Set<string>();
    for (let frame = 0; frame < 90; frame += 7) for (const s of sequencesAt(make(), frame)) keys.add(s.key);
    expect([...keys]).toEqual(['/Sequence@10+20']);
  });

  it('with its name, which is also in the key', () => {
    const [s] = sequencesAt(<Sequence name="intro" from={3} durationInFrames={4} />, 4);
    expect(s).toMatchObject({ key: '/intro@3+4', name: 'intro' });
  });

  it('with a finite duration when the Sequence has none or outlasts its parent', () => {
    expect(sequencesAt(<Sequence from={30} />, 40)[0]).toMatchObject({ from: 30, durationInFrames: 60 });
    expect(sequencesAt(<Sequence from={30} durationInFrames={500} />, 0)[0]).toMatchObject({ durationInFrames: 60 });
    // Past the end of the composition there is nothing left, but never a negative duration.
    expect(sequencesAt(<Sequence from={200} />, 0)[0]).toMatchObject({ from: 200, durationInFrames: 0, layer: null });
  });

  it('keeps a fractional sub-frame from naming a different Sequence', () => {
    const whole = sequencesAt(<Sequence from={5}><Sequence from={2} /></Sequence>, 9);
    const sub = sequencesAt(<Sequence from={5}><Sequence from={2} /></Sequence>, 9.4);
    expect(sub.map((s) => s.key)).toEqual(whole.map((s) => s.key));
  });
});

describe('nested Sequences', () => {
  const make = () => (
    <Sequence name="outer" from={10} durationInFrames={50}>
      <R id="o" />
      <Sequence name="inner" from={5} durationInFrames={10}>
        <R id="i" />
      </Sequence>
      <Sequence from={30}>
        <R id="late" />
      </Sequence>
    </Sequence>
  );

  it('give the absolute from and the parent key, parents first', () => {
    expect(sequencesAt(make(), 16)).toEqual([
      { key: '/outer@10+50', name: 'outer', from: 10, durationInFrames: 50, parent: null, layer: '$0' },
      { key: '/outer@10+50/inner@15+10', name: 'inner', from: 15, durationInFrames: 10, parent: '/outer@10+50', layer: '$0.1' },
      { key: '/outer@10+50/Sequence@40+20', name: null, from: 40, durationInFrames: 20, parent: '/outer@10+50', layer: null },
    ]);
  });

  it('are not rendered, so not recorded, while their parent is not showing', () => {
    expect(sequencesAt(make(), 5).map((s) => s.key)).toEqual(['/outer@10+50']);
    expect(sequencesAt(make(), 65).map((s) => s.key)).toEqual(['/outer@10+50']);
  });

  it('are clamped to what is left of the parent', () => {
    const [outer, inner] = sequencesAt(
      <Sequence from={10} durationInFrames={20}>
        <Sequence from={15} durationInFrames={40} />
      </Sequence>,
      12,
    );
    expect(outer).toMatchObject({ from: 10, durationInFrames: 20 });
    expect(inner).toMatchObject({ from: 25, durationInFrames: 5 });
  });

  it('keep their key through a Freeze, whatever frame it pins', () => {
    const make = () => (
      <Sequence from={20} durationInFrames={40}>
        <Freeze frame={3}>
          <Sequence from={1} durationInFrames={5} />
        </Freeze>
      </Sequence>
    );
    const keys = new Set<string>();
    for (const frame of [22, 30, 45]) for (const s of sequencesAt(make(), frame)) keys.add(s.key);
    expect([...keys].sort()).toEqual(['/Sequence@20+40', '/Sequence@20+40/Sequence@21+5']);
  });
});

describe('Series', () => {
  const make = () => (
    <Series>
      <Series.Sequence name="one" durationInFrames={10}>
        <R id="a" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={20} offset={5}>
        <R id="b" />
      </Series.Sequence>
      <Series.Sequence name="three" durationInFrames={10} offset={-5}>
        <R id="c" />
      </Series.Sequence>
    </Series>
  );

  it('records each item with its start and name, showing or not', () => {
    expect(sequencesAt(make(), 3)).toEqual([
      { key: '/one@0+10', name: 'one', from: 0, durationInFrames: 10, parent: null, layer: '$0' },
      { key: '/Sequence@15+20', name: null, from: 15, durationInFrames: 20, parent: null, layer: null },
      { key: '/three@30+10', name: 'three', from: 30, durationInFrames: 10, parent: null, layer: null },
    ]);
    expect(sequencesAt(make(), 20).map((s) => s.layer)).toEqual([null, '$0', null]);
    expect(sequencesAt(make(), 32).map((s) => s.layer)).toEqual([null, '$0', '$1']);
  });

  it('does not record an item of no length, which is not rendered', () => {
    const [only] = sequencesAt(
      <Series>
        <Series.Sequence durationInFrames={0} />
        <Series.Sequence name="x" durationInFrames={5} />
      </Series>,
      0,
    );
    expect(only).toMatchObject({ key: '/x@0+5', from: 0 });
  });
});

describe('Series with fragments', () => {
  it('flattens fragments, nested ones too, and still rejects other children', () => {
    const node = (
      <Series>
        <Series.Sequence name="one" durationInFrames={10} />
        {['a', 'b'].map((n) => (
          <Fragment key={n}>
            <Fragment>
              <Series.Sequence name={n} durationInFrames={5} />
            </Fragment>
          </Fragment>
        ))}
      </Series>
    );
    expect(sequencesAt(node, 0).map((s) => [s.name, s.from])).toEqual([
      ['one', 0],
      ['a', 10],
      ['b', 15],
    ]);
    expect(() =>
      renderAt(
        <Series>
          <Fragment>
            <div />
          </Fragment>
        </Series>,
      ),
    ).toThrow(/only accepts a list of <Series.Sequence/);
  });
});

describe('Loop', () => {
  const make = () => (
    <Loop durationInFrames={30}>
      <R id="a" />
      <Sequence name="blink" from={10} durationInFrames={5} />
    </Loop>
  );

  it('records itself over the length it plays', () => {
    const [loop] = sequencesAt(make(), 40);
    expect(loop).toEqual({ key: '/Loop@0+90', name: 'Loop', from: 0, durationInFrames: 90, parent: null, layer: '$0' });
    expect(sequencesAt(<Loop durationInFrames={10} times={3} name="beat" />, 70)[0]).toMatchObject({
      key: '/beat@0+30',
      durationInFrames: 30,
      layer: null,
    });
  });

  it('puts a Sequence inside it at its place in the iteration that is playing', () => {
    expect(sequencesAt(make(), 12)[1]).toMatchObject({ key: '/Loop@0+90/blink@10+5', from: 10, parent: '/Loop@0+90', layer: '$0.1' });
    expect(sequencesAt(make(), 42)[1]).toMatchObject({ key: '/Loop@0+90/blink@40+5', from: 40, layer: '$0.1' });
  });
});

describe('TransitionSeries', () => {
  const make = () => (
    <TransitionSeries>
      <TransitionSeries.Sequence name="first" durationInFrames={40}>
        <R id="a" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 10 })} />
      <TransitionSeries.Sequence durationInFrames={40}>
        <R id="b" />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );

  it('records each scene where the transition places it', () => {
    const during = sequencesAt(make(), 35);
    expect(during.map(({ key, name, from, durationInFrames }) => ({ key, name, from, durationInFrames }))).toEqual([
      { key: '/first@0+40', name: 'first', from: 0, durationInFrames: 40 },
      { key: '/Sequence@30+40', name: null, from: 30, durationInFrames: 40 },
    ]);
    // Both scenes show while they overlap.
    expect(during.every((s) => s.layer !== null)).toBe(true);
    expect(sequencesAt(make(), 5).map((s) => s.layer !== null)).toEqual([true, false]);
    expect(sequencesAt(make(), 60).map((s) => s.layer !== null)).toEqual([false, true]);
  });

  const T = () => <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 10 })} />;
  const S = ({ id }: { id: string }) => (
    <TransitionSeries.Sequence name={id} durationInFrames={30}>
      <R id={id} />
    </TransitionSeries.Sequence>
  );
  const spans = (node: ReactNode) => sequencesAt(node, 0).map((s) => [s.name, s.from]);

  it('flattens fragments from .map() as if the pairs were written out', () => {
    const flat = (
      <TransitionSeries>
        {S({ id: "A" })}
        {T()}
        {S({ id: "B" })}
        {T()}
        {S({ id: "C" })}
      </TransitionSeries>
    );
    const fragments = (
      <TransitionSeries>
        {S({ id: "A" })}
        {['B', 'C'].map((l) => (
          <Fragment key={l}>
            {T()}
            {S({ id: l })}
          </Fragment>
        ))}
      </TransitionSeries>
    );
    expect(spans(fragments)).toEqual([['A', 0], ['B', 20], ['C', 40]]);
    expect(spans(fragments)).toEqual(spans(flat));
    expect(sequencesAt(fragments, 55).map((s) => s.layer !== null)).toEqual([false, false, true]);
  });

  it('flattens nested fragments', () => {
    const node = (
      <TransitionSeries>
        <>
          {S({ id: "A" })}
          <>
            {T()}
            {S({ id: "B" })}
          </>
        </>
      </TransitionSeries>
    );
    expect(spans(node)).toEqual([['A', 0], ['B', 20]]);
  });

  it('still rejects another child, inside a fragment too', () => {
    expect(() =>
      renderAt(
        <TransitionSeries>
          <>
            {S({ id: "A" })}
            <div />
          </>
        </TransitionSeries>,
      ),
    ).toThrow(/only accepts a list of <TransitionSeries.Sequence \/>/);
  });
});

describe('automatic ids do not move', () => {
  it('for a Sequence that is not showing: it takes no place', () => {
    const tree = (
      <>
        <R />
        <Sequence from={50} durationInFrames={10}>
          <R />
        </Sequence>
        <R />
      </>
    );
    expect(shown(tree, 0)).toEqual(['$0', '$1']);
  });

  it('for a Sequence that is showing: it takes the place its Layer took', () => {
    const tree = (
      <>
        <R />
        <Sequence from={0}>
          <R />
          <R />
        </Sequence>
        <R />
      </>
    );
    expect(shown(tree, 5)).toEqual(['$0', '$1', '$1.0', '$1.1', '$2']);
  });

  it('for layout="none": the children take the places in the parent, as a fragment gives them', () => {
    const plain = (
      <>
        <R />
        <Sequence from={0} layout="none">
          <R />
          <Layer>
            <R />
          </Layer>
        </Sequence>
        <R />
      </>
    );
    const fragment = (
      <>
        <R />
        <Fragment>
          <R />
          <Layer>
            <R />
          </Layer>
        </Fragment>
        <R />
      </>
    );
    expect(shown(plain, 5)).toEqual(['$0', '$1', '$2', '$2.0', '$3']);
    expect(shown(plain, 5)).toEqual(shown(fragment, 5));
    const [s] = sequencesAt(plain, 5);
    expect(s).toMatchObject({ layer: null });
  });

  it('for a Sequence in a Layer or another Sequence', () => {
    const tree = (
      <Layer>
        <R />
        <Sequence from={0}>
          <Sequence from={0} layout="none">
            <R />
          </Sequence>
          <Sequence from={80}>
            <R />
          </Sequence>
          <R />
        </Sequence>
      </Layer>
    );
    expect(shown(tree, 1)).toEqual(['$0', '$0.0', '$0.1', '$0.1.0', '$0.1.1']);
    expect(sequencesAt(tree, 1).map((s) => s.layer)).toEqual(['$0.1', null, null]);
  });

  it('for an explicit id on the Sequence’s content: the Sequence group still has an automatic one', () => {
    const [s] = sequencesAt(
      <Sequence from={0}>
        <R id="x" />
      </Sequence>,
      0,
    );
    expect(s!.layer).toBe('$0');
  });
});

describe('Sequence and blending', () => {
  it('is not a stacking context: its group lets a child blend with what is behind it', () => {
    const [layer] = renderAt(
      <Sequence from={0}>
        <R id="a" />
      </Sequence>,
      1,
    ).layers;
    expect(layer).toMatchObject({ type: 'group', passThrough: true });
    // Without a wrapper there is no group to isolate anything.
    const [bare] = renderAt(
      <Sequence layout="none">
        <R id="a" />
      </Sequence>,
      1,
    ).layers;
    expect(bare).toMatchObject({ id: 'a', type: 'shape' });
  });

  it('is the same for a Loop', () => {
    const [layer] = renderAt(
      <Loop durationInFrames={10}>
        <R id="a" />
      </Loop>,
      1,
    ).layers;
    expect(layer).toMatchObject({ type: 'group', passThrough: true });
  });
});

describe('Sequence trimBefore, playbackRate and loop', () => {
  function clock(props: Record<string, unknown>, frame: number): { frame: number; duration: number } | null {
    const seen: { frame: number; duration: number }[] = [];
    const Probe = () => {
      seen.push({ frame: useCurrentFrame(), duration: useVideoConfig().durationInFrames });
      return null;
    };
    renderAt(
      <Sequence layout="none" {...props}>
        <Probe />
      </Sequence>,
      frame,
    );
    return seen.at(-1) ?? null;
  }

  it('starts the children at trimBefore', () => {
    expect(clock({ from: 10, durationInFrames: 20, trimBefore: 5 }, 10)).toEqual({ frame: 5, duration: 25 });
    expect(clock({ from: 10, durationInFrames: 20, trimBefore: 5 }, 14)).toEqual({ frame: 9, duration: 25 });
    expect(clock({ from: 10, durationInFrames: 20, trimBefore: 5 }, 30)).toBeNull();
  });

  it('runs the children faster or slower, and is on screen for the duration over the rate', () => {
    expect(clock({ from: 10, durationInFrames: 20, playbackRate: 2 }, 14)).toEqual({ frame: 8, duration: 20 });
    // 20 child frames at double speed take 10 frames of the parent.
    expect(clock({ from: 10, durationInFrames: 20, playbackRate: 2 }, 19)).toEqual({ frame: 18, duration: 20 });
    expect(clock({ from: 10, durationInFrames: 20, playbackRate: 2 }, 20)).toBeNull();
    expect(clock({ from: 0, durationInFrames: 10, playbackRate: 0.5, trimBefore: 3 }, 6)).toEqual({ frame: 6, duration: 13 });
    expect(clock({ from: 0, durationInFrames: 10, playbackRate: 0.5 }, 19)).toEqual({ frame: 9.5, duration: 10 });
    expect(clock({ from: 0, durationInFrames: 10, playbackRate: 0.5 }, 20)).toBeNull();
  });

  it('records the window in the parent’s frames', () => {
    const [sequence] = renderAt(
      <Sequence from={10} durationInFrames={20} playbackRate={2} layout="none">
        <R />
      </Sequence>,
      12,
    ).sequences;
    expect(sequence).toMatchObject({ from: 10, durationInFrames: 10 });
  });

  it('repeats the children for as long as the parent lasts', () => {
    // Four frame loops from frame 10; each iteration starts again at trimBefore.
    expect(clock({ from: 10, durationInFrames: 4, loop: true }, 10)).toEqual({ frame: 0, duration: 4 });
    expect(clock({ from: 10, durationInFrames: 4, loop: true }, 13)).toEqual({ frame: 3, duration: 4 });
    expect(clock({ from: 10, durationInFrames: 4, loop: true }, 14)).toEqual({ frame: 0, duration: 4 });
    expect(clock({ from: 10, durationInFrames: 4, loop: true, trimBefore: 2 }, 15)).toEqual({ frame: 3, duration: 6 });
    // The last iteration is cut short by the parent (90 frames).
    expect(clock({ from: 86, durationInFrames: 3, loop: true }, 89)).toEqual({ frame: 0, duration: 1 });
    expect(clock({ from: 5, durationInFrames: 4, loop: true }, 4)).toBeNull();
  });

  it('loops with a fractional period and a rate', () => {
    expect(clock({ from: 0, durationInFrames: 5, loop: true, playbackRate: 2 }, 2)).toEqual({ frame: 4, duration: 5 });
    expect(clock({ from: 0, durationInFrames: 5, loop: true, playbackRate: 2 }, 3)).toEqual({ frame: 1, duration: 5 });
    expect(clock({ from: 0, durationInFrames: 7, loop: true, playbackRate: 3 }, 7)).toEqual({ frame: expect.closeTo(0, 9), duration: 7 });
  });

  it('refuses values it cannot honour', () => {
    expect(() => clock({ playbackRate: 0 }, 0)).toThrow('The "playbackRate" prop of <Sequence /> must be a positive finite number, but got 0.');
    expect(() => clock({ playbackRate: Infinity }, 0)).toThrow(/positive finite/);
    expect(() => clock({ trimBefore: -1 }, 0)).toThrow('The "trimBefore" prop of <Sequence /> must be greater than or equal to 0, but got -1.');
    expect(() => clock({ trimBefore: NaN }, 0)).toThrow(/must be a number/);
    expect(() => clock({ loop: 1 }, 0)).toThrow('The "loop" prop of <Sequence /> must be a boolean, but is of type number.');
    expect(() => clock({ loop: true }, 0)).toThrow('requires a finite "durationInFrames" prop');
  });
});
