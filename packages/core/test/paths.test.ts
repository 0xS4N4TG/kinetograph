import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Easing } from '../src/easing.js';
import * as P from '../src/paths.js';
import { fixture } from './helpers.js';

const data = fixture('paths.json');
/** Blends, warps and edge cases recorded later from the published package. */
const more = fixture('paths-interpolate-warp.json');

/** Numbers in a path string compared to `tolerance` (relative to 1 + |value|); the text around them exactly. */
function expectPathClose(actual: string, expected: string, tolerance: number, label: string) {
  const split = (s: string) => s.split(/(-?\d*\.?\d+(?:e[+-]?\d+)?)/i);
  const a = split(actual);
  const e = split(expected);
  expect(a.length, `${label}: ${actual} vs ${expected}`).toBe(e.length);
  for (let i = 0; i < a.length; i++) {
    if (i % 2 === 0) expect(a[i], label).toBe(e[i]);
    else {
      const x = Number(a[i]);
      const y = Number(e[i]);
      expect(Math.abs(x - y) / (1 + Math.abs(y)), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
    }
  }
}

function expectNumbersClose(actual: any, expected: any, tolerance: number, label: string) {
  if (typeof expected === 'number') {
    expect(Math.abs(actual - expected) / (1 + Math.abs(expected)), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
  } else if (expected !== null && typeof expected === 'object') {
    for (const key of Object.keys(expected)) expectNumbersClose(actual?.[key], expected[key], tolerance, `${label}.${key}`);
  } else if (label.endsWith('.viewBox')) {
    // checked separately, number by number
  } else expect(actual, label).toEqual(expected);
}

const hasArc = (d: string) => /[aA]/.test(d);
const hasQuad = (d: string) => /[qQtT]/.test(d);

/**
 * The same path as recorded: exactly, but where an arc was turned into cubics, whose last digits differ from the
 * published package's, to a relative 1e-9 per number.
 */
function expectSamePath(actual: string, expected: string, arcs: boolean, label: string) {
  if (arcs) expectPathClose(actual, expected, 1e-9, label);
  else expect(actual, label).toBe(expected);
}

describe('parse and serialize', () => {
  it('parse the same instructions as the published package', () => {
    for (const p of data.paths) {
      if (p.parse.error) expect(() => P.parsePath(p.d), p.d).toThrow(p.parse.error);
      else expect(P.parsePath(p.d), p.d).toEqual(p.parse.value);
    }
  });

  it('serialize to the same text', () => {
    for (const p of data.paths) expect(P.serializeInstructions(P.parsePath(p.d)), p.d).toBe(p.serialize.value);
  });

  it('normalize relative instructions to absolute ones', () => {
    for (const p of data.paths) expect(P.normalizePath(p.d), p.d).toBe(p.normalize.value);
  });

  it('read arc flags written without separators', () => {
    expect(P.parsePath('M0 0a1 1 0 011 1')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'a', rx: 1, ry: 1, xAxisRotation: 0, largeArcFlag: false, sweepFlag: true, dx: 1, dy: 1 },
    ]);
  });

  it('report the recorded errors', () => {
    expect(() => P.parsePath('')).toThrow('No path provided');
    expect(() => P.parsePath('M 0 0 L 10')).toThrow(/Malformed path data: L was expected to have a multiple of 2 numbers/);
  });
});

describe('reduceInstructions', () => {
  it('gives M, L, C and Z in absolute coordinates, like the published package', () => {
    for (const p of data.paths) {
      const got = P.reduceInstructions(P.parsePath(p.d));
      const tolerance = hasArc(p.d) ? 1e-6 : 1e-12;
      expect(got.length, p.d).toBe(p.reduce.value.length);
      got.forEach((r, i) => expectNumbersClose(r, p.reduce.value[i], tolerance, `${p.d} #${i}`));
    }
  });
});

