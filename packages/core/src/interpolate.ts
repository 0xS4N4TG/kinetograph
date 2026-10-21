// `interpolate`: maps a number through a piecewise-linear range, with an optional easing per segment and four
// extrapolation modes. The output range can be numbers, numeric tuples, CSS scale/translate/rotate/transform-origin
// strings, font weights, or (stepped by `Easing.step1`) any other string or boolean. Written from Remotion's
// documented behaviour; test/fixtures/interpolate*.json hold values recorded from the published package, including the
// error messages.

import { Easing, type EasingFunction } from './easing.js';

export type { EasingFunction };
export type ExtrapolateType = 'extend' | 'identity' | 'clamp' | 'wrap';
/** `perceptual-scale` interpolates the area of a scale (its square), so a zoom looks even in speed. */
export type InterpolateOutputOption = 'linear' | 'perceptual-scale';
/** Says what a string output range is, when its values alone do not (and rejects the ones that are another kind). */
export type InterpolateOutputType = 'font-weight' | 'scale' | 'translate' | 'rotate' | 'transform-origin';
export interface InterpolateOptions {
  /** One easing for every segment, or one per segment between the keyframes. */
  easing?: EasingFunction | readonly EasingFunction[];
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
  /** Holds the input at the last multiple of this below it, so the output steps (a value drawn "on twos"). */
  posterize?: number;
  output?: InterpolateOutputOption;
  outputType?: InterpolateOutputType;
}

type NumericTuple = readonly [number, ...number[]];
type OutputValue = number | string | boolean | readonly number[];
type WidenNumericTuple<T extends readonly number[]> = { readonly [Key in keyof T]: number };

const linear: EasingFunction = (t) => t;

// ---- numbers ----

const signedArea = (scale: number): number => (scale === 0 ? 0 : Math.sign(scale) * scale * scale);
const fromSignedArea = (area: number): number => (area === 0 ? 0 : Math.sign(area) * Math.sqrt(Math.abs(area)));

function interpolateSegment(
  input: number,
  inputRange: readonly [number, number],
  outputRange: readonly [number, number],
  easing: EasingFunction,
  extrapolateLeft: ExtrapolateType,
  extrapolateRight: ExtrapolateType,
  output: InterpolateOutputOption,
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
  if (output === 'perceptual-scale') {
    const areaMin = signedArea(outputMin);
    return fromSignedArea(result * (signedArea(outputMax) - areaMin) + areaMin);
  }
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

const easingOf = (easing: InterpolateOptions['easing'], segment: number): EasingFunction =>
  easing === undefined ? linear : typeof easing === 'function' ? easing : easing[segment]!;

/** An easing whose curve goes on past 1 (`Easing.spring({ allowTail: true })`): the value keeps moving after its segment. */
const extendsRight = (easing: EasingFunction): boolean => easing.remotionShouldExtendRight === true;

const heldInput = (input: number, posterize: number | undefined): number =>
  posterize === undefined ? input : Math.floor(input / posterize) * posterize;

function interpolateNumber(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolateOptions | undefined,
): number {
  if (inputRange.length === 1) return outputRange[0]!;
  const output = options?.output ?? 'linear';
  const left = options?.extrapolateLeft ?? 'extend';
  const right = options?.extrapolateRight ?? 'extend';
  const held = heldInput(input, options?.posterize);
  const segment = findSegment(held, inputRange);
  const segmentValue = (index: number, extrapolateRight: ExtrapolateType): number => {
    const easing = easingOf(options?.easing, index);
    // A clamp would cut off the tail of an easing that runs on past its end.
    const rightHere = held > inputRange[index + 1]! && extrapolateRight === 'clamp' && extendsRight(easing) ? 'extend' : extrapolateRight;
    return interpolateSegment(
      held,
      [inputRange[index]!, inputRange[index + 1]!],
      [outputRange[index]!, outputRange[index + 1]!],
      easing,
      left,
      rightHere,
      output,
    );
  };
  let result = segmentValue(segment, right);
  // The tails of the earlier segments' easings that run on past their ends add what they are still away from rest.
  for (let earlier = 0; earlier < segment; earlier++) {
    if (!extendsRight(easingOf(options?.easing, earlier)) || held <= inputRange[earlier + 1]!) continue;
    result += segmentValue(earlier, 'extend') - outputRange[earlier + 1]!;
  }
  return result;
}

function interpolateTuple(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly (readonly number[])[],
  options: InterpolateOptions | undefined,
): number[] {
  const dimensions = outputRange[0]?.length;
  if (dimensions === undefined) throw new Error('outputRange must have at least 1 element');
  if (dimensions === 0) throw new TypeError('outputRange tuples must contain at least 1 number');
  for (const tuple of outputRange) {
    if (tuple.length !== dimensions) {
      throw new TypeError(`outputRange tuples must all have the same length, but got ${dimensions} and ${tuple.length}`);
    }
    for (const value of tuple) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`outputRange tuples must contain only finite numbers, but got [${tuple.join(',')}]`);
      }
    }
  }
  return Array.from({ length: dimensions }, (_, axis) =>
    interpolateNumber(input, inputRange, outputRange.map((tuple) => tuple[axis]!), options),
  );
}

