import { describe, expect, it } from 'vitest';

import { buildChatContext } from '../src/lib/chat-context';
import { sheetLayout } from '../src/lib/contact-sheet';
import { chipText, clampRange, contactFrames, extendRange, makeRange, rangeLabel, rangeStamp } from '../src/lib/selection';
import { intro, introTimeline, layer } from './fixtures';

describe('the time range', () => {
  it('orders, snaps to whole frames and stays inside the composition', () => {
    expect(makeRange(75, 30, 150)).toEqual({ start: 30, end: 75 });
    expect(makeRange(10.7, 12.2, 150)).toEqual({ start: 10, end: 12 });
    expect(makeRange(-20, 400, 150)).toEqual({ start: 0, end: 149 });
    expect(makeRange(3, 4, 0)).toBeNull();
  });

  it('extends to take in a new span, and clamps when the composition gets shorter', () => {
    expect(extendRange(null, 5, 9, 150)).toEqual({ start: 5, end: 9 });
    expect(extendRange({ start: 30, end: 40 }, 10, 12, 150)).toEqual({ start: 10, end: 40 });
    expect(extendRange({ start: 30, end: 40 }, 35, 90, 150)).toEqual({ start: 30, end: 90 });
    expect(clampRange({ start: 30, end: 140 }, 100)).toEqual({ start: 30, end: 99 });
    expect(clampRange(null, 100)).toBeNull();
  });

  it('writes times and the label', () => {
    expect(rangeStamp(30, 30)).toBe('0:01.0');
    expect(rangeStamp(75, 30)).toBe('0:02.5');
    expect(rangeStamp(30 * 65, 30)).toBe('1:05.0');
    expect(rangeLabel({ start: 30, end: 75 }, 30)).toBe('0:01.0–0:02.5 (frames 30–75)');
  });

  it('picks up to eight frames evenly, ends included', () => {
    expect(contactFrames({ start: 0, end: 70 })).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(contactFrames({ start: 4, end: 6 })).toEqual([4, 5, 6]);
    expect(contactFrames({ start: 9, end: 9 })).toEqual([9]);
  });

  it('lays the contact sheet out in a grid of four columns', () => {
    const l = sheetLayout(8, 480, 270);
    expect(l.width).toBe(4 * 480 + 18);
    expect(l.height).toBe(2 * 270 + 6);
    expect(l.tiles[5]).toEqual({ x: 486, y: 276 });
  });
});

describe('the context for a range', () => {
  const base = { entry: '/repo/index.tsx', cwd: '/repo', comp: intro, frame: 120, timeline: introTimeline };

  it('says the span, the Sequences it overlaps and the layers visible in it', () => {
    const text = buildChatContext({ ...base, layers: [], range: { start: 60, end: 85 } });
    expect(text).toContain('a span of time: 0:02.0–0:02.8 (frames 60–85)');
    expect(text).toContain('"Scene" (frames 0 to 149), "Title card" (frames 10 to 69), "Sequence" (frames 80 to 119)');
    expect(text).toContain('Layers visible at some point in it:');
    expect(text).toContain('"bg"');
    expect(text).toContain('"title"');
  });

  it('leaves out layers that are gone by then, and keeps the single frame without a range', () => {
    const text = buildChatContext({ ...base, layers: [], range: { start: 100, end: 110 } });
    expect(text).not.toContain('"title"');
    expect(text).not.toContain('Title card');
    expect(buildChatContext({ ...base, layers: [] })).toContain('frame 120');
  });

  it('puts the span in a layer chip in place of the frame', () => {
    const l = layer('x', 'shape', { label: 'HexedLook' } as never);
    expect(chipText(l, 4, '/repo', '0:01.0–0:02.5 (frames 30–75)')).toBe('HexedLook · 0:01.0–0:02.5 (frames 30–75)');
    expect(chipText(l, 4)).toBe('HexedLook · frame 4');
  });
});
