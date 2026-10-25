import { describe, expect, it } from 'vitest';

import type { SequenceJson, TimelineLayer } from '../src/api';
import { buildTimeline, isGeneric, mergeRanges, seekTarget, visibleRows, type TimelineNode } from '../src/lib/timeline-model';
import { foldSiblings } from '../src/lib/tree';

const FPS = 30;
const seq = (key: string, from: number, durationInFrames: number, extra: Partial<SequenceJson> = {}): SequenceJson => ({
  key,
  name: null,
  from,
  durationInFrames,
  parent: null,
  layer: null,
  ...extra,
});
const src = (line: number) => ({ file: 'shots.tsx', line, column: 3 });
let n = 0;
const layer = (extra: Partial<TimelineLayer> & { ranges: [number, number][] }): TimelineLayer => ({
  id: `$${n++}`,
  type: 'shape',
  parent: null,
  ...extra,
});
const labels = (nodes: TimelineNode[]) => nodes.map((x) => (x.count > 1 ? `${x.label} x${x.count}` : x.label));

describe('mergeRanges', () => {
  it('joins ranges absent for at most the gap and splits on a longer absence', () => {
    expect(mergeRanges([[0, 10], [20, 30]], 30)).toEqual([[0, 30]]);
    // 30 frames absent (11..40) is one second at 30 fps: still one bar. 31 frames splits it.
    expect(mergeRanges([[0, 10], [41, 50]], 30)).toEqual([[0, 50]]);
    expect(mergeRanges([[0, 10], [42, 50]], 30)).toEqual([[0, 10], [42, 50]]);
  });
  it('bridges slivers, sorts and absorbs contained ranges', () => {
    expect(mergeRanges([[50, 60], [0, 5], [2, 3], [7, 8], [10, 12]], 3)).toEqual([[0, 12], [50, 60]]);
    expect(mergeRanges([], 30)).toEqual([]);
  });
});

describe('isGeneric', () => {
  it('knows kinds and the sub-layers the engine adds', () => {
    const base = { id: 'x', type: 'shape', parent: null, ranges: [] as [number, number][] };
    expect(isGeneric({ ...base, label: 'Shape' })).toBe(true);
    expect(isGeneric({ ...base, label: 'Group' })).toBe(true);
    expect(isGeneric({ ...base, label: 'Word · “r” · shadow2' })).toBe(true);
    expect(isGeneric({ ...base, label: 'Word · border.top' })).toBe(true);
    expect(isGeneric({ ...base, id: '$0.1' })).toBe(true);
    expect(isGeneric({ ...base, label: 'MeltRim' })).toBe(false);
    expect(isGeneric({ ...base, id: 'title' })).toBe(false);
  });
});

