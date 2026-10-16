import { describe, expect, it } from 'vitest';
import * as S from '../src/shapes.js';
import { parsePath } from '../src/paths.js';
import { fixture } from './helpers.js';
import { renderAt } from './scene-harness.js';

const data = fixture('shapes.json');

function numbers(path: string): { text: string[]; values: number[] } {
  const parts = path.split(/(-?\d*\.?\d+(?:e[+-]?\d+)?)/i);
  return { text: parts.filter((_, i) => i % 2 === 0), values: parts.filter((_, i) => i % 2 === 1).map(Number) };
}

function expectShapeClose(actual: S.ShapeInfo, expected: any, label: string, tolerance = 1e-9) {
  const a = numbers(actual.path);
  const e = numbers(expected.path);
  expect(a.text, `${label} (path text)`).toEqual(e.text);
  expect(a.values.length, label).toBe(e.values.length);
  a.values.forEach((v, i) => {
    expect(Math.abs(v - e.values[i]!) / (1 + Math.abs(e.values[i]!)), `${label} #${i}: ${actual.path}`).toBeLessThanOrEqual(tolerance);
  });
  expect(Math.abs(actual.width - expected.width), `${label} width`).toBeLessThanOrEqual(tolerance * (1 + expected.width));
  expect(Math.abs(actual.height - expected.height), `${label} height`).toBeLessThanOrEqual(tolerance * (1 + expected.height));
  const origin = (text: string) => text.split(' ').map(Number);
  origin(actual.transformOrigin).forEach((v, i) => expect(Math.abs(v - origin(expected.transformOrigin)[i]!), `${label} origin`).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(v))));
}

/** Inputs the published package draws something for anyway (an empty or nonsensical shape) and this one refuses. */
const isNonsense = (c: any) =>
  c.options.width === 0 || c.options.radius < 0 || c.options.direction === 'sideways' || (c.fn === 'makeStar' && c.options.points < 2);

describe('make* shapes', () => {
  it('match the recorded paths, sizes and transform origins', () => {
    let compared = 0;
    for (const c of data.cases) {
      if (c.result.error || isNonsense(c)) continue;
      const make = (S as any)[c.fn];
      expectShapeClose(make(c.options), c.result, `${c.fn}(${JSON.stringify(c.options)})`);
      compared++;
    }
    expect(compared).toBeGreaterThan(70);
  });

  it('refuse what the published package refuses', () => {
    expect(() => S.makeRect({ width: 100, height: 50, cornerRadius: 10, edgeRoundness: 0.3 })).toThrow(/cannot be specified at the same time/);
    expect(() => S.makePolygon({ points: 2, radius: 5 })).toThrow(/points/);
    expect(() => S.makeTriangle({ length: 10, direction: 'sideways' as never })).toThrow(/direction/);
    expect(() => S.makeCircle({ radius: 0 })).toThrow(/radius/);
  });

  it('return the parsed instructions too', () => {
    const rect = S.makeRect({ width: 10, height: 5 });
    expect(rect.instructions).toEqual(parsePath(rect.path));
    expect(rect.instructions[0]).toEqual({ type: 'M', x: 0, y: 0 });
  });
});

describe('shape components', () => {
  it('draw their path with the paint given', () => {
    const [layer] = renderAt(<S.Circle radius={20} fill="#f00" stroke="#00f" strokeWidth={3} x={5} />).layers as any[];
    expect(layer).toMatchObject({
      type: 'shape',
      shape: { kind: 'path', d: S.makeCircle({ radius: 20 }).path },
      fill: '#f00',
      stroke: { color: '#00f', width: 3 },
      transform: { x: 5 },
    });
  });

  it('take the engine stroke object as well', () => {
    const [layer] = renderAt(<S.Rect width={40} height={20} cornerRadius={4} stroke={{ color: '#000', width: 2 }} />).layers as any[];
    expect(layer.stroke).toEqual({ color: '#000', width: 2 });
    expect(layer.shape.d).toBe(S.makeRect({ width: 40, height: 20, cornerRadius: 4 }).path);
  });

  it('exist for every shape', () => {
    const nodes = [
      <S.Rect key="1" width={10} height={10} />,
      <S.Circle key="2" radius={5} />,
      <S.Ellipse key="3" rx={5} ry={3} />,
      <S.Triangle key="4" length={10} direction="up" />,
      <S.Star key="5" points={5} innerRadius={3} outerRadius={6} />,
      <S.Polygon key="6" points={6} radius={5} />,
      <S.Pie key="7" radius={5} progress={0.3} />,
      <S.Heart key="8" height={10} />,
      <S.Arrow key="9" />,
      <S.Callout key="10" />,
      <S.Spark key="11" width={10} height={14} />,
    ];
    const layers = renderAt(<>{nodes}</>).layers;
    expect(layers).toHaveLength(11);
    expect(new Set(layers.map((l) => l.type))).toEqual(new Set(['shape']));
  });
});

describe('makeArrow, makeCallout and makeSpark', () => {
  const recorded = fixture('shapes-arrow-callout-spark.json');

  it('match the published package: path, instructions, size and transform origin, and its errors', () => {
    expect(recorded.cases.length).toBeGreaterThan(80);
    for (const c of recorded.cases) {
      const label = `${c.fn}(${JSON.stringify(c.options)})`;
      const make = (S as any)[c.fn];
      if (c.result.error) {
        expect(() => make(c.options), label).toThrow(c.result.error);
      } else {
        expect(make(c.options), label).toEqual(c.result);
      }
    }
  });

  it('draw their path with the paint given, defaults and all', () => {
    const [arrow] = renderAt(<S.Arrow direction="up" fill="#0f0" />).layers as any[];
    expect(arrow).toMatchObject({ type: 'shape', shape: { kind: 'path', d: S.makeArrow({ direction: 'up' }).path }, fill: '#0f0' });
    const [callout] = renderAt(<S.Callout pointerDirection="left" cornerRadius={8} stroke="#000" strokeWidth={2} />).layers as any[];
    expect(callout.shape.d).toBe(S.makeCallout({ pointerDirection: 'left', cornerRadius: 8 }).path);
    expect(callout.stroke).toEqual({ color: '#000', width: 2 });
    const [spark] = renderAt(<S.Spark width={40} height={60} edgeRoundness={0.5} />).layers as any[];
    expect(spark.shape.d).toBe(S.makeSpark({ width: 40, height: 60, edgeRoundness: 0.5 }).path);
  });
});