// ---- strings: CSS scale, translate, rotate and transform-origin values ----

type Kind = 'scale' | 'translate' | 'rotate';
type Unit = string | null;

/** A parsed string: up to four numbers (an axis rotation is x, y, z and the angle) and their units. */
interface Parsed {
  kind: Kind;
  values: [number, number, number, number];
  units: [Unit, Unit, Unit, Unit];
  /** How many of the values the string had (and the result has). */
  dimensions: number;
  axisRotation: boolean;
}

const CSS_NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]+)?$/;
const ANGLE_UNITS = new Set(['deg', 'rad', 'grad', 'turn']);
const LENGTH_UNITS = new Set([
  '%', 'cap', 'ch', 'cm', 'cqb', 'cqh', 'cqi', 'cqmax', 'cqmin', 'cqw', 'dvh', 'dvw', 'em', 'ex', 'ic', 'in', 'lh', 'lvh',
  'lvw', 'mm', 'pc', 'pt', 'px', 'q', 'rem', 'rlh', 'svh', 'svw', 'vb', 'vh', 'vi', 'vmax', 'vmin', 'vw',
]);
const ORIGIN_KEYWORDS = new Set(['left', 'center', 'right', 'top', 'bottom']);

/** A string that is not a scale, translate or rotate value at all: it can still be stepped through. */
class UnsupportedStringInterpolationValueError extends TypeError {}

const roundTo6 = (value: number): string => String(Math.round(value * 1e6) / 1e6);

interface Component {
  kind: Kind;
  value: number;
  unit: Unit;
}

function parseComponent(component: string, whole: string): Component {
  const match = CSS_NUMBER.exec(component);
  if (match === null) {
    throw new UnsupportedStringInterpolationValueError(`Cannot interpolate "${whole}" because "${component}" is not a supported scale, translate, or rotate value`);
  }
  const unit = match[2] ?? null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new TypeError(`Cannot interpolate "${whole}" because "${component}" is not finite`);
  if (unit === null) return { kind: 'scale', value, unit };
  if (ANGLE_UNITS.has(unit)) return { kind: 'rotate', value, unit };
  if (LENGTH_UNITS.has(unit)) return { kind: 'translate', value, unit };
  throw new TypeError(`Cannot interpolate "${whole}" because "${unit}" is not a supported translate or rotate unit`);
}

interface Length {
  value: number;
  unit: string;
}

const CENTER: Length = { value: 50, unit: '%' };

function parseOriginLength(component: string, whole: string, allowPercentage: boolean): Length {
  const bad = `Cannot interpolate "${whole}" because "${component}" is not a supported transform-origin ${allowPercentage ? 'length-percentage' : 'z length'}`;
  const match = CSS_NUMBER.exec(component);
  if (match === null) throw new TypeError(bad);
  const unit = match[2] ?? null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new TypeError(`Cannot interpolate "${whole}" because "${component}" is not finite`);
  if (unit === null || !LENGTH_UNITS.has(unit) || (!allowPercentage && unit === '%')) throw new TypeError(bad);
  return { value, unit };
}

/** What a keyword says about each axis. `center` could be either, so it lists both. */
function keywordPlaces(keyword: string): { axis: 'x' | 'y'; value: Length }[] {
  switch (keyword) {
    case 'left': return [{ axis: 'x', value: { value: 0, unit: '%' } }];
    case 'right': return [{ axis: 'x', value: { value: 100, unit: '%' } }];
    case 'top': return [{ axis: 'y', value: { value: 0, unit: '%' } }];
    case 'bottom': return [{ axis: 'y', value: { value: 100, unit: '%' } }];
    default: return [{ axis: 'x', value: CENTER }, { axis: 'y', value: CENTER }];
  }
}

