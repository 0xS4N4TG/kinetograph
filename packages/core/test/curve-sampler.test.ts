import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Internals } from '../src/index.js';

type Fixture = { xs: number[]; cases: Array<{ points: Array<[number, number]>; interp: string | null; ys: number[] }> };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/curve-sampler.json', import.meta.url), 'utf8')) as Fixture;

describe('Internals.createCurveSampler', () => {
  it('gives the values of the published function (remotion 4.0.540, recorded)', () => {
    for (const { points, interp, ys } of fixture.cases) {
      const sample = Internals.createCurveSampler(points, interp ?? undefined);
      fixture.xs.forEach((x, i) => expect(sample(x), `${JSON.stringify(points)} ${interp} at ${x}`).toBeCloseTo(ys[i]!, 9));
    }
  });

  it('holds the end outputs outside the points and passes through each point', () => {
    const sample = Internals.createCurveSampler([[0.2, 0.1], [0.5, 0.7], [0.8, 0.9]], 'smooth');
    expect([sample(0), sample(0.2), sample(0.5), sample(0.8), sample(1)]).toEqual([0.1, 0.1, 0.7, 0.9, 0.9]);
  });
});