describe('lengths', () => {
  it('getLength matches', () => {
    for (const p of data.paths) {
      expectNumbersClose(P.getLength(p.d), p.length.value, hasArc(p.d) ? 1e-5 : 1e-8, p.d);
    }
  });

  it('getPointAtLength and getTangentAtLength match', () => {
    for (const p of data.paths) {
      for (const sample of p.points ?? []) {
        const tolerance = hasArc(p.d) ? 1e-3 : 1e-5;
        expectNumbersClose(P.getPointAtLength(p.d, sample.at), sample.point.value, tolerance, `${p.d} @${sample.at}`);
        // The published tangent of most arcs points backwards along the path; ours points the way the path goes.
        // (A cubic whose control points sit on its ends has no derivative there: the published tangent is 0, 0.)
        if (!hasArc(p.d) && !(sample.tangent.value.x === 0 && sample.tangent.value.y === 0) && sample.tangent.value.x !== null) {
          expectNumbersClose(P.getTangentAtLength(p.d, sample.at), sample.tangent.value, 1e-4, `${p.d} tangent @${sample.at}`);
        }
      }
    }
  });

  it('points the tangent of an arc the way the path goes', () => {
    // 'M 0 0 A 50 50 0 0 1 100 0' rises from the start and comes down at the end.
    const start = P.getTangentAtLength('M 0 0 A 50 50 0 0 1 100 0', 0)!;
    const end = P.getTangentAtLength('M 0 0 A 50 50 0 0 1 100 0', Math.PI * 50)!;
    expect(start.y).toBeLessThan(-0.99);
    expect(end.y).toBeGreaterThan(0.99);
    // A circle drawn counterclockwise on screen starts downwards.
    expect(P.getTangentAtLength('M 0 50 a 50 50 0 1 0 100 0', 0)!.y).toBeGreaterThan(0.99);
  });

  it('returns null past the end and rejects a negative length', () => {
    expect(P.getPointAtLength('M 0 0 L 100 0', 500)).toBeNull();
    expect(P.getTangentAtLength('M 0 0 L 100 0', 500)).toBeNull();
    expect(() => P.getPointAtLength('M 0 0 L 100 0', -5)).toThrow('Length less than 0 was passed');
  });

  it('getInstructionIndexAtLength matches', () => {
    for (const p of data.paths) {
      for (const sample of p.points ?? []) {
        if (sample.index.error) continue;
        // Right on the border of two instructions, rounding decides which one it is.
        const into = sample.index.value.lengthIntoInstruction;
        if (into < 1e-6 || p.points.some((q: any) => q !== sample && Math.abs(q.at - sample.at) < 1e-9)) continue;
        const got = P.getInstructionIndexAtLength(p.d, sample.at);
        expect(got.index, `${p.d} @${sample.at}`).toBe(sample.index.value.index);
        expectNumbersClose(got.lengthIntoInstruction, sample.index.value.lengthIntoInstruction, hasArc(p.d) ? 1e-3 : 1e-6, p.d);
      }
    }
    expect(() => P.getInstructionIndexAtLength('M 0 0 L 10 0 L 10 10', 100)).toThrow(
      'A length of 100 was passed to getInstructionIndexAtLength() but the total length of the path is only 20',
    );
  });

  it('evolvePath gives the dash that draws the first part', () => {
    for (const p of data.paths) {
      for (const e of p.evolve ?? []) {
        const got = P.evolvePath(e.progress, p.d);
        const [length] = got.strokeDasharray.split(' ');
        expectNumbersClose(Number(length), Number(e.result.value.strokeDasharray.split(' ')[0]), hasArc(p.d) ? 1e-4 : 1e-8, p.d);
        expect(got.strokeDasharray).toBe(`${length} ${length}`);
        expectNumbersClose(got.strokeDashoffset, e.result.value.strokeDashoffset, hasArc(p.d) ? 1e-4 : 1e-8, p.d);
      }
    }
  });

  it('cutPath keeps the first part of the path', () => {
    for (const p of data.paths) {
      if (hasArc(p.d) || hasQuad(p.d) || /[sS]/.test(p.d) || /[CcZz]/.test(p.d)) continue;
      for (const c of p.cut ?? []) expectPathClose(P.cutPath(p.d, c.at), c.result.value, 1e-9, `${p.d} cut ${c.at}`);
    }
    expectPathClose(P.cutPath('M 0 0 C 10 50 60 50 100 0', P.getLength('M 0 0 C 10 50 60 50 100 0') / 2).split(' C')[0]!, 'M 0 0', 0, 'cubic start');
  });
});