type OriginToken = { keyword: string } | { length: Length };

function originToken(component: string, whole: string): OriginToken {
  const lower = component.toLowerCase();
  return ORIGIN_KEYWORDS.has(lower) ? { keyword: lower } : { length: parseOriginLength(component, whole, true) };
}

/** The x and y of the first one or two components of a transform-origin. */
function originXY(parts: string[], whole: string): [Length, Length] {
  if (parts.length === 1) {
    const token = originToken(parts[0]!, whole);
    if ('length' in token) return [token.length, CENTER];
    const place = keywordPlaces(token.keyword)[0]!;
    return token.keyword === 'top' || token.keyword === 'bottom' ? [CENTER, place.value] : [place.value, CENTER];
  }
  const first = originToken(parts[0]!, whole);
  const second = originToken(parts[1]!, whole);
  if ('length' in first && 'length' in second) return [first.length, second.length];
  if ('keyword' in first && 'keyword' in second) {
    for (const a of keywordPlaces(first.keyword)) {
      for (const b of keywordPlaces(second.keyword)) {
        if (a.axis !== b.axis) return a.axis === 'x' ? [a.value, b.value] : [b.value, a.value];
      }
    }
    throw new TypeError(`Cannot interpolate "${whole}" because "${first.keyword} ${second.keyword}" is not a valid transform-origin keyword pair`);
  }
  const keywordFirst = 'keyword' in first;
  const keyword = ('keyword' in first ? first : second) as { keyword: string };
  const length = ('length' in first ? first : second) as { length: Length };
  if (keyword.keyword === 'left' || keyword.keyword === 'right') {
    if (!keywordFirst) {
      throw new TypeError(`Cannot interpolate "${whole}" because horizontal transform-origin keywords must come before a length-percentage value`);
    }
    return [keywordPlaces(keyword.keyword)[0]!.value, length.length];
  }
  if (keyword.keyword === 'top' || keyword.keyword === 'bottom') return [length.length, keywordPlaces(keyword.keyword)[0]!.value];
  return keywordFirst ? [CENTER, length.length] : [length.length, CENTER];
}

function parseOrigin(whole: string, parts: string[]): Parsed {
  const [x, y] = originXY(parts.slice(0, 2), whole);
  const z = parts[2] === undefined ? { value: 0, unit: null } : parseOriginLength(parts[2], whole, false);
  return {
    kind: 'translate',
    values: [x.value, y.value, z.value, 0],
    units: [x.unit, y.unit, z.unit, null],
    dimensions: parts[2] === undefined ? 2 : 3,
    axisRotation: false,
  };
}

/** `x 45deg`, `y 1turn`, `z …` or `1 0 0 45deg`: a rotation around an axis. Null when it is not one. */
function parseAxisRotation(whole: string): Parsed | null {
  const parts = whole.trim().split(/\s+/);
  const named = parts.length === 2 ? parts[0]!.toLowerCase() : null;
  let axis: number[];
  let angle: Component;
  if (named === 'x' || named === 'y' || named === 'z') {
    angle = parseComponent(parts[1]!, whole);
    axis = named === 'x' ? [1, 0, 0] : named === 'y' ? [0, 1, 0] : [0, 0, 1];
  } else if (parts.length === 4) {
    axis = parts.slice(0, 3).map(Number);
    if (!axis.every(Number.isFinite)) return null;
    angle = parseComponent(parts[3]!, whole);
  } else {
    return null;
  }
  if (angle.kind !== 'rotate') return null;
  return {
    kind: 'rotate',
    values: [axis[0]!, axis[1]!, axis[2]!, angle.value],
    units: [null, null, null, angle.unit],
    dimensions: 4,
    axisRotation: true,
  };
}

