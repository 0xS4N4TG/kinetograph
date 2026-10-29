import { describe, expect, it } from 'vitest';

import { fitSize, formatDuration, formatTimecode, jobEta, jobPercent, parseTimecode, stepZoom } from '../src/lib/format';
import { buildAgentMessage, relativePath, sequenceOf } from '../src/lib/agent-message';
import { findLayer, hitTest, type InspectLayer } from '../src/lib/inspect';
import { displayName, fullSource, numberByParent, numberSiblings, numberTree, secondLine, tooltip } from '../src/lib/names';
import { fieldKind, helperText, schemaProperties } from '../src/lib/props-schema';
import { layerRows, sequenceRows } from '../src/lib/tree';
import { inspectFor, intro, introTimeline, job, layer } from './fixtures';

describe('format', () => {
  it('writes timecode as MM:SS:FF at the nominal rate', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(45, 30)).toBe('00:01:15');
    expect(formatTimecode(30 * 61 + 2, 30)).toBe('01:01:02');
    expect(formatTimecode(24 * 3600 + 5, 24)).toBe('01:00:00:05');
    expect(formatTimecode(30, 29.97)).toBe('00:01:00');
  });

  it('writes durations', () => {
    expect(formatDuration(4_200)).toBe('4s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  it('works out a job eta from the mean ms per frame', () => {
    expect(jobEta(job('1'))).toBeNull();
    expect(jobEta(job('1', { framesDone: 50, framesTotal: 150, msPerFrame: 20 }))).toBe(2000);
    expect(jobPercent(job('1', { framesDone: 75, framesTotal: 150 }))).toBe(50);
    expect(jobPercent(job('1', { status: 'done' }))).toBe(100);
  });

  it('fits a size into a box without scaling up', () => {
    expect(fitSize(960, 540, 1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(fitSize(1000, 300, 1920, 1080)).toEqual({ width: 533, height: 300 });
    expect(fitSize(4000, 4000, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(0, 0, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('timeline rows', () => {
  it('nests each Sequence under its parent and names unnamed ones Sequence', () => {
    const rows = sequenceRows(introTimeline.sequences);
    expect(rows.map((r) => [r.label, r.depth, r.from, r.end])).toEqual([
      ['Scene', 0, 0, 150],
      ['Title card', 1, 10, 70],
      ['Sequence', 1, 80, 120],
    ]);
  });

  it('nests layers under their group with the topmost first', () => {
    const rows = layerRows(introTimeline.layers);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['title-group', 0],
      ['title', 1],
      ['bg', 0],
    ]);
  });

  it('puts a row whose parent is unknown at the top level', () => {
    const rows = layerRows([{ id: 'x', type: 'shape', parent: 'gone', ranges: [[0, 1]] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
  });
});

describe('findLayer', () => {
  const { layers } = inspectFor(intro, 0);

  it('finds a layer nested inside a group', () => {
    expect(findLayer(layers, 'title')).toMatchObject({ id: 'title', type: 'text' });
  });

  it('finds a top-level layer', () => {
    expect(findLayer(layers, 'bg')).toMatchObject({ id: 'bg', type: 'shape' });
  });

  it('returns null for an id that is not in the tree', () => {
    expect(findLayer(layers, 'missing')).toBeNull();
  });
});

describe('parseTimecode', () => {
  it('reads a frame number, or MM:SS:FF and HH:MM:SS:FF as formatTimecode writes them', () => {
    expect(parseTimecode('45', 30)).toBe(45);
    expect(parseTimecode('00:02:00', 30)).toBe(60);
    expect(parseTimecode(' 00:00:01:15 ', 30)).toBe(45);
    expect(parseTimecode('01:00:00:05', 24)).toBe(24 * 3600 + 5);
  });

  it('is null for anything else', () => {
    for (const text of ['', 'x', '1:2', '00:60:00', '00:00:00:30', '1:2:3:4:5', '-1', '1.5']) {
      expect(parseTimecode(text, 30), text).toBeNull();
    }
  });
});

describe('stepZoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.42, 1)).toBe(0.5);
    expect(stepZoom(0.42, -1)).toBe(0.25);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.125, -1)).toBe(0.125);
  });
});

describe('hitTest', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const shape = (id: string, bounds: ReturnType<typeof rect> | null, extra: Partial<InspectLayer> = {}) =>
    layer(id, 'shape', { bounds, box: bounds, ...extra });

  it('returns the topmost layer under the point: later layers draw on top', () => {
    const layers = [shape('below', rect(0, 0, 100, 100)), shape('above', rect(50, 0, 100, 100))];
    expect(hitTest(layers, 60, 10)?.id).toBe('above');
    expect(hitTest(layers, 10, 10)?.id).toBe('below');
    expect(hitTest(layers, 200, 10)).toBeNull();
  });

  it("puts a group's children on top of the group and of the layers below it", () => {
    const group = layer('group', 'group', {
      bounds: rect(0, 0, 100, 100),
      box: rect(0, 0, 100, 100),
      children: [shape('child', rect(0, 0, 40, 40))],
    });
    const layers = [shape('below', rect(0, 0, 200, 200)), group];
    expect(hitTest(layers, 10, 10)?.id).toBe('child');
    expect(hitTest(layers, 80, 80)?.id).toBe('group');
    expect(hitTest(layers, 150, 150)?.id).toBe('below');
  });

  it('treats the right and bottom edges as outside', () => {
    const layers = [shape('a', rect(0, 0, 100, 50))];
    expect(hitTest(layers, 99.5, 49.5)?.id).toBe('a');
    expect(hitTest(layers, 100, 10)).toBeNull();
    expect(hitTest(layers, 10, 50)).toBeNull();
  });

  it('falls back to the box without bounds, and skips a layer with neither', () => {
    expect(hitTest([shape('boxed', null, { box: rect(0, 0, 10, 10) })], 5, 5)?.id).toBe('boxed');
    expect(hitTest([shape('nowhere', null)], 5, 5)).toBeNull();
  });
});

describe('agent message', () => {
  const comp = { id: 'Intro', fps: 30 };
  const title = layer('title', 'text', {
    transform: { x: 0, y: 0, scale: 1.2, rotation: 0, anchorX: 0, anchorY: 0, rotateX: 0, rotateY: 0, z: 0 },
    box: { x: 100.4, y: 200, width: 300, height: 80 },
    bounds: null,
    effects: ['dropShadow'],
    opacity: 0.5,
    text: { text: 'Hello', font: 'Inter', size: 64, width: 200, height: 80, maxWidth: null, lines: [] },
  });
  const base = { entry: '/repo/examples/launch/index.tsx', cwd: '/repo', comp, frame: 126, layer: title, timeline: introTimeline };

  it('writes the path from the start directory, or as it is from elsewhere', () => {
    expect(relativePath('/repo/a/b.tsx', '/repo')).toBe('a/b.tsx');
    expect(relativePath('/repo/a/b.tsx', '/repo/')).toBe('a/b.tsx');
    expect(relativePath('/other/b.tsx', '/repo')).toBe('/other/b.tsx');
    expect(relativePath('/repository/b.tsx', '/repo')).toBe('/repository/b.tsx');
  });

  it('finds the innermost Sequence showing at the frame whose group holds the layer', () => {
    expect(sequenceOf('title', 30, introTimeline)?.name).toBe('Title card');
    // the same layer outside the Sequence's frames, and a layer in no Sequence's group
    expect(sequenceOf('title', 100, introTimeline)).toBeNull();
    expect(sequenceOf('title-group', 30, introTimeline)?.name).toBe('Title card');
    expect(sequenceOf('bg', 30, introTimeline)?.name).toBe('Scene');
    expect(sequenceOf('title', 30, null)).toBeNull();
  });

  it('names the layer, its Sequence, place and current values, and ends where the user types', () => {
    const message = buildAgentMessage({ ...base, frame: 30 });
    expect(message).toBe(
      [
        'In examples/launch/index.tsx, composition `Intro`, frame 30 (00:01:00):',
        'change the text layer `title`, text "Hello", inside Sequence "Title card" (frames 10 to 69), at 100,200, 300\u00d780.',
        'It looks like this now: font Inter 64, opacity 0.5, scale 1.2, effects dropShadow.',
        '',
        'Change: ',
      ].join('\n'),
    );
  });

  it('leaves out the text and the font of a text layer that has none at this frame', () => {
    const empty = layer('$0.1', 'text', { text: { text: '', font: '', size: 1, width: 0, height: 66, maxWidth: null, lines: [] } });
    const message = buildAgentMessage({ ...base, layer: empty, timeline: null });
    expect(message).toContain('change the text layer `$0.1`, at 0,0, 100\u00d750.');
    expect(message).not.toContain('font');
  });

  it('leaves out what it does not know, and says how to find a layer whose id is its place in the tree', () => {
    const plain = layer('$0.3', 'shape', { box: null, bounds: null });
    const message = buildAgentMessage({ ...base, layer: plain, timeline: null });
    expect(message).toContain('change the shape layer `$0.3`.');
    expect(message).not.toContain('Sequence');
    expect(message).not.toContain('It looks like');
    expect(message).toContain('find it by its text, size and position');
  });
});

describe('names', () => {
  const source = { file: 'examples/showcase/shots-a.tsx', line: 212, column: 7 };

  it('shows the label, else a chosen id, else the kind of layer, never a path id', () => {
    expect(displayName({ id: '$0.1.2', type: 'text', label: 'Title · “Hi”' })).toBe('Title · “Hi”');
    expect(displayName({ id: 'bg', type: 'shape' })).toBe('bg');
    expect(displayName({ id: '$0.1.2', type: 'shape' })).toBe('Shape');
    expect(displayName({ id: '$3', type: 'scene3d' })).toBe('Scene3d');
  });

  it('numbers siblings that share a name, as editors do: Card, Card 2, Card 3', () => {
    const siblings = numberSiblings([
      { id: '$0', type: 'group', label: 'Card' },
      { id: '$1', type: 'shape' },
      { id: '$2', type: 'group', label: 'Card' },
      { id: '$3', type: 'group', label: 'Card' },
      { id: '$4', type: 'shape' },
    ]);
    expect(siblings.map(displayName)).toEqual(['Card', 'Shape', 'Card 2', 'Card 3', 'Shape 2']);
    // Numbering again (after the project changed) drops numbers that are no longer needed.
    expect(numberSiblings([siblings[2]!]).map(displayName)).toEqual(['Card']);
  });

  it('numbers within each parent only: a tree, and a flat list by parent and Sequence', () => {
    type Node = { id: string; type: string; label?: string; children?: Node[] };
    const tree = numberTree<Node>([
      { id: 'a', type: 'group', label: 'Row', children: [{ id: '$a0', type: 'text', label: 'Cell' }, { id: '$a1', type: 'text', label: 'Cell' }] },
      { id: 'b', type: 'group', label: 'Row', children: [{ id: '$b0', type: 'text', label: 'Cell' }] },
    ]);
    expect(tree.map(displayName)).toEqual(['Row', 'Row 2']);
    expect(tree[0]!.children!.map(displayName)).toEqual(['Cell', 'Cell 2']);
    expect(tree[1]!.children!.map(displayName)).toEqual(['Cell']);
    const flat = numberByParent([
      { id: '$0', type: 'shape', parent: null, sequence: 's1' },
      { id: '$0', type: 'shape', parent: null, sequence: 's2' },
      { id: '$1', type: 'shape', parent: null, sequence: 's1' },
      { id: '$2', type: 'shape', parent: '$0', sequence: 's1' },
    ]);
    expect(flat.map(displayName)).toEqual(['Shape', 'Shape', 'Shape 2', 'Shape']);
  });

  it('writes the second line and the tooltip from the component and source', () => {
    expect(secondLine({ component: 'Title', source })).toBe('Title · shots-a.tsx:212');
    expect(secondLine({ source })).toBe('shots-a.tsx:212');
    expect(secondLine({})).toBeUndefined();
    expect(fullSource(source)).toBe('examples/showcase/shots-a.tsx:212:7');
    expect(tooltip('Title', 'text', { component: 'Title', source })).toBe('Title (text)\ncomponent Title\nexamples/showcase/shots-a.tsx:212:7');
    expect(tooltip('bg', 'shape', {})).toBe('bg (shape)');
  });

  it('puts labels, components and sources into the timeline rows', () => {
    const sequences = sequenceRows([
      { key: 'a', name: null, label: 'Opening', component: 'Main', source, from: 0, durationInFrames: 30, parent: null, layer: null },
      { key: 'b', name: null, from: 30, durationInFrames: 30, parent: null, layer: null },
    ]);
    expect(sequences.map((r) => r.label)).toEqual(['Opening', 'Sequence']);
    expect(sequences[0]).toMatchObject({ component: 'Main', source });
    const layers = layerRows([{ id: '$0.0', type: 'text', parent: null, ranges: [[0, 9]], label: 'Title · “Hi”', component: 'Title', source }]);
    expect(layers[0]).toMatchObject({ id: '$0.0', label: 'Title · “Hi”', component: 'Title', source });
  });

  it('tells the agent the name, component and JSX line instead of a place in the tree', () => {
    const named = layer('$0.1.2', 'text', {
      label: 'Title · “Hello”',
      component: 'Title',
      source,
      box: { x: 0, y: 0, width: 10, height: 10 },
      bounds: null,
      text: { text: 'Hello', font: 'Inter', size: 64, width: 200, height: 80, maxWidth: null, lines: [] },
    });
    const sequence = { key: 's', name: null, label: 'Opening', source: { file: 'examples/showcase/index.tsx', line: 42, column: 5 }, from: 0, durationInFrames: 93, parent: null, layer: '$0' };
    const timeline = { sequences: [sequence], layers: [{ id: '$0', type: 'group', parent: null, ranges: [[0, 92]] as [number, number][] }, { id: '$0.1.2', type: 'text', parent: '$0', ranges: [[0, 92]] as [number, number][] }] };
    const message = buildAgentMessage({ entry: '/repo/examples/showcase/index.tsx', cwd: '/repo', comp: { id: 'Showcase', fps: 25 }, frame: 10, layer: named, timeline });
    expect(message).toContain('change the text layer "Title \u00b7 \u201cHello\u201d", drawn by component `Title` (JSX at examples/showcase/shots-a.tsx:212:7), text "Hello"');
    expect(message).toContain('inside Sequence "Opening" (frames 0 to 92, JSX at examples/showcase/index.tsx:42:5)');
    expect(message).not.toContain('$0.1.2');
    expect(message).not.toContain('find it by');
  });

  it('keeps an explicit id next to the label', () => {
    const message = buildAgentMessage({
      entry: '/repo/index.tsx', cwd: '/repo', comp: { id: 'C', fps: 30 }, frame: 0, timeline: null,
      layer: layer('hero', 'shape', { label: 'Hero card', box: null, bounds: null }),
    });
    expect(message).toContain('change the shape layer "Hero card" (id `hero`).');
  });
});

describe('props schema', () => {
  it('picks a field kind from the JSON Schema', () => {
    expect(fieldKind({ type: 'string', enum: ['a', 'b'] })).toEqual({ kind: 'enum', options: ['a', 'b'] });
    expect(fieldKind({ type: 'number', minimum: 0, maximum: 5 })).toEqual({ kind: 'slider', min: 0, max: 5, integer: false });
    expect(fieldKind({ type: 'number', minimum: 0 })).toBeNull();
    expect(fieldKind({ type: 'boolean' })).toEqual({ kind: 'boolean' });
    expect(fieldKind({ type: 'string', description: '__remotion-color' })).toEqual({ kind: 'color' });
    expect(fieldKind({ type: 'string', description: '__remotion-textarea' })).toEqual({ kind: 'textarea' });
    expect(fieldKind({ type: 'object', kinetographPanel: '@x/y', properties: { a: { type: 'string' } } })).toEqual({
      kind: 'panel',
      plugin: '@x/y',
    });
    expect(fieldKind({ type: 'object', properties: { a: { type: 'string' } } })?.kind).toBe('group');
    expect(fieldKind({ anyOf: [] })).toBeNull();
  });

  it('keeps descriptions as help text but not the markers', () => {
    expect(helperText({ description: 'Seconds' })).toBe('Seconds');
    expect(helperText({ description: '__remotion-color' })).toBeNull();
    expect(schemaProperties({ properties: { a: { type: 'string' }, b: 3 } })).toEqual([['a', { type: 'string' }]]);
  });
});