describe('transforms', () => {
  it('translatePath leaves relative instructions as they are', () => {
    for (const p of data.paths) expect(P.translatePath(p.d, 5, -7.5), p.d).toBe(p.translate.value);
  });

  it('getBoundingBox matches', () => {
    for (const p of data.paths) {
      const got = P.getBoundingBox(p.d);
      expectNumbersClose(got, p.bbox.value, hasArc(p.d) ? 1e-4 : 1e-9, p.d);
      expectPathClose(got.viewBox, p.bbox.value.viewBox, hasArc(p.d) ? 1e-4 : 1e-9, `viewBox ${p.d}`);
    }
  });

  it('resetPath and centerPath move the bounding box', () => {
    for (const p of data.paths) {
      const tolerance = hasArc(p.d) ? 1e-4 : 1e-9;
      expectPathClose(P.resetPath(p.d), p.reset.value, tolerance, `reset ${p.d}`);
      expectPathClose(P.centerPath(p.d), p.center.value, tolerance, `center ${p.d}`);
    }
  });

  it('scalePath scales about the top left of the bounding box', () => {
    for (const p of data.paths) {
      for (const s of p.scale) {
        expectPathClose(P.scalePath(p.d, s.x, s.y), s.result.value, hasArc(p.d) ? 1e-5 : 1e-9, `scale ${s.x},${s.y} ${p.d}`);
      }
    }
  });

  it('reversePath draws the same shape backwards', () => {
    for (const p of data.paths) {
      expectPathClose(P.reversePath(p.d), p.reverse.value, hasArc(p.d) ? 1e-5 : 1e-9, `reverse ${p.d}`);
    }
  });

  it('getSubpaths splits at each moveto', () => {
    for (const p of data.paths) expect(P.getSubpaths(p.d), p.d).toEqual(p.subpaths.value);
  });

  it('extendViewBox grows about the middle', () => {
    for (const e of data.misc.extendViewBox) expect(P.extendViewBox(e.viewBox, e.scale)).toBe(e.result.value);
  });
});

describe('interpolatePath', () => {
  it('matches every recorded blend, whatever the structure of the two paths', () => {
    expect(data.interpolate.length).toBeGreaterThan(60);
    for (const c of data.interpolate) {
      const label = `${c.from} -> ${c.to} @${c.progress}`;
      expectSamePath(P.interpolatePath(c.progress, c.from, c.to), c.result.value, hasArc(c.from + c.to), label);
    }
  });

  it('returns the paths themselves at the ends', () => {
    expect(P.interpolatePath(0, 'm 0 0 l 10 10', 'M 5 5 L 9 9')).toBe('m 0 0 l 10 10');
    expect(P.interpolatePath(1, 'm 0 0 l 10 10', 'M 5 5 L 9 9')).toBe('M 5 5 L 9 9');
  });

  it('matches the published package on the edge cases: a close only one has, subpaths that do not line up, an empty path', () => {
    for (const c of more.interpolatePath) {
      const run = () => P.interpolatePath(c.progress, more.paths[c.from] ?? c.from, more.paths[c.to] ?? c.to);
      if (c.output.error) expect(run, `${c.from} -> ${c.to}`).toThrow(c.output.error);
      else expectSamePath(run(), c.output, hasArc(c.from + c.to), `${c.from} -> ${c.to}`);
    }
  });
});

/** The transformers `record-paths` used, by name. */
const transformers: Record<string, P.WarpPathFn> = {
  identity: (p) => p,
  scale: (p) => ({ x: p.x * 2, y: p.y * 0.5 }),
  wave: (p) => ({ x: p.x, y: p.y + Math.sin(p.x / 10) * 6 }),
  swirl: (p) => ({ x: p.x + Math.cos(p.y / 7) * 4, y: p.y + Math.sin(p.x / 7) * 4 }),
};

describe('interpolatePaths', () => {
  it('matches the published package exactly for every recorded blend, easing, posterize and extrapolation', () => {
    expect(more.interpolatePaths.length).toBeGreaterThan(150);
    for (const c of more.interpolatePaths) {
      const easings: Record<string, (t: number) => number> = {
        'in(quad)': Easing.in(Easing.quad),
        'out(cubic)': Easing.out(Easing.cubic),
        'inOut(ease)': Easing.inOut(Easing.ease),
        linear: Easing.linear,
      };
      const options: Record<string, unknown> = {};
      if (c.easing) options.easing = Array.isArray(c.easing) ? c.easing.map((n: string) => easings[n]) : easings[c.easing];
      for (const key of ['posterize', 'extrapolateLeft', 'extrapolateRight']) if (c[key] !== undefined) options[key] = c[key];
      const outputRange = typeof c.outputRange === 'string' ? c.outputRange : c.outputRange.map((n: unknown) => (typeof n === 'string' ? more.paths[n] ?? n : n));
      const run = () => P.interpolatePaths(c.input, c.inputRange, outputRange, Object.keys(options).length ? options : undefined);
      const label = JSON.stringify(c).slice(0, 200);
      if (c.output.error) expect(run, label).toThrow(c.output.error);
      else expectSamePath(run(), c.output, JSON.stringify(c.outputRange).match(/"arc"/) !== null, label);
    }
  });

  it('returns a path as written at its keyframe', () => {
    const [a, b] = [more.paths.squareA, more.paths.squareB];
    expect(P.interpolatePaths(0, [0, 10], [a, b])).toBe(a);
    expect(P.interpolatePaths(10, [0, 10], [a, b])).toBe(b);
    expect(P.interpolatePaths(5, [0, 10], [a, b])).not.toBe(a);
  });
});