function parseString(whole: string | number, outputType: InterpolateOutputType | undefined): Parsed {
  if (typeof whole === 'number') {
    if (!Number.isFinite(whole)) throw new Error(`outputRange must contain only finite numbers, but got [${whole}]`);
    return { kind: 'scale', values: [whole, whole, 1, 0], units: [null, null, null, null], dimensions: 1, axisRotation: false };
  }
  const parts = whole.trim().split(/\s+/);
  const count = (): void => {
    if (parts.length < 1 || parts.length > 3 || parts[0] === '') {
      throw new TypeError(`String outputRange values must contain 1 to 3 components, but got "${whole}"`);
    }
  };
  if (outputType === 'transform-origin') {
    count();
    return parseOrigin(whole, parts);
  }
  const axis = parseAxisRotation(whole);
  if (axis !== null) {
    if (outputType !== undefined && outputType !== 'rotate') {
      throw new TypeError(`Cannot interpolate "${whole}" as ${outputType} because it is a rotate value`);
    }
    return axis;
  }
  count();
  if (parts.some((part) => ORIGIN_KEYWORDS.has(part.toLowerCase()))) {
    if (outputType !== undefined) {
      throw new TypeError(`Cannot interpolate "${whole}" as ${outputType} because it is a transform-origin value`);
    }
    return parseOrigin(whole, parts);
  }
  const parsed = parts.map((part) => parseComponent(part, whole));
  const kind = parsed[0]!.kind;
  for (const part of parsed) {
    if (part.kind !== kind) throw new TypeError(`Cannot interpolate "${whole}" because it mixes ${kind} and ${part.kind} values`);
  }
  if (outputType !== undefined && outputType !== kind) {
    throw new TypeError(`Cannot interpolate "${whole}" as ${outputType} because it is a ${kind} value`);
  }
  if (kind === 'scale') {
    const x = parsed[0]!.value;
    return { kind, values: [x, parsed[1]?.value ?? x, parsed[2]?.value ?? 1, 0], units: [null, null, null, null], dimensions: parsed.length, axisRotation: false };
  }
  return {
    kind,
    values: [parsed[0]!.value, parsed[1]?.value ?? 0, parsed[2]?.value ?? 0, 0],
    units: [parsed[0]!.unit, parsed[1]?.unit ?? null, parsed[2]?.unit ?? null, null],
    dimensions: parsed.length,
    axisRotation: false,
  };
}

function writeString(kind: Kind, values: number[], units: Unit[], dimensions: number, axisRotation: boolean): string {
  if (axisRotation) return `${roundTo6(values[0]!)} ${roundTo6(values[1]!)} ${roundTo6(values[2]!)} ${roundTo6(values[3]!)}${units[3]}`;
  if (kind === 'scale') return values.slice(0, dimensions).map(roundTo6).join(' ');
  return values.slice(0, dimensions).map((value, axis) => `${roundTo6(value)}${units[axis]}`).join(' ');
}

function interpolateString(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly (string | number)[],
  options: InterpolateOptions | undefined,
): string {
  const parsed = outputRange.map((output) => parseString(output, options?.outputType));
  const hasAxisRotation = parsed.some((p) => p.axisRotation);
  const segment = inputRange.length === 1 ? 0 : findSegment(heldInput(input, options?.posterize), inputRange);
  // With an axis rotation in the range, a plain angle is a rotation around some axis too: the z axis, or, for a zero
  // angle (which is the same turn about any axis), the axis of the neighbour it is moving to or from, so the axis does
  // not swing as the angle leaves zero.
  const ranged = hasAxisRotation
    ? parsed.map((p, index): Parsed => {
        if (p.kind !== 'rotate' || p.axisRotation) return p;
        if (p.dimensions !== 1) throw new TypeError('Cannot interpolate a multi-angle rotate value with an axis rotation');
        let neighbour: Parsed | undefined;
        if (p.values[0] === 0) {
          if (index === 0) neighbour = parsed.find((c) => c.axisRotation);
          else if (index === parsed.length - 1) neighbour = [...parsed].reverse().find((c) => c.axisRotation);
          else if (index === segment) neighbour = parsed[index + 1];
          else if (index === segment + 1) neighbour = parsed[index - 1];
        }
        const axis = neighbour?.axisRotation ? neighbour.values : [0, 0, 1];
        return { kind: 'rotate', values: [axis[0]!, axis[1]!, axis[2]!, p.values[0]], units: [null, null, null, p.units[0]], dimensions: 4, axisRotation: true };
      })
    : parsed;

  const kind = ranged[0]!.kind;
  for (const p of ranged) {
    if (p.kind !== kind) throw new TypeError(`Cannot interpolate ${kind} values with ${p.kind} values`);
  }
  const dimensions = Math.max(...ranged.map((p) => p.dimensions));
  // One unit per axis, the same in every value that has one.
  const units: Unit[] = [null, null, null, null];
  if (kind !== 'scale') {
    for (let axis = 0; axis < dimensions; axis++) {
      if (hasAxisRotation && axis < 3) continue;
      for (const p of ranged) {
        const unit = p.units[axis]!;
        if (unit === null) continue;
        if (units[axis] === null) units[axis] = unit;
        else if (units[axis] !== unit) {
          throw new TypeError(`Cannot interpolate ${kind} values with different units on axis ${axis + 1}: ${units[axis]} and ${unit}`);
        }
      }
      if (units[axis] === null) throw new TypeError(`Cannot interpolate ${kind} values because axis ${axis + 1} has no unit`);
    }
  }
  const values = [0, 0, 0, 0];
  for (let axis = 0; axis < dimensions; axis++) {
    values[axis] = interpolateNumber(input, inputRange, ranged.map((p) => p.values[axis]!), options);
  }
  return writeString(kind, values, units, dimensions, hasAxisRotation);
}

