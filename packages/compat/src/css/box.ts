// Box model, flex and border properties (CSS Box 4, Flexbox 1, Backgrounds 3, Align 3).

import { colorOf } from './color.js';
import { type Tok, fail, isKw, isLengthLike, single } from './tokens.js';
import type {
  ColorValue,
  Length,
  LengthOrAuto,
  LengthOrNone,
  ParsedStyle,
  Sides,
} from './types.js';
import { expandSides, integerOf, lengthOf, numberOf, numberOrPercent } from './values.js';

const ZERO: Length = { unit: 'px', value: 0 };

const INTRINSIC_SIZES = ['min-content', 'max-content', 'fit-content', 'stretch', '-webkit-fill-available', '-webkit-fit-content'];

function sizeTok(t: Tok | undefined, keywords: readonly string[]): Length | string {
  if (t && t.type === 'ident') {
    if (keywords.includes(t.name)) return t.name;
    if (INTRINSIC_SIZES.includes(t.name)) return fail(`the size keyword \`${t.text}\` is not supported`);
    return fail(`\`${t.text}\` is not a valid size`);
  }
  return lengthOf(t, { negative: false });
}

/** `width`, `height`, `min-width`, `min-height`: a non-negative length or `auto`. */
export function sizeOf(toks: Tok[]): LengthOrAuto {
  return sizeTok(single(toks), ['auto']) as LengthOrAuto;
}

/** `max-width`, `max-height`: a non-negative length or `none`. */
export function maxSizeOf(toks: Tok[]): LengthOrNone {
  return sizeTok(single(toks), ['none']) as LengthOrNone;
}

function sideTok(t: Tok, auto: boolean, negative: boolean): LengthOrAuto {
  if (isKw(t, 'auto')) {
    if (!auto) return fail('`auto` is not allowed here');
    return 'auto';
  }
  return lengthOf(t, { negative });
}

/** `margin`, `inset`: 1 to 4 lengths or `auto`. */
export function autoSidesOf(toks: Tok[]): Sides<LengthOrAuto> {
  return expandSides(toks.map((t) => sideTok(t, true, true)));
}

/** `padding`: 1 to 4 non-negative lengths. */
export function paddingOf(toks: Tok[]): Sides<Length> {
  return expandSides(toks.map((t) => lengthOf(t, { negative: false })));
}

export function oneAutoSide(toks: Tok[]): LengthOrAuto {
  return sideTok(single(toks), true, true);
}

export function onePaddingSide(toks: Tok[]): Length {
  return lengthOf(single(toks), { negative: false });
}

export function zeroSides(): Sides<Length> {
  return [ZERO, ZERO, ZERO, ZERO];
}

export function autoSides(): Sides<LengthOrAuto> {
  return ['auto', 'auto', 'auto', 'auto'];
}

export function zeroAutoSides(): Sides<LengthOrAuto> {
  return [ZERO, ZERO, ZERO, ZERO];
}

/** `aspect-ratio`: a ratio (`16 / 9`, `1.5`) as a number, or `null` for `auto`. */
export function aspectRatioOf(toks: Tok[]): number | null {
  if (toks.length === 1 && isKw(toks[0], 'auto')) return null;
  if (toks.some((t) => isKw(t, 'auto'))) return fail('`auto` with a ratio is not supported');
  const w = numberOf(toks[0], 'a ratio');
  if (toks.length === 1) return nonNegative(w);
  if (toks.length === 3 && toks[1]!.type === 'slash') {
    const h = numberOf(toks[2], 'a ratio');
    if (h === 0) return fail('the ratio\'s denominator is zero');
    return nonNegative(w / h);
  }
  return fail('expected a number or `number / number`');
}

function nonNegative(n: number): number {
  return n < 0 ? fail('a ratio must not be negative') : n;
}

// ---- flex ----

export interface FlexShorthand {
  grow: number;
  shrink: number;
  basis: LengthOrAuto | 'content';
}

export function flexBasisOf(toks: Tok[]): LengthOrAuto | 'content' {
  const t = single(toks);
  if (isKw(t, 'content')) return 'content';
  return sizeTok(t, ['auto']) as LengthOrAuto;
}

function flexFactor(t: Tok | undefined): number {
  const n = numberOf(t, 'a flex factor');
  return n < 0 ? fail('a flex factor must not be negative') : n;
}

export function flexGrowShrinkOf(toks: Tok[]): number {
  return flexFactor(single(toks));
}

