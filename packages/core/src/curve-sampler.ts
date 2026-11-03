// Remotion's `Internals.createCurveSampler`, which `@remotion/effects`' `curves()` calls to build its look-up table. Written
// from what the published function does, recorded from remotion 4.0.540 (test/fixtures/curve-sampler.json):
//
//   - the sampler maps an input in 0..1 to an output in 0..1; below the first point and above the last it holds their outputs;
//   - `linear`, or only two points, joins the points with straight lines;
//   - anything else (`smooth`) is a cubic spline through the points drawn as a curve (x(t), y(t)) over the length of the
//     polyline, so it can bend back on itself in y; the slopes at the points are limited so x never runs backwards,
//     and each y is cut to 0..1.
//
// Hence the sampler finds t for the input (bisection) and reads y there.

export type CurvePoint = readonly [number, number];

/** Slopes `[dx/ds, dy/ds]` at each point of a natural cubic spline over the polyline length `s`, per axis. */
function splineSlopes(points: readonly CurvePoint[], gaps: number[]): Array<[number, number]> {
  const n = points.length;
  const slopes: Array<[number, number]> = points.map(() => [0, 0]);
  for (const axis of [0, 1] as const) {
    const rise = gaps.map((gap, i) => (points[i + 1]![axis] - points[i]![axis]) / gap);
    // Second derivatives m[1..n-2] (m[0] = m[n-1] = 0) from the tridiagonal system, by forward sweep and back substitution.
    const m = new Array<number>(n).fill(0);
    const c = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const before = gaps[i - 1]!;
      const after = gaps[i]!;
      const pivot = 2 * (before + after) - before * c[i - 1]!;
      c[i] = after / pivot;
      m[i] = (6 * (rise[i]! - rise[i - 1]!) - before * m[i - 1]!) / pivot;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = m[i]! - c[i]! * m[i + 1]!;
    for (let i = 0; i < n; i++) {
      slopes[i]![axis] =
        i === n - 1
          ? rise[i - 1]! + (gaps[i - 1]! * (m[i - 1]! + 2 * m[i]!)) / 6
          : rise[i]! - (gaps[i]! * (2 * m[i]! + m[i + 1]!)) / 6;
    }
  }
  // Keep x(t) from running backwards: a cubic Bezier segment is monotone in x when the x slope at a point is 0..3 times
  // the mean x slope of the segments beside it. A slope that is too steep in x flattens y by the same factor.
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? Infinity : (points[i]![0] - points[i - 1]![0]) / gaps[i - 1]!;
    const right = i === n - 1 ? Infinity : (points[i + 1]![0] - points[i]![0]) / gaps[i]!;
    const limit = 3 * Math.min(left, right);
    const slope = slopes[i]!;
    if (slope[0] > limit) slope[1] *= limit / slope[0];
    slope[0] = Math.max(0, Math.min(limit, slope[0]));
  }
  return slopes;
}

export function createCurveSampler(points: readonly CurvePoint[], interpolation?: string): (input: number) => number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const straight = interpolation !== 'smooth' || points.length < 3;
  const gaps = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  const slopes = straight ? [] : splineSlopes(points, gaps);

  return (input) => {
    if (input <= first[0]) return first[1];
    if (input >= last[0]) return last[1];
    const next = points.findIndex((p) => p[0] > input);
    const from = points[next - 1]!;
    const to = points[next]!;
    if (input === from[0]) return from[1];
    if (straight) return from[1] + ((to[1] - from[1]) * (input - from[0])) / (to[0] - from[0]);

    // The segment as a cubic Bezier whose handles are a third of the segment's length along the slopes.
    const reach = gaps[next - 1]! / 3;
    const a = slopes[next - 1]!;
    const b = slopes[next]!;
    const control = (axis: 0 | 1) => [from[axis], from[axis] + reach * a[axis], to[axis] - reach * b[axis], to[axis]] as const;
    const at = (v: readonly [number, number, number, number], t: number) => {
      const u = 1 - t;
      return u * u * u * v[0] + 3 * u * u * t * v[1] + 3 * u * t * t * v[2] + t * t * t * v[3];
    };
    const xs = control(0);
    let low = 0;
    let high = 1;
    for (let i = 0; i < 32; i++) {
      const mid = (low + high) / 2;
      if (at(xs, mid) < input) low = mid;
      else high = mid;
    }
    return Math.max(0, Math.min(1, at(control(1), (low + high) / 2)));
  };
}
