// `@remotion/animation-utils`: CSS transform strings and style interpolation.
// Written from the documented behaviour and checked against values recorded
// from the published package (test/fixtures/animation-utils.json), including
// its error messages. The strings these produce are CSS; here they are useful
// to ports that build a `transform` string and to anything that wants to blend
// two style objects.

import { parseColor } from './colors.js';
import { interpolate, type InterpolateOptions } from './interpolate.js';
import { interpolateColors } from './interpolate-colors.js';

type Length = number | string;
type Angle = number | string;

const px = (value: Length) => (typeof value === 'number' ? `${value}px` : value);
const deg = (value: Angle) => (typeof value === 'number' ? `${value}deg` : value);

export function translate(x: Length, y?: Length): string {
  return y === undefined ? `translate(${px(x)})` : `translate(${px(x)}, ${px(y)})`;
}
export const translateX = (x: Length) => `translateX(${px(x)})`;
export const translateY = (y: Length) => `translateY(${px(y)})`;
export const translateZ = (z: Length) => `translateZ(${px(z)})`;
export const translate3d = (x: Length, y: Length, z: Length) => `translate3d(${px(x)}, ${px(y)}, ${px(z)})`;

export const scale = (x: number, y: number = x) => `scale(${x}, ${y})`;
export const scaleX = (x: number) => `scaleX(${x})`;
export const scaleY = (y: number) => `scaleY(${y})`;
export const scaleZ = (z: number) => `scaleZ(${z})`;
export const scale3d = (x: number, y: number, z: number) => `scale3d(${x}, ${y}, ${z})`;

export const rotate = (angle: Angle) => `rotate(${deg(angle)})`;
export const rotateX = (angle: Angle) => `rotateX(${deg(angle)})`;
export const rotateY = (angle: Angle) => `rotateY(${deg(angle)})`;
export const rotateZ = (angle: Angle) => `rotateZ(${deg(angle)})`;
export const rotate3d = (x: number, y: number, z: number, angle: Angle) => `rotate3d(${x}, ${y}, ${z}, ${deg(angle)})`;

export const skew = (x: Angle, y: Angle = x) => `skew(${deg(x)}, ${deg(y)})`;
export const skewX = (x: Angle) => `skewX(${deg(x)})`;
export const skewY = (y: Angle) => `skewY(${deg(y)})`;

export const perspective = (distance: Length) => `perspective(${px(distance)})`;
export const matrix = (a: number, b: number, c: number, d: number, tx: number, ty: number) =>
  `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
export const matrix3d = (...values: number[]) => `matrix3d(${values.join(', ')})`;

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
