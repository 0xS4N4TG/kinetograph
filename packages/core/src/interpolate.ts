// `interpolate`: maps a number through a piecewise-linear range, with an
// optional easing per segment and four extrapolation modes. Written from
// Remotion's documented behaviour; test/fixtures/interpolate.json holds values
// recorded from the published package, including the error messages.

import type { EasingFunction } from './easing.js';

export type ExtrapolateType = 'extend' | 'identity' | 'clamp' | 'wrap';
export interface InterpolateOptions {
  easing?: (t: number) => number;
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
}

const linear: EasingFunction = (t) => t;

function interpolateSegment(
  input: number,
  inputRange: readonly [number, number],
  outputRange: readonly [number, number],
  easing: EasingFunction,
  extrapolateLeft: ExtrapolateType,
  extrapolateRight: ExtrapolateType,
): number {
  let result = input;
  const [inputMin, inputMax] = inputRange;
  const [outputMin, outputMax] = outputRange;

  if (result < inputMin) {
    if (extrapolateLeft === 'identity') return result;
    if (extrapolateLeft === 'clamp') {
      result = inputMin;
    } else if (extrapolateLeft === 'wrap') {
      const range = inputMax - inputMin;
      result = ((((result - inputMin) % range) + range) % range) + inputMin;
    } else if (extrapolateLeft !== 'extend') {
      throw new Error(`Invalid extrapolate left option "${String(extrapolateLeft)}"`);
    }
  }
  if (result > inputMax) {
    if (extrapolateRight === 'identity') return result;
    if (extrapolateRight === 'clamp') {
      result = inputMax;
    } else if (extrapolateRight === 'wrap') {
      const range = inputMax - inputMin;
      result = (((result - inputMin) % range) + range) % range + inputMin;
    } else if (extrapolateRight !== 'extend') {
      throw new Error(`Invalid extrapolate right option "${String(extrapolateRight)}"`);
    }
  }

  if (outputMin === outputMax) return outputMin;

  result = (result - inputMin) / (inputMax - inputMin);
  result = easing(result);
  return result * (outputMax - outputMin) + outputMin;
}

// The segment `input` falls in: the first one whose upper end is at or above it, the last for anything beyond.
function findSegment(input: number, inputRange: readonly number[]): number {
  let i: number;
  for (i = 1; i < inputRange.length - 1; ++i) {
    if (inputRange[i]! >= input) break;
  }
  return i - 1;
}

function checkRange(name: string, range: readonly number[]): void {
  if (range.length < 1) throw new Error(`${name} must have at least 1 element`);
  for (const value of range) {
    if (typeof value !== 'number') {
      throw new Error(`${name} must contain only numbers, but got ${JSON.stringify(range)}`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must contain only finite numbers, but got [${range.join(',')}]`);
    }
  }
}

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: InterpolateOptions,
): number {
  if (typeof input === 'undefined') throw new Error('input can not be undefined');
  if (typeof inputRange === 'undefined') throw new Error('inputRange can not be undefined');
  if (typeof outputRange === 'undefined') throw new Error('outputRange can not be undefined');
  if (inputRange.length !== outputRange.length) {
    throw new Error(
      `inputRange (${inputRange?.length}) and outputRange (${outputRange?.length}) must have the same length`,
    );
  }
  checkRange('inputRange', inputRange);
  checkRange('outputRange', outputRange);
  for (let i = 1; i < inputRange.length; i++) {
    if (!(inputRange[i]! > inputRange[i - 1]!)) {
      throw new Error(
        `inputRange must be strictly monotonically increasing but got [${inputRange.join(',')}]`,
      );
    }
  }
  if (typeof input !== 'number') throw new TypeError('Cannot interpolate an input which is not a number');

  if (inputRange.length === 1) return outputRange[0]!;
  const segment = findSegment(input, inputRange);
  return interpolateSegment(
    input,
    [inputRange[segment]!, inputRange[segment + 1]!],
    [outputRange[segment]!, outputRange[segment + 1]!],
    options?.easing ?? linear,
    options?.extrapolateLeft ?? 'extend',
    options?.extrapolateRight ?? 'extend',
  );
}
