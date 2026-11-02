// `@remotion/animation-utils`: CSS transform strings and style interpolation.
// Written from the documented behaviour and checked against values recorded
// from the published package (test/fixtures/animation-utils.json), including
// its error messages. The strings these produce are CSS; here they are useful
// to ports that build a `transform` string and to anything that wants to blend
// two style objects.

import { parseColor } from './colors.js';
import { interpolate, type InterpolateOptions } from './interpolate.js';
import { interpolateColors } from './interpolate-colors.js';

const LENGTH_UNITS = [
  'px', 'em', 'rem', 'pt', 'cap', 'ch', 'ex', 'ic', 'lh', 'rlh', 'vmax', 'vmin', 'vb', 'vi', 'cqw', 'vh', 'vw', 'cqh', 'cqi',
  'cqb', 'cqmin', 'cqmax', 'cm', 'mm', 'Q', 'in', 'pc',
] as const;
const ANGLE_UNITS = ['rad', 'deg', 'grad', 'turn'] as const;
const LENGTH_PERCENTAGE_UNITS = ['%', ...LENGTH_UNITS] as const;

export type LengthUnit = (typeof LENGTH_UNITS)[number];
export type AngleUnit = (typeof ANGLE_UNITS)[number];
export type LengthPercentageUnit = (typeof LENGTH_PERCENTAGE_UNITS)[number];
export type LengthUnitString = `${number}${LengthUnit}`;
export type AngleUnitString = `${number}${AngleUnit}`;
export type LengthPercentageUnitString = `${number}${LengthPercentageUnit}`;

/**
 * True for a string with a value and a unit from `units` (`'10px'`), false for anything that is not a string. A string
 * that does not end in one of the units, or has no value and unit, is an error.
 */
function isUnitString(input: unknown, units: readonly string[]): input is string {
  if (typeof input !== 'string') return false;
  if (!units.some((unit) => input.endsWith(unit))) {
    throw new Error(`input ${input} does not end with a valid unit. Valid units are: ${units.join(', ')}`);
  }
  if (!/([0-9.]+)([a-z%]+)/.test(input)) {
    throw new Error(
      `input ${input} is not a valid transform. Must be a number or a string ending in one of the following units: ${LENGTH_UNITS.join(', ')}`,
    );
  }
  return true;
}

function checkNumber(num: unknown, param: string, api: string): asserts num is number {
  if (typeof num === 'undefined') throw new TypeError(`Argument passed to "${api}" for param "${param}" is undefined`);
  if (typeof num !== 'number') throw new TypeError(`Argument passed to "${api}" for param "${param}" is ${JSON.stringify(num)}`);
  if (!Number.isFinite(num)) {
    throw new TypeError(`Argument passed to "${api}" for param "${param}" is ${JSON.stringify(num)} (must be finite)`);
  }
}

/** A single-value function (`rotate`, `translateX`, ...): a unit string as written, or a number with a unit. */
function withUnit(api: string, param: string, value: unknown, unit: string, units: readonly string[]): string {
  if (isUnitString(value, units)) return `${api}(${value})`;
  checkNumber(value, param, api);
  return `${api}(${value}${unit})`;
}

// Translate

export function translate(x: LengthPercentageUnitString | number): string;
export function translate(x: number, y: number): string;
export function translate(x: LengthPercentageUnitString, y: LengthPercentageUnitString): string;
export function translate(x: number, unit: LengthPercentageUnit): string;
export function translate(x: number, unitX: LengthPercentageUnit, y: number, unitY: LengthPercentageUnit): string;
export function translate(...args: unknown[]): string {
  const [arg1, arg2, arg3, arg4] = args;
  if (args.length === 1) {
    if (isUnitString(arg1, LENGTH_PERCENTAGE_UNITS)) return `translate(${arg1})`;
    checkNumber(arg1, 'x', 'translate');
    return `translate(${arg1}px)`;
  }
  if (args.length === 2) {
    if (typeof arg1 === 'number' && typeof arg2 === 'number') {
      checkNumber(arg1, 'x', 'translate');
      checkNumber(arg2, 'y', 'translate');
      return `translate(${arg1}px, ${arg2}px)`;
    }
    if (isUnitString(arg1, LENGTH_PERCENTAGE_UNITS) && isUnitString(arg2, LENGTH_PERCENTAGE_UNITS)) {
      return `translate(${arg1}, ${arg2})`;
    }
    if (typeof arg1 === 'number' && typeof arg2 !== 'number') {
      checkNumber(arg1, 'x', 'translate');
      return `translate(${arg1}${arg2})`;
    }
  }
  if (args.length === 4 && typeof arg1 === 'number' && typeof arg3 === 'number') {
    checkNumber(arg1, 'x', 'translate');
    checkNumber(arg3, 'y', 'translate');
    return `translate(${arg1}${arg2}, ${arg3}${arg4})`;
  }
  throw new TypeError(
    [
      'translate() supports only the following signatures:',
      'translate(x: LengthPercentageUnitString)',
      'translate(x: number)',
      'translate(x: number, y: number)',
      'translate(translation: number, unit: LengthPercentageUnit)',
      'translate(x: number, unitX: LengthPercentageUnit, y: number, unitY: LengthPercentageUnit): string;',
    ].join('\n'),
  );
}

