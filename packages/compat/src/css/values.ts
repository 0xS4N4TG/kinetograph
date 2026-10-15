// Numbers, lengths, angles, positions and the 1-to-4-value side expansion shared by the property parsers.

import type { Length, LengthContext, Sides } from './types.js';
import { type Tok, fail, isLengthLike, lex } from './tokens.js';

/** Absolute units, in px (CSS Values: 1in = 96px). */
const ABSOLUTE_PX = new Map<string, number>([
  ['px', 1], ['in', 96], ['cm', 96 / 2.54], ['mm', 96 / 25.4], ['q', 96 / 101.6], ['pt', 96 / 72], ['pc', 16],
]);
const VIEWPORT_UNITS = new Map<string, 'vw' | 'vh'>([
  ['vw', 'vw'], ['svw', 'vw'], ['lvw', 'vw'], ['dvw', 'vw'],
  ['vh', 'vh'], ['svh', 'vh'], ['lvh', 'vh'], ['dvh', 'vh'],
]);
const ANGLE_UNITS = new Set(['deg', 'rad', 'grad', 'turn']);

export interface LengthRules {
  /** Percentages allowed (default true). */
  percent?: boolean;
  /** Negative values allowed (default true). */
  negative?: boolean;
  /** A bare number is px, as SVG presentation properties take (default: only `0`). */
  unitless?: boolean;
}

/** A length token as a `Length`: `px`, `%`, `em`, `rem`, `vw`, `vh`; absolute units are converted to px. */
export function lengthOf(t: Tok | undefined, rules: LengthRules = {}): Length {
  const { percent = true, negative = true, unitless = false } = rules;
  if (!t) return fail('expected a length');
  let out: Length;
  if (t.type === 'number') {
    if (t.value !== 0 && !unitless) return fail(`\`${t.text}\` needs a unit`);
    out = { unit: 'px', value: t.value };
  } else if (t.type === 'percent') {
    if (!percent) return fail('a percentage is not allowed here');
    out = { unit: '%', value: t.value };
  } else if (t.type === 'dimension') {
    const unit = t.unit;
    const abs = ABSOLUTE_PX.get(unit);
    const vp = VIEWPORT_UNITS.get(unit);
    if (abs !== undefined) out = { unit: 'px', value: t.value * abs };
    else if (unit === 'em' || unit === 'rem') out = { unit, value: t.value };
    else if (vp !== undefined) out = { unit: vp, value: t.value };
    else if (ANGLE_UNITS.has(unit) || unit === 's' || unit === 'ms') return fail(`\`${t.text}\` is not a length`);
    else return fail(`the unit \`${unit}\` is not supported`);
  } else {
    return fail(`expected a length, found \`${t.text}\``);
  }
  if (!negative && out.value < 0) return fail(`\`${t.text}\` must not be negative`);
  return out;
}

/** An angle token in degrees; a bare `0` is allowed. */
export function angleOf(t: Tok | undefined): number {
  if (!t) return fail('expected an angle');
  if (t.type === 'number' && t.value === 0) return 0;
  if (t.type === 'dimension') {
    switch (t.unit) {
      case 'deg': return t.value;
      case 'grad': return t.value * 0.9;
      case 'rad': return (t.value * 180) / Math.PI;
      case 'turn': return t.value * 360;
    }
  }
  return fail(`expected an angle, found \`${t.text}\``);
}

export const isAngle = (t: Tok | undefined): boolean =>
  t !== undefined && ((t.type === 'dimension' && ANGLE_UNITS.has(t.unit)) || (t.type === 'number' && t.value === 0));

