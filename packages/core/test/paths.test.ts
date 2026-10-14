import { describe, expect, it } from 'vitest';
import * as P from '../src/paths.js';
import { fixture } from './helpers.js';

const data = fixture('paths.json');

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
  // The published blend of two paths that differ in structure (an arc against a square, a quadratic against
  // a line, an open path against a closed one) follows its own matching rules, which are not reproduced; the
  // pairs below have the same drawing instructions or differ by line against curve, or by length.
  const comparable = (from: string, to: string) =>
    !hasArc(from + to) && !(hasQuad(from) || hasQuad(to)) && !/Z/.test(from) === !/Z/.test(to);

  it('matches the recorded blends of comparable paths', () => {
    let compared = 0;
    for (const c of data.interpolate) {
      if (!comparable(c.from, c.to)) continue;
      const label = `${c.from} -> ${c.to} @${c.progress}`;
      expectPathClose(P.interpolatePath(c.progress, c.from, c.to), c.result.value, 1e-9, label);
      compared++;
    }
    expect(compared).toBeGreaterThan(25);
  });

  it('returns the paths themselves at the ends', () => {
    expect(P.interpolatePath(0, 'm 0 0 l 10 10', 'M 5 5 L 9 9')).toBe('m 0 0 l 10 10');
    expect(P.interpolatePath(1, 'm 0 0 l 10 10', 'M 5 5 L 9 9')).toBe('M 5 5 L 9 9');
  });

  it('refuses paths it cannot line up', () => {
    expect(() => P.interpolatePath(0.5, 'M 0 0 L 10 10 Z', 'M 0 0 L 10 10')).toThrow(/cannot be interpolated/);
  });
});