export function translate3d(
  x: LengthPercentageUnitString | number,
  y: LengthPercentageUnitString | number,
  z: LengthPercentageUnitString | number,
): string;
export function translate3d(
  x: number, unitX: LengthPercentageUnit, y: number, unitY: LengthPercentageUnit, z: number, unitZ: LengthUnit,
): string;
export function translate3d(...args: unknown[]): string {
  if (args.length === 3) {
    const axes = ['x', 'y', 'z'];
    const parts = args.map((arg, i) => {
      if (isUnitString(arg, LENGTH_PERCENTAGE_UNITS)) return arg;
      checkNumber(arg, axes[i]!, 'translate3d');
      return `${arg}px`;
    });
    return `translate3d(${parts.join(', ')})`;
  }
  if (args.length === 6) {
    const [x, unitX, y, unitY, z, unitZ] = args;
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
      checkNumber(x, 'x', 'translate3d');
      checkNumber(y, 'y', 'translate3d');
      checkNumber(z, 'z', 'translate3d');
      return `translate3d(${x}${unitX}, ${y}${unitY}, ${z}${unitZ})`;
    }
  }
  throw new TypeError(
    [
      'translate3d() supports only the following signatures:',
      'translate3d(x: LengthPercentageUnitString, y: LengthPercentageUnitString, z: LengthPercentageUnitString)',
      'translate3d(x: number, unitX: LengthPercentageUnit, y: number, unitY: LengthPercentageUnit, z: number, unitZ: LengthUnit)',
    ].join('\n'),
  );
}

export const translateX = (x: LengthPercentageUnitString | number, unit: LengthPercentageUnit = 'px') =>
  withUnit('translateX', 'x', x, unit, LENGTH_PERCENTAGE_UNITS);
export const translateY = (y: LengthPercentageUnitString | number, unit: LengthPercentageUnit = 'px') =>
  withUnit('translateY', 'y', y, unit, LENGTH_PERCENTAGE_UNITS);
export const translateZ = (z: LengthUnitString | number, unit: LengthUnit = 'px') =>
  withUnit('translateZ', 'z', z, unit, LENGTH_UNITS);

// Scale

export function scale(x: number, y: number = x): string {
  checkNumber(x, 'x', 'scale');
  checkNumber(y, 'y', 'scale');
  return `scale(${x}, ${y})`;
}
export function scaleX(x: number): string {
  checkNumber(x, 'x', 'scaleX');
  return `scaleX(${x})`;
}
export function scaleY(y: number): string {
  checkNumber(y, 'y', 'scaleY');
  return `scaleY(${y})`;
}
export function scaleZ(z: number): string {
  checkNumber(z, 'z', 'scaleZ');
  return `scaleZ(${z})`;
}
export function scale3d(x: number, y: number, z: number): string {
  checkNumber(x, 'x', 'scale3d');
  checkNumber(y, 'y', 'scale3d');
  checkNumber(z, 'z', 'scale3d');
  return `scale3d(${x}, ${y}, ${z})`;
}

// Rotate

export const rotate = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('rotate', 'angle', angle, unit, ANGLE_UNITS);
export const rotateX = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('rotateX', 'angle', angle, unit, ANGLE_UNITS);
export const rotateY = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('rotateY', 'angle', angle, unit, ANGLE_UNITS);
export const rotateZ = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('rotateZ', 'angle', angle, unit, ANGLE_UNITS);

export function rotate3d(x: number, y: number, z: number, angle: AngleUnitString | number, unit: AngleUnit = 'deg'): string {
  checkNumber(x, 'x', 'rotate3d');
  checkNumber(y, 'y', 'rotate3d');
  checkNumber(z, 'z', 'rotate3d');
  if (isUnitString(angle, ANGLE_UNITS)) return `rotate3d(${x}, ${y}, ${z}, ${angle})`;
  checkNumber(angle, 'angle', 'rotate3d');
  return `rotate3d(${x}, ${y}, ${z}, ${angle}${unit})`;
}

