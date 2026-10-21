import { describe, expect, it } from 'vitest';

import { fitSize, formatDuration, formatTimecode, jobEta, jobPercent } from '../src/lib/format';
import { findLayer } from '../src/lib/inspect';
import { layerRows, sequenceRows } from '../src/lib/tree';
import { inspectFor, intro, introTimeline, job } from './fixtures';

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