describe('buildTimeline', () => {
  it('nests child Sequences under their parent and spans from..from+duration', () => {
    const { roots } = buildTimeline(
      [seq('a', 0, 100, { label: 'Shot1' }), seq('a/b', 10, 20, { label: 'Inner', parent: 'a' }), seq('c', 120, 40, { label: 'Audio' })],
      [],
      FPS,
    );
    expect(roots.map((r) => [r.label, r.bars])).toEqual([['Shot1', [[0, 99]]], ['Audio', [[120, 159]]]]);
    expect(roots[0]!.children.map((c) => [c.label, c.bars, c.kind])).toEqual([['Inner', [[10, 29]], 'sequence']]);
  });

  it('folds same component and source into one row, listing the instances under it', () => {
    n = 0;
    const melt = Array.from({ length: 120 }, (_, i) =>
      layer({ id: `m${i}`, label: 'MeltRim', component: 'MeltRim', source: src(201), sequence: 'a', ranges: [[i, i + 1]] }),
    );
    const other = layer({ id: 'bg', label: 'bg', component: 'Shot', source: src(10), sequence: 'a', ranges: [[0, 99]] });
    const { roots } = buildTimeline([seq('a', 0, 130, { label: 'Shot1' })], [other, ...melt], FPS);
    const rows = roots[0]!.children;
    expect(labels(rows)).toEqual(['bg', 'MeltRim x120']);
    const folded = rows[1]!;
    expect(folded.children).toHaveLength(120);
    expect(folded.layerIds).toHaveLength(120);
    // one bar from the first to the last visible frame, not 120 slivers
    expect(folded.bars).toEqual([[0, 120]]);
  });

  it('keeps generic leaves out of the rows but reaches them as pieces', () => {
    const root = layer({ id: 'card', label: 'Card', component: 'Card', source: src(5), sequence: 'a', ranges: [[0, 50]] });
    const g = layer({ id: 'g', label: 'Group', component: 'Card', source: src(6), parent: 'card', sequence: 'a', ranges: [[0, 50]] });
    const sh = layer({ id: 's', label: 'Shape', component: 'Card', source: src(7), parent: 'g', sequence: 'a', ranges: [[0, 50]] });
    const sd = layer({ id: 'sd', label: 'Card · shadow2', component: 'Card', source: src(5), parent: 'card', sequence: 'a', ranges: [[0, 50]] });
    const { roots } = buildTimeline([seq('a', 0, 60, { label: 'Shot' })], [root, g, sh, sd], FPS);
    const rows = roots[0]!.children;
    expect(labels(rows)).toEqual(['Card']);
    expect(rows[0]!.children).toEqual([]);
    expect(labels(rows[0]!.pieces!())).toEqual(['Group', 'Card · shadow2']);
    expect(labels(rows[0]!.pieces!()[0]!.children)).toEqual(['Shape']);
  });

  it('gives a generic layer of a component with no named root the component name', () => {
    const l = layer({ id: '$9', label: 'Shape', component: 'Dot', source: src(3), sequence: 'a', ranges: [[0, 5]] });
    const hidden = layer({ id: '$8', label: 'Shape', sequence: 'a', ranges: [[0, 5]] });
    const { roots } = buildTimeline([seq('a', 0, 10, { label: 'Shot' })], [l, hidden], FPS);
    expect(labels(roots[0]!.children)).toEqual(['Dot']);
  });

  it('splits a bar only when the item is absent for longer than a second', () => {
    const flicker = layer({ id: 'f', label: 'Flicker', component: 'F', source: src(1), sequence: 'a', ranges: [[0, 4], [10, 14], [20, 24], [200, 210]] });
    const { roots } = buildTimeline([seq('a', 0, 300, { label: 'Shot' })], [flicker], FPS);
    expect(roots[0]!.children[0]!.bars).toEqual([[0, 24], [200, 210]]);
    const wide = buildTimeline([seq('a', 0, 300, { label: 'Shot' })], [flicker], FPS, 300);
    expect(wide.roots[0]!.children[0]!.bars).toEqual([[0, 210]]);
  });

  it('attributes layers to a Sequence by time when the server names none, and keeps strays reachable', () => {
    const inside = layer({ id: 'in', label: 'In', component: 'C', source: src(1), ranges: [[10, 20]] });
    const outside = layer({ id: 'out', label: 'Out', component: 'C', source: src(2), ranges: [[200, 210]] });
    const { roots } = buildTimeline([seq('a', 0, 100, { label: 'Shot' })], [inside, outside], FPS);
    expect(roots.map((r) => r.label)).toEqual(['Shot', 'Outside Sequences']);
    expect(labels(roots[0]!.children)).toEqual(['In']);
    expect(labels(roots[1]!.children)).toEqual(['Out']);
  });

  it('nests an instance inside the instance of the component above it', () => {
    const a = layer({ id: 'a', label: 'Panel', component: 'Panel', source: src(1), sequence: 's', ranges: [[0, 9]] });
    const inner = layer({ id: 'i', label: 'Panel · inner', component: 'Panel', source: src(2), parent: 'a', sequence: 's', ranges: [[0, 9]] });
    const b = layer({ id: 'b', label: 'Title', component: 'Title', source: src(9), parent: 'i', sequence: 's', ranges: [[0, 9]] });
    const { roots } = buildTimeline([seq('s', 0, 10, { label: 'Shot' })], [a, inner, b], FPS);
    expect(labels(roots[0]!.children)).toEqual(['Panel']);
    expect(labels(roots[0]!.children[0]!.children)).toEqual(['Title']);
  });

  it('is fast on a launch-film-sized payload', () => {
    n = 0;
    const layers: TimelineLayer[] = [];
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 300; i++) {
        layers.push(layer({ id: `$${s}.${i}`, label: i % 3 === 0 ? 'Shape' : `Part${i % 7}`, component: `C${i % 7}`, source: src(i % 7), sequence: `s${s}`, ranges: [[s * 100 + (i % 50), s * 100 + 99]] }));
      }
    }
    const sequences = Array.from({ length: 12 }, (_, s) => seq(`s${s}`, s * 100, 100, { label: `S${s}` }));
    const t0 = performance.now();
    const { roots } = buildTimeline(sequences, layers, FPS);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(visibleRows(roots, new Set(), '', false)).toHaveLength(12);
  });
});