// Skew

export function skew(angle: AngleUnitString | number): string;
export function skew(angleX: AngleUnitString, angleY: AngleUnitString): string;
export function skew(angle: number, unit: AngleUnit): string;
export function skew(angleX: number, angleY: number): string;
export function skew(angleX: number, unitX: AngleUnit, angleY: number, unitY: AngleUnit): string;
export function skew(...args: unknown[]): string {
  const [arg1, arg2, arg3, arg4] = args;
  if (args.length === 1) {
    if (isUnitString(arg1, ANGLE_UNITS)) return `skew(${arg1}, ${arg1})`;
    checkNumber(arg1, 'angle', 'skew');
    return `skew(${arg1}deg, ${arg1}deg)`;
  }
  if (args.length === 2) {
    if (isUnitString(arg1, ANGLE_UNITS) && isUnitString(arg2, ANGLE_UNITS)) return `skew(${arg1}, ${arg2})`;
    if (typeof arg1 === 'number' && typeof arg2 !== 'number') {
      checkNumber(arg1, 'angle', 'skew');
      return `skew(${arg1}${arg2}, ${arg1}${arg2})`;
    }
    if (typeof arg1 === 'number' && typeof arg2 === 'number') {
      checkNumber(arg1, 'angle', 'skew');
      checkNumber(arg2, 'angle', 'skew');
      return `skew(${arg1}deg, ${arg2}deg)`;
    }
  }
  // Each axis has its own unit, and the unit comes after its angle.
  if (
    args.length === 4 &&
    typeof arg1 === 'number' &&
    (ANGLE_UNITS as readonly unknown[]).includes(arg2) &&
    typeof arg3 === 'number' &&
    (ANGLE_UNITS as readonly unknown[]).includes(arg4)
  ) {
    checkNumber(arg1, 'angle', 'skew');
    checkNumber(arg3, 'angle', 'skew');
    return `skew(${arg1}${arg2}, ${arg3}${arg4})`;
  }
  throw new TypeError(
    [
      'skew() supports only the following signatures:',
      'skew(angle: AngleUnitString): string;',
      'skew(angle: AngleUnitString, angle2: AngleUnitString): string;',
      'skew(angle: number, unit: AngleUnit): string;',
      'skew(angleX: number, angleY: number): string;',
      'skew(angleX: number, unitX: AngleUnit, angleY: number, unitY: AngleUnit): string;',
    ].join('\n'),
  );
}
export const skewX = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('skewX', 'angle', angle, unit, ANGLE_UNITS);
export const skewY = (angle: AngleUnitString | number, unit: AngleUnit = 'deg') =>
  withUnit('skewY', 'angle', angle, unit, ANGLE_UNITS);

// Perspective and matrices

export const perspective = (length: LengthUnitString | number, unit: LengthUnit = 'px') =>
  withUnit('perspective', 'length', length, unit, LENGTH_UNITS);