function interpolateFontWeight(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly (string | number)[],
  options: InterpolateOptions | undefined,
): number {
  const weights = outputRange.map((output) => {
    if (typeof output === 'string') {
      const lower = output.toLowerCase();
      if (lower === 'normal') return 400;
      if (lower === 'bold') return 700;
    }
    const match = typeof output === 'string' ? CSS_NUMBER.exec(output) : null;
    const value = typeof output === 'number' ? output : match !== null && match[2] === undefined ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(value) || value < 1 || value > 1000) {
      throw new TypeError(`Cannot interpolate font weight "${output}". Expected "normal", "bold", or a number between 1 and 1000`);
    }
    return value;
  });
  return interpolateNumber(input, inputRange, weights, options);
}

// ---- values that cannot be blended: stepped ----

/** Steps through `outputRange`: each value holds until the input reaches the next keyframe (`Easing.step1` on every segment). */
function interpolateDiscrete<T extends string | boolean>(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly T[],
  options: InterpolateOptions | undefined,
): T {
  if (inputRange.length === 1) return outputRange[0]!;
  const what = typeof outputRange[0] === 'boolean' ? 'Booleans' : 'Non-numeric strings';
  for (let segment = 0; segment < inputRange.length - 1; segment++) {
    if (easingOf(options?.easing, segment) !== Easing.step1) throw new TypeError(`${what} can only be interpolated using Easing.step1`);
  }
  const noIdentity = typeof outputRange[0] === 'boolean' ? 'booleans' : 'non-numeric strings';
  const first = inputRange[0]!;
  const last = inputRange[inputRange.length - 1]!;
  let held = heldInput(input, options?.posterize);
  if (held < first) {
    if (options?.extrapolateLeft === 'identity') throw new TypeError(`extrapolateLeft: "identity" is not supported for ${noIdentity}`);
    if (options?.extrapolateLeft !== 'wrap') return outputRange[0]!;
    held = ((((held - first) % (last - first)) + (last - first)) % (last - first)) + first;
  }
  if (held > last) {
    if (options?.extrapolateRight === 'identity') throw new TypeError(`extrapolateRight: "identity" is not supported for ${noIdentity}`);
    if (options?.extrapolateRight !== 'wrap') return outputRange[outputRange.length - 1]!;
    held = ((((held - first) % (last - first)) + (last - first)) % (last - first)) + first;
  }
  const segment = findSegment(held, inputRange);
  return held >= inputRange[segment + 1]! ? outputRange[segment + 1]! : outputRange[segment]!;
}

// ---- validation ----

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

/** Throws unless `easing` is a function, or one function per segment of an input range of `inputRangeLength` keyframes. */
export function assertValidInterpolateEasingOption(
  easing: EasingFunction | readonly EasingFunction[] | undefined,
  inputRangeLength: number,
): void {
  if (easing === undefined || typeof easing === 'function') return;
  const expectedLength = inputRangeLength - 1;
  if (easing.length !== expectedLength) {
    throw new Error(
      `When easing is an array, it must have one entry per segment between keyframes (length inputRange.length - 1 = ${expectedLength}), but got length ${easing.length}`,
    );
  }
  easing.forEach((entry, i) => {
    if (typeof entry !== 'function') throw new Error(`easing[${i}] must be a function`);
  });
}

/** Throws unless `posterize` is left out or a positive, finite number. */
export function assertValidInterpolatePosterizeOption(posterize: number | undefined): void {
  if (posterize === undefined) return;
  if (typeof posterize !== 'number' || !Number.isFinite(posterize) || posterize <= 0) {
    throw new Error(`posterize must be a positive finite number, but got ${posterize}`);
  }
}