describe('warpPath', () => {
  it('matches the published package exactly: every recorded path, transformer and threshold', () => {
    expect(more.warpPath.length).toBeGreaterThan(40);
    for (const c of more.warpPath) {
      const label = `${c.path} ${c.transformer} ${JSON.stringify(c.options)}`;
      const warped = P.warpPath(more.paths[c.path] ?? c.path, transformers[c.transformer]!, c.options ?? undefined);
      const arcs = hasArc(more.paths[c.path] ?? c.path);
      if (typeof c.output === 'string') {
        expectSamePath(warped, c.output, arcs, label);
      } else if (!arcs) {
        // A long path is recorded as its length and hash. (An arc is turned into cubics with different last digits.)
        expect(warped.length, label).toBe(c.output.length);
        expect(createHash('sha256').update(warped).digest('hex'), label).toBe(c.output.sha256);
      }
    }
  });

  it('cuts lines into pieces no longer than the threshold before moving them', () => {
    const cut = P.warpPath('M 0 0 L 100 0', (p) => p, { interpolationThreshold: 30 });
    expect(cut).toBe('M 0 0 L 25 0 L 50 0 L 75 0 L 100 0');
  });
});

// Remotion 4.0.539. Expected values are what the published 4.0.539 gives.
describe('relative quadratic segments with a control point on the start (Remotion 4.0.539)', () => {
  const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

  it('measure a straight line from the current point', () => {
    close(P.getLength('M 10 20 q 0 0 30 40'), 50);
    close(P.getLength('M 10 20 Q 10 20 40 60'), 50);
    close(P.getLength('M 10 20 q 0 0 30 30'), 42.42640687119285);
    close(P.getLength('M 0 0 q 0 0 -30 40'), 50);
    close(P.getLength('M 10 20 q 0 0 30 40 l 10 0'), 60);
  });

  it('find points and tangents on that line', () => {
    const d = 'M 10 20 q 0 0 30 40';
    const points = [0, 10, 25, 50].map((at) => P.getPointAtLength(d, at));
    [[10, 20], [16, 28], [25, 40], [40, 60]].forEach(([x, y], i) => {
      close(points[i]!.x, x!);
      close(points[i]!.y, y!);
    });
    const tangent = P.getTangentAtLength(d, 25)!;
    close(tangent.x, 0.6);
    close(tangent.y, 0.8);
    const after = P.getPointAtLength('M 10 20 q 0 0 30 40 l 10 0', 60)!;
    close(after.x, 50);
    close(after.y, 60);
  });

  it('animate the stroke by the real length', () => {
    expect(P.evolvePath(0.5, 'M 10 20 q 0 0 30 40')).toEqual({ strokeDasharray: '50 50', strokeDashoffset: 25 });
  });
});

