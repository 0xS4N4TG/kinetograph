// `Easing`, Remotion's copy of React Native's easing set. Written from the
// documented definitions; test/fixtures/easing.json holds values recorded
// from the published package.

import { measureSpring, spring, type SpringConfig } from './spring.js';

/** `remotionShouldExtendRight` marks a curve that goes on past 1 (a spring with a tail): `interpolate` lets it run on. */
export type EasingFunction = ((t: number) => number) & { readonly remotionShouldExtendRight?: boolean };

export type EasingSpringConfig = Partial<Pick<SpringConfig, 'damping' | 'mass' | 'stiffness' | 'overshootClamping'>> & {
  /** Let the spring run on past its end instead of ending at 1 (for `interpolate`, which then keeps the tail going). */
  readonly allowTail?: boolean;
  readonly durationRestThreshold?: number;
};

/** The spring easing runs on a 30 frame clock; `t` of 0 to 1 is those frames. */
const SPRING_FPS = 30;

// A cubic Bezier through (0,0), (x1,y1), (x2,y2), (1,1) solved for y at a
// given x: a sampled table picks a start, Newton's method refines it while the
// slope allows, bisection otherwise. These constants are the usual ones for
// this kind of solver; they decide the last digits of the result.
const SPLINE_TABLE_SIZE = 11;
const SAMPLE_STEP = 1 / (SPLINE_TABLE_SIZE - 1);
const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 10;

const A = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
const B = (a1: number, a2: number) => 3 * a2 - 6 * a1;
const C = (a1: number) => 3 * a1;
const calcBezier = (t: number, a1: number, a2: number) =>
  ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
const getSlope = (t: number, a1: number, a2: number) =>
  3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);

function binarySubdivide(x: number, lo: number, hi: number, x1: number, x2: number): number {
  let currentX: number;
  let currentT: number;
  let i = 0;
  let a = lo;
  let b = hi;
  do {
    currentT = a + (b - a) / 2;
    currentX = calcBezier(currentT, x1, x2) - x;
    if (currentX > 0) b = currentT;
    else a = currentT;
  } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
  return currentT;
}

function newtonRaphson(x: number, guess: number, x1: number, x2: number): number {
  let t = guess;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = getSlope(t, x1, x2);
    if (slope === 0) return t;
    const currentX = calcBezier(t, x1, x2) - x;
    t -= currentX / slope;
  }
  return t;
}

function bezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) {
    throw new Error('bezier x values must be in [0, 1] range');
  }
  if (x1 === y1 && x2 === y2) return (t) => Math.min(Math.max(t, 0), 1);
  const table = new Float32Array(SPLINE_TABLE_SIZE);
  for (let i = 0; i < SPLINE_TABLE_SIZE; i++) table[i] = calcBezier(i * SAMPLE_STEP, x1, x2);

  const tForX = (x: number): number => {
    let intervalStart = 0;
    let current = 1;
    const last = SPLINE_TABLE_SIZE - 1;
    for (; current !== last && table[current]! <= x; current++) intervalStart += SAMPLE_STEP;
    current--;
    const dist = (x - table[current]!) / (table[current + 1]! - table[current]!);
    const guess = intervalStart + dist * SAMPLE_STEP;
    const slope = getSlope(guess, x1, x2);
    if (slope >= NEWTON_MIN_SLOPE) return newtonRaphson(x, guess, x1, x2);
    if (slope === 0) return guess;
    return binarySubdivide(x, intervalStart, intervalStart + SAMPLE_STEP, x1, x2);
  };

  return (x) => {
    // Outside 0..1 the curve holds its end values, unlike the power easings.
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return calcBezier(tForX(x), y1, y2);
  };
}

export const Easing: {
  step0: EasingFunction;
  step1: EasingFunction;
  linear: EasingFunction;
  ease: EasingFunction;
  quad: EasingFunction;
  cubic: EasingFunction;
  poly: (n: number) => EasingFunction;
  sin: EasingFunction;
  circle: EasingFunction;
  exp: EasingFunction;
  elastic: (bounciness?: number) => EasingFunction;
  back: (s?: number) => EasingFunction;
  spring: (config?: EasingSpringConfig) => EasingFunction;
  bounce: EasingFunction;
  bezier: (x1: number, y1: number, x2: number, y2: number) => EasingFunction;
  in: (easing: EasingFunction) => EasingFunction;
  out: (easing: EasingFunction) => EasingFunction;
  inOut: (easing: EasingFunction) => EasingFunction;
} = {
  // Steps: 0 until the input passes 0 (`step0`) or reaches 1 (`step1`), then 1.
  step0: (t) => (t > 0 ? 1 : 0),
  step1: (t) => (t >= 1 ? 1 : 0),
  linear: (t) => t,
  ease: bezier(0.42, 0, 1, 1),
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  poly: (n) => (t) => Math.pow(t, n),
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  circle: (t) => {
    const u = Math.min(Math.max(t, 0), 1);
    return 1 - Math.sqrt(1 - u * u);
  },
  exp: (t) => Math.pow(2, 10 * (t - 1)),
  elastic:
    (bounciness = 1) =>
    (t) => {
      const p = bounciness * Math.PI;
      return 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p);
    },
  back:
    (s = 1.70158) =>
    (t) =>
      t * t * ((s + 1) * t - s),
  spring: ({ allowTail = false, durationRestThreshold, ...config } = {}) => {
    const curve = (t: number): number => {
      if (t <= 0) return 0;
      if (!allowTail && t >= 1) return 1;
      if (allowTail) {
        // `t` of 1 is where the spring comes to rest; it is not cut off there.
        return spring({ fps: SPRING_FPS, frame: t * measureSpring({ fps: SPRING_FPS, config, threshold: durationRestThreshold }), config });
      }
      return spring({ fps: SPRING_FPS, frame: t * SPRING_FPS, config, durationInFrames: SPRING_FPS, durationRestThreshold });
    };
    return Object.assign(curve, { remotionShouldExtendRight: allowTail });
  },
  bounce: (input) => {
    const t = Math.min(Math.max(input, 0), 1);
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) {
      const u = t - 1.5 / 2.75;
      return 7.5625 * u * u + 0.75;
    }
    if (t < 2.5 / 2.75) {
      const u = t - 2.25 / 2.75;
      return 7.5625 * u * u + 0.9375;
    }
    const u = t - 2.625 / 2.75;
    return 7.5625 * u * u + 0.984375;
  },
  bezier,
  in: (easing) => easing,
  out: (easing) => (t) => 1 - easing(1 - t),
  inOut: (easing) => (t) => (t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2),
};
