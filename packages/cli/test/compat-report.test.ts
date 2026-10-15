import { describe, expect, it } from 'vitest';
import type { Unsupported } from '@kinetograph/scene';
import { LeftOutCollector, describeLeftOut, strictError } from '../src/compat-report.js';

const issue = (element: string, property: string | null, value: string | null, reason = 'not supported'): Unsupported => ({
  path: '$0 <div>',
  element,
  property,
  value,
  reason,
});

describe('what a render left out', () => {
  it('collects it, one entry per kind, most frames first', () => {
    const collector = new LeftOutCollector();
    for (let frame = 10; frame < 14; frame++) {
      // The same thing twice in a frame counts the frame once.
      collector.add(frame, [
        issue('div', 'transform', 'skewX(5deg)', 'skew'),
        issue('div', 'transform', 'skewX(5deg)', 'skew'),
        ...(frame === 12 ? [issue('canvas', null, null, 'not supported'), issue('div', 'transform', 'skewY(9deg)', 'skew')] : []),
      ]);
    }
    collector.add(14, []);
    const report = collector.report();
    expect(report.unsupportedFrames).toBe(4);
    expect(report.leftOut).toEqual([
      { element: 'div', property: 'transform', reason: 'skew', values: ['skewX(5deg)', 'skewY(9deg)'], frames: 4, firstFrame: 10, lastFrame: 13 },
      { element: 'canvas', property: null, reason: 'not supported', values: [], frames: 1, firstFrame: 12, lastFrame: 12 },
    ]);
  });

  it('warns with a line per kind, and nothing when nothing was left out', () => {
    const collector = new LeftOutCollector();
    for (let frame = 10; frame < 14; frame++) {
      collector.add(frame, [issue('div', 'transform', 'skewX(5deg)', 'skew'), ...(frame === 12 ? [issue('canvas', null, null, 'not supported')] : [])]);
    }
    const lines = describeLeftOut(collector.report());
    expect(lines[0]).toBe('warning: 2 kinds of unsupported content in 4 frames, drawn without it or approximated (--strict fails instead):');
    expect(lines[1]).toBe('  div { transform: skewX(5deg) }: skew (4 frames, 10..=13)');
    expect(lines[2]).toBe('  canvas: not supported (frame 12)');
    expect(describeLeftOut(new LeftOutCollector().report())).toEqual([]);
  });

  it('cuts a long list short', () => {
    const collector = new LeftOutCollector();
    collector.add(0, Array.from({ length: 5 }, (_, i) => issue(`e${i}`, null, null)));
    const lines = describeLeftOut(collector.report(), 2);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('  … and 3 more');
  });
});

describe('strictError', () => {
  it('names the frame and what it holds', () => {
    const error = strictError(7, [issue('div', 'filter', 'url(#x)', 'an SVG filter is not supported'), issue('canvas', null, null)]);
    expect(error.code).toBe('UNSUPPORTED_CONTENT');
    expect(error.message).toContain('--strict: frame 7 holds content the engine cannot draw:');
    expect(error.message).toContain('  div { filter: url(#x) }: an SVG filter is not supported');
    expect(error.message).toContain('  canvas: not supported');
    expect(error.message).toContain('kinetograph doctor <entry>');
  });
});