export function matrix(a: number, b: number, c: number, d: number, tx: number, ty: number): string {
  const values = { a, b, c, d, tx, ty };
  for (const [name, value] of Object.entries(values)) checkNumber(value, name, 'matrix');
  return `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
}

const MATRIX3D_PARAMS = ['a1', 'b1', 'c1', 'd1', 'a2', 'b2', 'c2', 'd2', 'a3', 'b3', 'c3', 'd3', 'a4', 'b4', 'c4', 'd4'];
export function matrix3d(
  a1: number, b1: number, c1: number, d1: number,
  a2: number, b2: number, c2: number, d2: number,
  a3: number, b3: number, c3: number, d3: number,
  a4: number, b4: number, c4: number, d4: number,
): string {
  const values = [a1, b1, c1, d1, a2, b2, c2, d2, a3, b3, c3, d3, a4, b4, c4, d4];
  values.forEach((value, i) => checkNumber(value, MATRIX3D_PARAMS[i]!, 'matrix3d'));
  return `matrix3d(${values.join(', ')})`;
}

/** Joins transform functions into one `transform` value. */
export function makeTransform(transforms: string[]): string {
  return transforms.join(' ');
}

// ---- interpolateStyles ----

export type Style = Record<string, string | number | undefined>;

interface Quantity {
  value: number;
  unit: string;
}

const QUANTITY = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)([a-zA-Z%]*)\s*$/;

function quantity(text: string | number): Quantity | null {
  if (typeof text === 'number') return { value: text, unit: '' };
  const match = QUANTITY.exec(text);
  return match ? { value: Number(match[1]), unit: match[2]! } : null;
}

const show = (value: string | number) => String(value);

function mixQuantities(
  input: number,
  inputRange: readonly number[],
  values: (string | number)[],
  options: InterpolateOptions | undefined,
): string | number {
  const parsed = values.map((v) => quantity(v));
  if (parsed.some((q) => q === null)) throw new Error('internal: not a quantity');
  const quantities = parsed as Quantity[];
  const unit = quantities[0]!.unit;
  for (let i = 1; i < quantities.length; i++) {
    if (quantities[i]!.unit !== unit) {
      throw new Error(
        `The units of the start and end values must match. Start value: ${show(values[0]!)}, end value: ${show(values[i]!)}`,
      );
    }
  }
  const mixed = interpolate(input, inputRange, quantities.map((q) => q.value), options);
  if (unit === '') return mixed;
  return `${mixed}${unit}`;
}

/** Splits at whitespace that is not inside parentheses. */
function splitTokens(text: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function mixToken(
  input: number,
  inputRange: readonly number[],
  tokens: string[],
  options: InterpolateOptions | undefined,
  start: string,
  end: string,
): string | number {
  if (tokens.every((t) => t === tokens[0])) return tokens[0]!;
  if (tokens.every((t) => quantity(t) !== null)) return mixQuantities(input, inputRange, tokens, options);
  if (tokens.every((t) => parseColor(t) !== null)) return interpolateColors(input, inputRange, tokens);
  throw new Error(`Non-animatable values cannot be interpolated. Start value: ${start}, end value: ${end}`);
}

interface TransformFunction {
  name: string;
  args: string[];
}

function parseTransform(text: string): TransformFunction[] {
  const functions: TransformFunction[] = [];
  for (const match of text.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    functions.push({ name: match[1]!, args: match[2]!.split(',').map((a) => a.trim()) });
  }
  return functions;
}

function mixTransforms(
  input: number,
  inputRange: readonly number[],
  values: string[],
  options: InterpolateOptions | undefined,
): string {
  if (values.every((v) => v === values[0])) return values[0]!;
  const lists = values.map(parseTransform);
  for (let i = 1; i < lists.length; i++) {
    const a = lists[0]!;
    const b = lists[i]!;
    const same = a.length === b.length && a.every((f, k) => f.name === b[k]!.name && f.args.length === b[k]!.args.length);
    if (!same) {
      throw new Error(
        `The start and end values must be of the same type. Start value: ${values[0]}, end value: ${values[i]}`,
      );
    }
  }
  return lists[0]!
    .map((fn, k) => {
      const args = fn.args.map((_, a) => mixQuantities(input, inputRange, lists.map((l) => l[k]!.args[a]!), options));
      return `${fn.name}(${args.join(', ')})`;
    })
    .join(' ');
}

function mixShadow(
  input: number,
  inputRange: readonly number[],
  values: string[],
  options: InterpolateOptions | undefined,
): string {
  const lists = values.map(splitTokens);
  if (lists.some((l) => l.length !== lists[0]!.length)) {
    throw new Error(`The start and end values must be of the same type. Start value: ${values[0]}, end value: ${values[1]}`);
  }
  return lists[0]!
    .map((_, k) => String(mixToken(input, inputRange, lists.map((l) => l[k]!), options, values[0]!, values[values.length - 1]!)))
    .join(' ');
}

/**
 * Blends style objects: numbers, lengths with a unit, colours, `transform`
 * strings (the same functions in the same order) and `boxShadow`. A key a later
 * style lacks keeps its first value.
 */
export function interpolateStyles(
  input: number,
  inputRange: readonly number[],
  outputStylesRange: readonly Style[],
  options?: InterpolateOptions,
): Style {
  if (inputRange.length !== outputStylesRange.length) {
    throw new Error(
      `inputRange (${inputRange.length}) and outputStylesRange (${outputStylesRange.length}) must have the same length`,
    );
  }
  const first = outputStylesRange[0] ?? {};
  const out: Style = {};
  for (const key of Object.keys(first)) {
    const values = outputStylesRange.map((style) => style[key]);
    if (values.some((v) => v === undefined)) {
      out[key] = first[key];
      continue;
    }
    const all = values as (string | number)[];
    if (all.every((v) => typeof v === 'number')) {
      out[key] = interpolate(input, inputRange, all as number[], options);
    } else if (key === 'transform') {
      out[key] = mixTransforms(input, inputRange, all.map(String), options);
    } else if (key === 'boxShadow') {
      out[key] = mixShadow(input, inputRange, all.map(String), options);
    } else {
      const texts = all.map(String);
      out[key] = mixToken(input, inputRange, texts, options, texts[0]!, texts[texts.length - 1]!);
    }
  }
  return out;
}