const OUTPUT_TYPES = ['font-weight', 'scale', 'translate', 'rotate', 'transform-origin'];

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: InterpolateOptions,
): number;
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly (number | string)[],
  options: InterpolateOptions & { outputType: 'font-weight' },
): number;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly string[], options?: InterpolateOptions): string;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly boolean[], options?: InterpolateOptions): boolean;
export function interpolate<const Tuple extends NumericTuple>(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly Tuple[],
  options?: InterpolateOptions,
): WidenNumericTuple<Tuple>;
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly (readonly number[])[], options?: InterpolateOptions): number[];
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly OutputValue[],
  options?: InterpolateOptions,
): OutputValue;
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly OutputValue[],
  options?: InterpolateOptions,
): OutputValue {
  if (typeof input === 'undefined') throw new Error('input can not be undefined');
  if (typeof inputRange === 'undefined') throw new Error('inputRange can not be undefined');
  if (typeof outputRange === 'undefined') throw new Error('outputRange can not be undefined');
  if (inputRange.length !== outputRange.length) {
    throw new Error(
      `inputRange (${inputRange?.length}) and outputRange (${outputRange?.length}) must have the same length`,
    );
  }
  checkRange('inputRange', inputRange);
  const allNumbers = Array.isArray(outputRange) && outputRange.every((value) => typeof value === 'number');
  if (allNumbers) checkRange('outputRange', outputRange as readonly number[]);
  for (let i = 1; i < inputRange.length; i++) {
    if (!(inputRange[i]! > inputRange[i - 1]!)) {
      throw new Error(
        `inputRange must be strictly monotonically increasing but got [${inputRange.join(',')}]`,
      );
    }
  }
  assertValidInterpolateEasingOption(options?.easing, inputRange.length);
  assertValidInterpolatePosterizeOption(options?.posterize);
  if (options?.output !== undefined && options.output !== 'linear' && options.output !== 'perceptual-scale') {
    throw new Error(`output must be "linear" or "perceptual-scale", but got ${String(options.output)}`);
  }
  if (options?.outputType !== undefined && !OUTPUT_TYPES.includes(options.outputType)) {
    throw new Error(
      `outputType must be "font-weight", "scale", "translate", "rotate", or "transform-origin", but got ${String(options.outputType)}`,
    );
  }
  if (typeof input !== 'number') throw new TypeError('Cannot interpolate an input which is not a number');
  if (!Array.isArray(outputRange)) throw new Error('outputRange must contain only numbers');

  const outputType = options?.outputType;
  if (outputRange.some((value) => typeof value === 'boolean')) {
    if (!outputRange.every((value) => typeof value === 'boolean')) throw new TypeError('Boolean outputRange must contain only booleans');
    if (outputType !== undefined) throw new TypeError('Boolean outputRange cannot use outputType');
    return interpolateDiscrete(input, inputRange, outputRange as readonly boolean[], options);
  }
  if (outputType === 'font-weight') {
    if (!outputRange.every((value) => typeof value === 'number' || typeof value === 'string')) {
      throw new TypeError('Font weight outputRange must contain only numbers or strings');
    }
    return interpolateFontWeight(input, inputRange, outputRange as readonly (string | number)[], options);
  }
  const hasString = outputRange.some((value) => typeof value === 'string');
  if (outputType !== undefined && outputType !== 'scale' && !hasString) {
    throw new TypeError(`${outputType} outputRange must contain strings with the appropriate CSS units`);
  }
  if (hasString) {
    if (!outputRange.every((value) => typeof value === 'string' || typeof value === 'number')) {
      throw new TypeError('outputRange must contain only numbers, or supported scale, translate, and rotate strings');
    }
    const mixed = outputRange as readonly (string | number)[];
    try {
      return interpolateString(input, inputRange, mixed, options);
    } catch (error) {
      if (!mixed.every((value) => typeof value === 'string')) throw error;
      // Strings that are not numbers with units at all (a word, a colour) can only be stepped through.
      const notNumeric = mixed.some((value) => {
        try {
          parseString(value, outputType);
          return false;
        } catch (parseError) {
          return parseError instanceof UnsupportedStringInterpolationValueError;
        }
      });
      if (!notNumeric) throw error;
      return interpolateDiscrete(input, inputRange, mixed as readonly string[], options);
    }
  }
  if (outputRange.every((value) => Array.isArray(value))) {
    return interpolateTuple(input, inputRange, outputRange as readonly (readonly number[])[], options);
  }
  if (!allNumbers) {
    throw new TypeError('outputRange must contain only numbers, numeric tuples, or supported scale, translate, and rotate strings');
  }
  return interpolateNumber(input, inputRange, outputRange as readonly number[], options);
}
