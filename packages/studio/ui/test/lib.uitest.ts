import { describe, expect, it } from 'vitest';

import { fitSize, formatDuration, formatTimecode, jobEta, jobPercent, parseTimecode, stepZoom } from '../src/lib/format';
import { findLayer, hitTest, type InspectLayer } from '../src/lib/inspect';
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