describe('visibleRows', () => {
  const build = () => {
    n = 0;
    const layers = [
      layer({ id: 'x1', label: 'MeltRim', component: 'MeltRim', source: src(201), sequence: 'a', ranges: [[0, 5]] }),
      layer({ id: 'x2', label: 'MeltRim', component: 'MeltRim', source: src(201), sequence: 'a', ranges: [[3, 8]] }),
      layer({ id: 'y', label: 'Headline', component: 'Title', source: src(5), sequence: 'b', ranges: [[50, 60]] }),
    ];
    return buildTimeline([seq('a', 0, 20, { label: 'Shot1' }), seq('b', 40, 30, { label: 'Shot2' })], layers, FPS).roots;
  };

  it('is collapsed by default: the Sequences only', () => {
    expect(visibleRows(build(), new Set(), '', false).map((r) => r.node.label)).toEqual(['Shot1', 'Shot2']);
  });

  it('opens what is expanded, folded rows to their instances on demand', () => {
    const roots = build();
    const rows1 = visibleRows(roots, new Set(['s:a']), '', false);
    expect(rows1.map((r) => [r.node.label, r.node.count, r.depth, r.expandable])).toEqual([
      ['Shot1', 1, 0, true],
      ['MeltRim', 2, 1, true],
      ['Shot2', 1, 0, true],
    ]);
    const fold = rows1[1]!.node;
    const rows2 = visibleRows(roots, new Set(['s:a', fold.id]), '', false);
    expect(rows2.filter((r) => r.depth === 2).map((r) => r.node.layerIds)).toEqual([['x1'], ['x2']]);
  });

  it('a search keeps the matching rows and their ancestors, opened, by label, component or file', () => {
    const roots = build();
    expect(visibleRows(roots, new Set(), 'headline', false).map((r) => [r.node.label, r.expanded])).toEqual([['Shot2', true], ['Headline', false]]);
    expect(visibleRows(roots, new Set(), 'MELTRIM', false).map((r) => r.node.label)).toEqual(['Shot1', 'MeltRim', 'MeltRim', 'MeltRim']);
    expect(visibleRows(roots, new Set(), 'shots.tsx:5', false).map((r) => r.node.label)).toEqual(['Shot2', 'Headline']);
    expect(visibleRows(roots, new Set(), 'nothing', false)).toEqual([]);
  });
});

describe('seekTarget', () => {
  const node = { bars: [[10, 20], [60, 70]] } as TimelineNode;
  it('goes to the first visible frame unless the playhead is inside a bar', () => {
    expect(seekTarget(node, 0)).toBe(10);
    expect(seekTarget(node, 40)).toBe(10);
    expect(seekTarget(node, 15)).toBeNull();
    expect(seekTarget(node, 70)).toBeNull();
    expect(seekTarget({ bars: [] } as unknown as TimelineNode, 3)).toBeNull();
  });
});

describe('foldSiblings (scene tree)', () => {
  const l = (id: string, component: string | undefined, line: number) => ({ id, ...(component ? { component, source: src(line) } : {}) });
  it('folds identical siblings in place and leaves the rest alone', () => {
    const items = foldSiblings([l('a', 'MeltRim', 1), l('b', undefined, 0), l('c', 'MeltRim', 1), l('d', 'MeltRim', 2), l('e', 'Solo', 3)]);
    expect(items.map((i) => (i.fold ? `${i.label}x${i.layers.length}` : i.layer.id))).toEqual(['MeltRimx2', 'b', 'd', 'e']);
    const fold = items[0]!;
    expect(fold.fold && fold.layers.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
