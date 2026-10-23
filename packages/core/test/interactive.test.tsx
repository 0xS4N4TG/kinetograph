// <Track>, Interactive, and the crop and timing props they share (packages/cli/skills/kinetograph/references/AUTHORING.md §7.1). The schemas and the crop
// clip-path are recorded from the published package (fixtures/interactivity-schema.json, fixtures/crop-style.json).

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteFillSchema, Freeze, Interactive, Rect, Track, useCurrentFrame } from '../src/index.js';
import * as schemaModule from '../src/interactivity-schema.js';
import { croppedStyle } from '../src/sequenced.js';
import { resetWarnings } from '../src/warn.js';
import { renderDom, sent, summary, useFakeDom } from './dom-harness.js';
import { fixture } from './helpers.js';
import { renderAt } from './scene-harness.js';

useFakeDom();

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

/** What the field tables look like in the recorded JSON, where undefined values are gone. */
const asRecorded = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('the Studio field tables', () => {
  const { schemas } = fixture('interactivity-schema.json');

  it('are the published package\'s, field for field', () => {
    for (const [name, recorded] of Object.entries<unknown>(schemas)) {
      const mine = name === 'absoluteFillSchema' ? absoluteFillSchema : (Interactive as Record<string, unknown>)[name];
      expect(asRecorded(mine), name).toEqual(recorded);
    }
  });

  it('are the same objects as the module exports', () => {
    expect(Interactive.baseSchema).toBe(schemaModule.baseSchema);
    expect(Interactive.cropSchema).toBe(schemaModule.cropSchema);
  });
});

describe('the crop clip-path', () => {
  const { cases } = fixture('crop-style.json');

  it('matches the published package for every recorded crop and style', () => {
    for (const c of cases) {
      const label = JSON.stringify(c);
      const revive = (v: unknown) => (v === 'NaN' ? NaN : v);
      const crop = Object.fromEntries(Object.entries(c.crop).map(([k, v]) => [k, revive(v)]));
      if (c.output.error) {
        expect(() => croppedStyle('<Test />', crop, c.style ?? undefined), label).toThrow(c.output.error);
      } else {
        expect(croppedStyle('<Test />', crop, c.style ?? undefined) ?? null, label).toEqual(c.output.style);
      }
    }
  });
});

describe('Interactive elements', () => {
  it('draw the element they wrap, with its props and the cropped style', () => {
    renderDom(
      <Interactive.Div id="box" className="card" cropLeft={0.1} style={{ opacity: 0.5, borderRadius: 4 }}>
        hi
      </Interactive.Div>,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].root.tag).toBe('div');
    expect(sent[0].root.attrs).toEqual({ id: 'box', class: 'card' });
    expect(sent[0].root.style).toBe('opacity: 0.5; border-radius: 4px; clip-path: inset(0% 0% 0% 10% round 4px)');
    expect(summary(sent[0].root)).toMatchObject({ children: ['hi'] });
  });

  it('are in the timeline under their Studio name, and show only from `from` for `durationInFrames`', () => {
    const el = (
      <Interactive.Span from={10} durationInFrames={20}>
        x
      </Interactive.Span>
    );
    expect(renderDom(el, 9).sequences[0]).toMatchObject({ name: '<Interactive.Span>', from: 10, durationInFrames: 20 });
    expect(sent).toHaveLength(0);
    renderDom(el, 10);
    expect(sent).toHaveLength(1);
    sent.length = 0;
    renderDom(el, 30);
    expect(sent).toHaveLength(0);
  });

  it('take `name`, and draw nothing when `hidden`', () => {
    const tree = renderDom(
      <Interactive.P name="Caption" hidden>
        gone
      </Interactive.P>,
    );
    expect(sent).toHaveLength(0);
    expect(tree.sequences).toEqual([]);
    expect(renderDom(<Interactive.P name="Caption">there</Interactive.P>).sequences[0]).toMatchObject({ name: 'Caption' });
  });

  it('show their content frozen at `freeze`', () => {
    function Frame() {
      return <p>{useCurrentFrame()}</p>;
    }
    renderDom(
      <Interactive.Div freeze={4}>
        <Frame />
      </Interactive.Div>,
      20,
    );
    expect(summary(sent[0].root)).toMatchObject({ children: [{ tag: 'p', children: ['4'] }] });
  });

  it('apply trimBefore, playbackRate and loop through their Sequence, and say nothing for the premount and timeline props', () => {
    renderDom(
      <Interactive.Div trimBefore={5} playbackRate={2} loop durationInFrames={10} premountFor={30} showInTimeline={false}>
        x
      </Interactive.Div>,
    );
    expect(warn.mock.calls).toEqual([]);
  });

  it('refuse a crop that is not a finite fraction', () => {
    expect(() => renderDom(<Interactive.Div cropLeft={150}>x</Interactive.Div>)).toThrow(/between 0 and 1.*not 0 to 100/);
    expect(() => renderDom(<Interactive.Div cropTop={NaN}>x</Interactive.Div>)).toThrow(/finite number/);
  });

  it('cover the SVG elements too', () => {
    renderDom(
      <Interactive.Svg width={10} height={10}>
        <Interactive.Circle cx={5} cy={5} r={4} fill="red" />
      </Interactive.Svg>,
    );
    expect(summary(sent[0].root)).toMatchObject({ tag: 'svg', children: [{ tag: 'circle' }] });
  });
});

