// `box-shadow`, `text-shadow` and `filter` (CSS Backgrounds 3, CSS Text Decoration 3, Filter Effects 1).

import { colorOf } from './color.js';
import { type Tok, fail, isKw, splitCommas } from './tokens.js';
import type { BoxShadow, ColorValue, FilterOp, Length, TextShadow } from './types.js';
import { angleOf, lengthOf, numberOrPercent } from './values.js';

const ZERO: Length = { unit: 'px', value: 0 };

interface ShadowParts {
  inset: boolean;
  lengths: Length[];
  color: ColorValue;
}

/** `inset? && <length>{min,max} && <color>?`, the parts in any order but the lengths together. */
function shadowParts(toks: Tok[], allowInset: boolean, min: number, max: number): ShadowParts {
  let inset = false;
  let color: ColorValue | null = null;
  const lengths: Length[] = [];
  let lastLength = -2;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (isKw(t, 'inset')) {
      if (!allowInset) fail('`inset` is not allowed here');
      if (inset) fail('`inset` appears twice');
      inset = true;
      continue;
    }
    if (t.type === 'number' || t.type === 'dimension' || t.type === 'percent') {
      if (lengths.length > 0 && i !== lastLength + 1) fail('the lengths of a shadow must be next to each other');
      if (lengths.length === max) fail(`a shadow takes at most ${max} lengths`);
      lengths.push(lengthOf(t, { percent: false }));
      lastLength = i;
      continue;
    }
    const c = colorOf(t);
    if (c === null) return fail(`unexpected \`${t.text}\` in a shadow`);
    if (color !== null) fail('a shadow has one colour');
    color = c;
  }
  if (lengths.length < min) fail(`a shadow needs ${min === max ? min : `${min} to ${max}`} lengths, found ${lengths.length}`);
  return { inset, lengths, color: color ?? 'currentcolor' };
}

export function boxShadowOf(toks: Tok[]): BoxShadow[] {
  if (toks.length === 1 && isKw(toks[0], 'none')) return [];
  return splitCommas(toks).map((seg) => {
    const { inset, lengths, color } = shadowParts(seg, true, 2, 4);
    const [x, y, blur, spread] = lengths as [Length, Length, Length | undefined, Length | undefined];
    if (blur && blur.value < 0) fail('the blur radius of a shadow must not be negative');
    return { inset, x, y, blur: blur ?? ZERO, spread: spread ?? ZERO, color };
  });
}

export function textShadowOf(toks: Tok[]): TextShadow[] {
  if (toks.length === 1 && isKw(toks[0], 'none')) return [];
  return splitCommas(toks).map((seg) => {
    const { lengths, color } = shadowParts(seg, false, 2, 3);
    const [x, y, blur] = lengths as [Length, Length, Length | undefined];
    if (blur && blur.value < 0) fail('the blur radius of a shadow must not be negative');
    return { x, y, blur: blur ?? ZERO, color };
  });
}

const AMOUNT_FILTERS = ['brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'invert', 'opacity'] as const;
const CLAMPED_TO_ONE = new Set(['grayscale', 'sepia', 'invert', 'opacity']);

function oneFilter(t: Tok): FilterOp {
  if (t.type === 'url') return fail('`url()` filters are not supported');
  if (t.type !== 'function') return fail(`expected a filter function, found \`${t.text}\``);
  const args = t.args;
  const arg = (): Tok | undefined => {
    if (args.length > 1) fail(`${t.name}() takes one argument`);
    return args[0];
  };
  const name = t.name;
  if (name === 'blur') {
    const a = arg();
    return { op: 'blur', radius: a ? lengthOf(a, { percent: false, negative: false }) : ZERO };
  }
  if (name === 'hue-rotate') {
    const a = arg();
    return { op: 'hue-rotate', angle: a ? angleOf(a) : 0 };
  }
  if (name === 'drop-shadow') {
    const { lengths, color } = shadowParts(args, false, 2, 3);
    const [x, y, blur] = lengths as [Length, Length, Length | undefined];
    if (blur && blur.value < 0) fail('the blur radius of a shadow must not be negative');
    return { op: 'drop-shadow', x, y, blur: blur ?? ZERO, color };
  }
  const amountOp = (AMOUNT_FILTERS as readonly string[]).includes(name) ? (name as (typeof AMOUNT_FILTERS)[number]) : null;
  if (amountOp) {
    const a = arg();
    let amount = a ? numberOrPercent(a) : 1;
    if (amount < 0) fail(`${name}() must not be negative`);
    if (CLAMPED_TO_ONE.has(name)) amount = Math.min(1, amount);
    return { op: amountOp, amount };
  }
  return fail(`the filter function ${name}() is not supported`);
}

/** A `filter` value; `none` is the empty list. */
export function filterOf(toks: Tok[]): FilterOp[] {
  if (toks.length === 1 && isKw(toks[0], 'none')) return [];
  return toks.map(oneFilter);
}