/** A plain number token. */
export function numberOf(t: Tok | undefined, what = 'a number'): number {
  if (!t || t.type !== 'number') return fail(`expected ${what}${t ? `, found \`${t.text}\`` : ''}`);
  return t.value;
}

/** A number or a percentage (`50%` is 0.5). */
export function numberOrPercent(t: Tok | undefined): number {
  if (t && t.type === 'percent') return t.value / 100;
  if (t && t.type === 'number') return t.value;
  return fail(`expected a number or percentage${t ? `, found \`${t.text}\`` : ''}`);
}

export function integerOf(t: Tok | undefined): number {
  if (!t || t.type !== 'number' || !t.int) return fail(`expected an integer${t ? `, found \`${t.text}\`` : ''}`);
  return t.value;
}

const HORIZONTAL = new Map<string, number>([['left', 0], ['center', 50], ['right', 100]]);
const VERTICAL = new Map<string, number>([['top', 0], ['center', 50], ['bottom', 100]]);
const pct = (value: number): Length => ({ unit: '%', value });

/**
 * One or two position values (`<position>` without edge offsets): `left`, `top 20%`, `center`, `10px 30%`, ….
 * Three- and four-value forms (`right 10px bottom 20px`) need `calc()` and are not supported.
 */
export function positionOf(toks: Tok[]): [Length, Length] {
  if (toks.length === 0) return fail('expected a position');
  if (toks.length > 2) return fail('edge-offset positions (three or four values) are not supported');
  const [a, b] = toks as [Tok, Tok | undefined];
  const h = (t: Tok): number | undefined => (t.type === 'ident' ? HORIZONTAL.get(t.name) : undefined);
  const v = (t: Tok): number | undefined => (t.type === 'ident' ? VERTICAL.get(t.name) : undefined);
  for (const t of b ? [a, b] : [a]) {
    if (t.type === 'ident' && h(t) === undefined && v(t) === undefined) fail(`\`${t.text}\` is not a position keyword`);
  }
  const bad = (): never => fail(`\`${toks.map((t) => t.text).join(' ')}\` is not a valid position`);
  if (!b) {
    if (a.type !== 'ident') return [lengthOf(a), pct(50)];
    if (a.name === 'center') return [pct(50), pct(50)];
    const x = h(a);
    return x !== undefined ? [pct(x), pct(50)] : [pct(50), pct(v(a)!)];
  }
  const aKw = a.type === 'ident';
  const bKw = b.type === 'ident';
  if (aKw && bKw) {
    // `top left` is `left top`: a vertical keyword first, or a horizontal one second, swaps them.
    if (a.name === 'top' || a.name === 'bottom' || b.name === 'left' || b.name === 'right') {
      const x = h(b);
      const y = v(a);
      return x === undefined || y === undefined ? bad() : [pct(x), pct(y)];
    }
    const x = h(a);
    const y = v(b);
    return x === undefined || y === undefined ? bad() : [pct(x), pct(y)];
  }
  if (aKw) {
    const x = h(a);
    return x === undefined ? bad() : [pct(x), lengthOf(b)];
  }
  if (bKw) {
    const y = v(b);
    return y === undefined ? bad() : [lengthOf(a), pct(y)];
  }
  return [lengthOf(a), lengthOf(b)];
}

/** CSS's 1-to-4-value box expansion: top, right, bottom, left. */
export function expandSides<T>(values: T[]): Sides<T> {
  const [a, b, c, d] = values;
  switch (values.length) {
    case 1: return [a!, a!, a!, a!];
    case 2: return [a!, b!, a!, b!];
    case 3: return [a!, b!, c!, b!];
    case 4: return [a!, b!, c!, d!];
    default: return fail(`expected 1 to 4 values, found ${values.length}`);
  }
}

/** `parseLength` for a value as React passes it: a number is px; a string is a CSS length or `0`. */
export function parseLength(value: unknown): Length | null {
  try {
    if (typeof value === 'number') return Number.isFinite(value) ? { unit: 'px', value } : null;
    if (typeof value !== 'string') return null;
    const toks = lex(value);
    if (toks.length !== 1 || !isLengthLike(toks[0])) return null;
    return lengthOf(toks[0]);
  } catch {
    return null;
  }
}

export function resolveLength(length: Length, context: LengthContext): number {
  switch (length.unit) {
    case 'px': return length.value;
    case '%': return (length.value / 100) * context.percentOf;
    case 'em': return length.value * context.fontSize;
    case 'rem': return length.value * context.rootFontSize;
    case 'vw': return (length.value / 100) * context.viewport.width;
    case 'vh': return (length.value / 100) * context.viewport.height;
  }
}
