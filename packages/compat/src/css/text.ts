// Font and text properties (CSS Fonts 4, CSS Text 3, CSS Text Decoration 3), and the `font` shorthand.

import { colorOf } from './color.js';
import { type Tok, fail, isKw, isLengthLike, nameOf, single, splitCommas } from './tokens.js';
import type { Length, ParsedStyle } from './types.js';
import { lengthOf } from './values.js';

type FontSize = NonNullable<ParsedStyle['fontSize']>;
type LineHeight = NonNullable<ParsedStyle['lineHeight']>;
type FontWeight = NonNullable<ParsedStyle['fontWeight']>;

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong',
]);

/** `font-family`: quoted names are kept as written; an unquoted name is its words joined by single spaces. */
export function fontFamilyOf(toks: Tok[]): string[] {
  return splitCommas(toks).map((seg) => {
    if (seg.length === 1 && seg[0]!.type === 'string') {
      return (seg[0] as Extract<Tok, { type: 'string' }>).str;
    }
    if (!seg.every((t) => t.type === 'ident')) return fail(`\`${seg.map((t) => t.text).join(' ')}\` is not a font family name`);
    if (seg.length === 1 && ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default'].includes(nameOf(seg[0]))) {
      return fail(`\`${seg.map((t) => t.text).join(' ')}\` is a reserved word, not a font family name`);
    }
    const name = seg.map((t) => t.text).join(' ');
    return seg.length === 1 && GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : name;
  });
}

export function fontWeightOf(toks: Tok[]): FontWeight {
  const t = single(toks);
  if (t.type === 'ident') {
    if (t.name === 'normal') return 400;
    if (t.name === 'bold') return 700;
    if (t.name === 'bolder' || t.name === 'lighter') return t.name;
    return fail(`\`${t.text}\` is not a font weight`);
  }
  if (t.type === 'number' && t.value >= 1 && t.value <= 1000) return t.value;
  return fail(`\`${t.text}\` is not a font weight (a number from 1 to 1000, or a keyword)`);
}

const FONT_SIZE_KEYWORDS = ['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'smaller', 'larger'];

function fontSizeTok(t: Tok | undefined): FontSize {
  if (t && t.type === 'ident') {
    if (FONT_SIZE_KEYWORDS.includes(t.name)) return t.name as FontSize;
    if (t.name === 'xxx-large' || t.name === 'math') return fail(`the font size keyword \`${t.text}\` is not supported`);
    return fail(`\`${t.text}\` is not a font size`);
  }
  return lengthOf(t, { negative: false });
}

export function fontSizeOf(toks: Tok[]): FontSize {
  return fontSizeTok(single(toks));
}

function lineHeightTok(t: Tok | undefined): LineHeight {
  if (t && t.type === 'ident' && t.name === 'normal') return 'normal';
  if (t && t.type === 'number') {
    if (t.value < 0) return fail('a line height must not be negative');
    return t.value;
  }
  return lengthOf(t, { negative: false });
}

export function lineHeightOf(toks: Tok[]): LineHeight {
  return lineHeightTok(single(toks));
}

export function fontStyleOf(toks: Tok[]): 'normal' | 'italic' | 'oblique' {
  if (toks.length > 1 && isKw(toks[0], 'oblique')) return fail('an oblique angle is not supported');
  const t = single(toks);
  if (isKw(t, 'normal', 'italic', 'oblique')) return nameOf(t) as 'normal' | 'italic' | 'oblique';
  return fail(`\`${t.text}\` is not a font style`);
}

/** `letter-spacing` and `word-spacing`. */
export function spacingOf(toks: Tok[]): Length | 'normal' {
  const t = single(toks);
  if (isKw(t, 'normal')) return 'normal';
  return lengthOf(t, { percent: false });
}

const STRETCH_KEYWORDS = [
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded',
  'ultra-expanded',
];
const SYSTEM_FONTS = ['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar'];

export interface FontShorthand {
  fontStyle: 'normal' | 'italic' | 'oblique';
  fontWeight: FontWeight;
  fontSize: FontSize;
  lineHeight: LineHeight;
  fontFamily: string[];
}

/** `font: [style || weight] size[/line-height] family`; unset parts take their initial values. */
export function fontShorthandOf(toks: Tok[]): FontShorthand {
  if (toks.length === 1 && isKw(toks[0], ...SYSTEM_FONTS)) return fail(`the system font \`${toks[0].text}\` is not supported`);
  let fontStyle: FontShorthand['fontStyle'] | null = null;
  let fontWeight: FontWeight | null = null;
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (isKw(t, 'normal')) continue;
    if (isKw(t, 'italic', 'oblique')) {
      if (fontStyle) return fail('the font style appears twice');
      if (nameOf(t) === 'oblique' && (toks[i + 1]?.type === 'dimension')) return fail('an oblique angle is not supported');
      fontStyle = nameOf(t) as 'italic' | 'oblique';
    } else if (isKw(t, 'bold', 'bolder', 'lighter') || (t.type === 'number' && t.value >= 1 && t.value <= 1000)) {
      if (fontWeight !== null) return fail('the font weight appears twice');
      fontWeight = fontWeightOf([t]);
    } else if (isKw(t, 'small-caps')) {
      return fail('`small-caps` in the font shorthand is not supported');
    } else if (isKw(t, ...STRETCH_KEYWORDS)) {
      return fail(`the font stretch \`${t.text}\` is not supported`);
    } else {
      break;
    }
  }
  if (i > 4) return fail('too many values before the font size');
  const sizeTok = toks[i];
  if (!sizeTok || !(isLengthLike(sizeTok) || sizeTok.type === 'ident')) return fail('the font shorthand needs a font size');
  const fontSize = fontSizeTok(sizeTok);
  i++;
  let lineHeight: LineHeight = 'normal';
  if (toks[i]?.type === 'slash') {
    lineHeight = lineHeightTok(toks[i + 1]);
    i += 2;
  }
  const family = toks.slice(i);
  if (family.length === 0) return fail('the font shorthand needs a font family');
  return {
    fontStyle: fontStyle ?? 'normal',
    fontWeight: fontWeight ?? 400,
    fontSize,
    lineHeight,
    fontFamily: fontFamilyOf(family),
  };
}

const DECORATION_LINES = ['none', 'underline', 'overline', 'line-through', 'blink'];
const DECORATION_STYLES = ['solid', 'double', 'dotted', 'dashed', 'wavy'];

/** `text-decoration`, validated and kept as its words. */
export function textDecorationOf(toks: Tok[]): string {
  for (const t of toks) {
    if (isKw(t, ...DECORATION_LINES, ...DECORATION_STYLES, 'auto', 'from-font')) continue;
    if (isLengthLike(t)) {
      lengthOf(t);
      continue;
    }
    if (colorOf(t) === null) return fail(`unexpected \`${t.text}\` in a text-decoration`);
  }
  return toks.map((t) => t.text).join(' ');
}