describe('Interactive.create', () => {
  function Badge({ label, style }: { label: string; style?: Record<string, unknown> }) {
    return <b style={style}>{label}</b>;
  }

  it('wraps the component in a Sequence and hands it the cropped style', () => {
    const Created = Interactive.create({ Component: Badge, componentName: 'Badge' });
    const tree = renderDom(<Created label="new" from={5} cropRight={0.5} style={{ color: 'red' }} />, 6);
    expect(tree.sequences[0]).toMatchObject({ name: 'Badge', from: 5 });
    expect(sent[0].root.tag).toBe('b');
    expect(sent[0].root.style).toBe('color: red; clip-path: inset(0% 50% 0% 0%)');
    expect(summary(sent[0].root)).toMatchObject({ children: ['new'] });
  });

  it('with absolute-fill, puts the component in a clipped, sized div that takes the style', () => {
    const Created = Interactive.create({ Component: Badge, componentName: 'Badge', layout: 'absolute-fill' });
    renderDom(<Created label="x" width={200} height={100} style={{ opacity: 0.5 }} />);
    const fill = sent[0].root;
    expect(fill.tag).toBe('div');
    expect(fill.style).toContain('width: 200px');
    expect(fill.style).toContain('height: 100px');
    expect(fill.style).toContain('overflow: hidden');
    expect(fill.style).toContain('opacity: 0.5');
    expect(fill.children[0]).toMatchObject({ tag: 'b' });
    expect(fill.children[0].style).toBe('');
  });

  it('is withSchema with wrapInSequence, and the component itself without it', () => {
    const wrapped = Interactive.withSchema({ Component: Badge, wrapInSequence: true });
    const tree = renderDom(createElement(wrapped, { label: 'x' }));
    expect(tree.sequences[0]).toMatchObject({ name: 'Badge' });
    expect(Interactive.withSchema({ Component: Badge })).toBe(Badge);
  });
});

describe('Track', () => {
  it('shows its children for `from` and `durationInFrames`, as a layout-less Sequence named Track', () => {
    const track = (
      <Track from={10} durationInFrames={20}>
        <Rect id="clip" width={4} height={4} />
      </Track>
    );
    const before = renderAt(track, 9);
    expect(before.layers).toEqual([]);
    expect(before.sequences[0]).toMatchObject({ name: 'Track', from: 10, durationInFrames: 20 });
    expect(renderAt(track, 10).layers[0]).toMatchObject({ id: 'clip' });
    expect(renderAt(track, 30).layers).toEqual([]);
  });

  it('shows through `freeze` and not at all when `hidden`', () => {
    function Frame() {
      const frame = useCurrentFrame();
      return <Rect id={`f${frame}`} width={1} height={1} />;
    }
    expect(renderAt(<Track freeze={3}><Frame /></Track>, 20).layers[0]).toMatchObject({ id: 'f3' });
    expect(renderAt(<Track hidden><Frame /></Track>, 20).layers).toEqual([]);
  });

  it('keeps a Freeze around it in force', () => {
    function Frame() {
      return <Rect id={`f${useCurrentFrame()}`} width={1} height={1} />;
    }
    expect(renderAt(<Freeze frame={7}><Track><Frame /></Track></Freeze>, 20).layers[0]).toMatchObject({ id: 'f7' });
  });
});