describe('translatePath with a path that starts with m (Remotion 4.0.539)', () => {
  it('moves the first moveto and keeps the relative commands after it', () => {
    expect(P.translatePath('m10 20 l30 40', 5, -7.5)).toBe('m 15 12.5 l 30 40');
    expect(P.translatePath('m10 20 L40 60', 5, -7.5)).toBe('m 15 12.5 L 45 52.5');
    expect(P.translatePath('M10 20 l30 40', 5, -7.5)).toBe('M 15 12.5 l 30 40');
    expect(P.translatePath('m10 20 30 40', 5, -7.5)).toBe('m 15 12.5 l 30 40');
    expect(P.translatePath('m10 20 l5 5 m3 3 l1 1', 5, -7.5)).toBe('m 15 12.5 l 5 5 m 3 3 l 1 1');
    expect(P.translatePath('m 1 2 h 10 v 5 z m 4 4 l 2 2', 5, -7.5)).toBe('m 6 -5.5 h 10 v 5 Z m 4 4 l 2 2');
  });

  it('resets and centres such a path', () => {
    expect(P.resetPath('m10 20 l30 40')).toBe('m 0 0 l 30 40');
    expect(P.resetPath('m10 20 L40 60')).toBe('m 0 0 L 30 40');
    expect(P.centerPath('m10 20 l30 40')).toBe('m -15 -20 l 30 40');
    expect(P.centerPath('m10 20 L40 60')).toBe('m -15 -20 L 15 20');
    expect(P.centerPath('m10 20 l5 5 m3 3 l1 1')).toBe('m -4.5 -4.5 l 5 5 m 3 3 l 1 1');
    expect(P.centerPath('m 1 2 h 10 v 5 z m 4 4 l 2 2')).toBe('m -5 -3 h 10 v 5 Z m 4 4 l 2 2');
  });
});

/**
 * Recorded from @remotion/paths 4.0.540: arcs with a zero radius are straight lines (4.0.539 measured them as a point at
 * 0, 0), a T after any command but Q or T reflects nothing (it starts from the current point), and getBoundingBox() reads
 * curves whose first control point sits on the start (a flat tangent).
 */
describe('zero-radius arcs, smooth quadratics and flat tangents (Remotion 4.0.540)', () => {
  const groups = fixture('paths-4.0.540.json').groups as Record<string, any[]>;
  const cases = Object.values(groups).flat();
  const hasRealArc = (d: string) => P.parsePath(d).some((i) => (i.type === 'A' || i.type === 'a') && i.rx !== 0 && i.ry !== 0);

  it('normalize and reduce to the same instructions', () => {
    for (const c of cases) {
      expect(P.normalizePath(c.d), c.d).toBe(c.normalize.value);
      const got = P.reduceInstructions(P.parsePath(c.d));
      expect(got.length, c.d).toBe(c.reduce.value.length);
      got.forEach((r, i) => expectNumbersClose(r, c.reduce.value[i], hasRealArc(c.d) ? 1e-6 : 1e-12, `${c.d} #${i}`));
    }
  });

  it('measure the same length and bounding box', () => {
    for (const c of cases) {
      const arcs = hasRealArc(c.d);
      expectNumbersClose(P.getLength(c.d), c.length.value, arcs ? 1e-5 : hasQuad(c.d) ? 1e-7 : 1e-8, c.d);
      const box = P.getBoundingBox(c.d);
      expectNumbersClose(box, c.bbox.value, arcs ? 1e-4 : 1e-9, `bbox ${c.d}`);
      expectPathClose(box.viewBox, c.bbox.value.viewBox, arcs ? 1e-4 : 1e-9, `viewBox ${c.d}`);
    }
  });

  it('find the same points and tangents along the path', () => {
    for (const c of cases) {
      const arcs = hasRealArc(c.d);
      for (const s of c.points) {
        expectNumbersClose(P.getPointAtLength(c.d, s.at), s.point.value, arcs || hasQuad(c.d) ? 1e-3 : 1e-5, `${c.d} @${s.at}`);
        // The published tangent of an arc, a zero-radius one too, points backwards along the path; ours points the way it goes.
        // A curve whose control point sits on its end has no derivative there: the published tangent is 0, 0.
        const flat = s.tangent.value.x === 0 && s.tangent.value.y === 0;
        if (!hasArc(c.d) && !flat) expectNumbersClose(P.getTangentAtLength(c.d, s.at), s.tangent.value, 1e-4, `${c.d} tangent @${s.at}`);
      }
    }
  });

  it('walk a zero-radius arc as the straight line to its end', () => {
    expect(P.getLength('M 0 0 A 0 0 0 0 1 100 0')).toBe(100);
    expect(P.getPointAtLength('M 0 0 A 0 10 0 0 1 100 0', 25)).toEqual({ x: 25, y: 0 });
    expect(P.getTangentAtLength('M 0 0 A 10 0 0 1 0 100 0 L 100 50', 40)).toEqual({ x: 1, y: 0 });
    expect(P.evolvePath(0.5, 'M 0 0 A 0 0 0 0 1 100 0')).toEqual({ strokeDasharray: '100 100', strokeDashoffset: 50 });
  });
});