/** `flex: none | auto | [ <grow> <shrink>? || <basis> ]`. */
export function flexShorthandOf(toks: Tok[]): FlexShorthand {
  if (toks.length === 1 && isKw(toks[0], 'none')) return { grow: 0, shrink: 0, basis: 'auto' };
  if (toks.length === 1 && isKw(toks[0], 'auto')) return { grow: 1, shrink: 1, basis: 'auto' };
  if (toks.length > 3) return fail('flex takes at most three values');
  const factors: number[] = [];
  let basis: LengthOrAuto | 'content' | null = null;
  let factorEnd = -2;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    // A bare number is a flex factor, except a third value (after two factors and after a basis) which can only be `0`.
    if (t.type === 'number' && !(factors.length === 2 && basis === null && t.value === 0)) {
      if (factors.length === 2) return fail('flex takes at most two flex factors');
      if (factors.length > 0 && factorEnd !== i - 1) return fail('the flex factors must be next to each other');
      factors.push(flexFactor(t));
      factorEnd = i;
    } else {
      if (basis !== null) return fail('flex takes one basis');
      basis = flexBasisOf([t]);
    }
  }
  if (factors.length === 0) {
    if (basis === null) return fail('expected flex values');
    return { grow: 1, shrink: 1, basis };
  }
  return { grow: factors[0]!, shrink: factors[1] ?? 1, basis: basis ?? ZERO_PERCENT };
}

const ZERO_PERCENT: Length = { unit: '%', value: 0 };

// ---- gap and overflow ----

function gapTok(t: Tok): Length {
  if (isKw(t, 'normal')) return ZERO;
  return lengthOf(t, { negative: false });
}

export function oneGapOf(toks: Tok[]): Length {
  return gapTok(single(toks));
}

/** `gap: <row> <column>?`; `normal` is 0 in flex layout. */
export function gapOf(toks: Tok[]): [Length, Length] {
  if (toks.length < 1 || toks.length > 2) return fail(`gap takes 1 or 2 values, found ${toks.length}`);
  const row = gapTok(toks[0]!);
  return [row, toks[1] ? gapTok(toks[1]) : row];
}

type Overflow = NonNullable<ParsedStyle['overflowX']>;
const OVERFLOWS = ['visible', 'hidden', 'clip', 'scroll', 'auto', 'overlay'];

function overflowTok(t: Tok): Overflow {
  if (t.type === 'ident' && OVERFLOWS.includes(t.name)) return (t.name === 'overlay' ? 'auto' : t.name) as Overflow;
  return fail(`\`${t.text}\` is not an overflow value`);
}

export function overflowOf(toks: Tok[]): [Overflow, Overflow] {
  if (toks.length < 1 || toks.length > 2) return fail(`overflow takes 1 or 2 values, found ${toks.length}`);
  const x = overflowTok(toks[0]!);
  return [x, toks[1] ? overflowTok(toks[1]) : x];
}

export function oneOverflowOf(toks: Tok[]): Overflow {
  return overflowTok(single(toks));
}

// ---- numbers ----

/** `opacity`: a number or percentage, clamped to 0..1. */
export function opacityOf(toks: Tok[]): number {
  return Math.min(1, Math.max(0, numberOrPercent(single(toks))));
}

export function integerValueOf(toks: Tok[]): number {
  return integerOf(single(toks));
}

export function zIndexOf(toks: Tok[]): number | 'auto' {
  const t = single(toks);
  return isKw(t, 'auto') ? 'auto' : integerOf(t);
}

// ---- borders ----

export const BORDER_STYLES = ['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset'];
const BORDER_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

export function borderWidthTok(t: Tok): Length {
  if (t.type === 'ident') {
    const px = Object.hasOwn(BORDER_WIDTH_KEYWORDS, t.name) ? BORDER_WIDTH_KEYWORDS[t.name] : undefined;
    if (px === undefined) return fail(`\`${t.text}\` is not a border width`);
    return { unit: 'px', value: px };
  }
  return lengthOf(t, { percent: false, negative: false });
}

export function borderStyleTok(t: Tok): string {
  if (t.type === 'ident' && BORDER_STYLES.includes(t.name)) return t.name;
  return fail(`\`${t.text}\` is not a border style`);
}

export function borderColorTok(t: Tok): ColorValue {
  const c = colorOf(t);
  return c === null ? fail(`\`${t.text}\` is not a colour`) : c;
}

export interface BorderSide {
  width: Length;
  style: string;
  color: ColorValue;
}

/** `border` / `border-top` / …: `<width> || <style> || <color>`; unset parts take their initial values. */
export function borderShorthandOf(toks: Tok[]): BorderSide {
  let width: Length | null = null;
  let style: string | null = null;
  let color: ColorValue | null = null;
  for (const t of toks) {
    if (t.type === 'ident' && BORDER_STYLES.includes(t.name)) {
      if (style !== null) return fail('the border style appears twice');
      style = t.name;
    } else if (isLengthLike(t) || (t.type === 'ident' && Object.hasOwn(BORDER_WIDTH_KEYWORDS, t.name))) {
      if (width !== null) return fail('the border width appears twice');
      width = borderWidthTok(t);
    } else {
      const c = colorOf(t);
      if (c === null) return fail(`unexpected \`${t.text}\` in a border`);
      if (color !== null) return fail('the border colour appears twice');
      color = c;
    }
  }
  return { width: width ?? { unit: 'px', value: 3 }, style: style ?? 'none', color: color ?? 'currentcolor' };
}
