// The cascade of the inherited properties (docs/COMPAT.md §4.4): what an element's text looks like, from its own
// style, Chrome's defaults and its parent.

import { fontKey } from '@kinetograph/scene';
import type { ColorValue, ParsedStyle, Rgba, TextShadow } from '../css/types.js';
import { BLACK, px, ROOT_FONT_SIZE, type LengthEnv } from './util.js';

export type LineHeight = { kind: 'normal' } | { kind: 'multiple'; value: number } | { kind: 'px'; value: number };

/** The inherited properties, resolved. */
export interface Inherited {
  color: Rgba;
  fontFamily: string[];
  /** px */
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  lineHeight: LineHeight;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  whiteSpace: NonNullable<ParsedStyle['whiteSpace']>;
  textShadow: TextShadow[];
  visible: boolean;
}

export const ROOT_INHERITED: Inherited = {
  color: BLACK,
  fontFamily: [],
  fontSize: ROOT_FONT_SIZE,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeight: { kind: 'normal' },
  textAlign: 'left',
  textTransform: 'none',
  whiteSpace: 'normal',
  textShadow: [],
  visible: true,
};

const KEYWORD_SIZES: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
};

/** `font-weight: bolder` / `lighter` from the parent's weight (CSS Fonts 4, the table). */
function relativeWeight(parent: number, how: 'bolder' | 'lighter'): number {
  if (how === 'bolder') return parent < 350 ? 400 : parent < 550 ? 700 : 900;
  return parent < 550 ? 100 : parent < 750 ? 400 : 700;
}

export function colorOf(value: ColorValue | undefined, current: Rgba): Rgba | undefined {
  if (value === undefined) return undefined;
  return value === 'currentcolor' ? current : value;
}

/** The inherited properties of an element whose parent has `parent` and whose own style is `style`. */
export function inherit(style: ParsedStyle, parent: Inherited, viewport: LengthEnv['viewport']): Inherited {
  const out: Inherited = { ...parent };
  const parentEnv: LengthEnv = { fontSize: parent.fontSize, viewport };

  const size = style.fontSize;
  if (size !== undefined) {
    if (typeof size === 'object') out.fontSize = px(size, parentEnv, parent.fontSize);
    else if (size === 'smaller') out.fontSize = parent.fontSize / 1.2;
    else if (size === 'larger') out.fontSize = parent.fontSize * 1.2;
    else out.fontSize = KEYWORD_SIZES[size] ?? parent.fontSize;
  }
  const env: LengthEnv = { fontSize: out.fontSize, viewport };

  out.color = colorOf(style.color, parent.color) ?? parent.color;
  if (style.fontFamily !== undefined) out.fontFamily = style.fontFamily;
  if (style.fontWeight !== undefined) {
    out.fontWeight =
      typeof style.fontWeight === 'number' ? style.fontWeight : relativeWeight(parent.fontWeight, style.fontWeight);
  }
  if (style.fontStyle !== undefined) out.fontStyle = style.fontStyle === 'normal' ? 'normal' : 'italic';
  const height = style.lineHeight;
  if (height !== undefined) {
    if (height === 'normal') out.lineHeight = { kind: 'normal' };
    else if (typeof height === 'number') out.lineHeight = { kind: 'multiple', value: height };
    else out.lineHeight = { kind: 'px', value: px(height, env, out.fontSize) };
  }
  if (style.textAlign !== undefined) {
    out.textAlign = style.textAlign === 'start' ? 'left' : style.textAlign === 'end' ? 'right' : style.textAlign;
  }
  if (style.textTransform !== undefined) out.textTransform = style.textTransform;
  if (style.whiteSpace !== undefined) out.whiteSpace = style.whiteSpace;
  if (style.textShadow !== undefined) out.textShadow = style.textShadow;
  if (style.visibility !== undefined) out.visible = style.visibility === 'visible';
  return out;
}

/** The line height as the text layer takes it: a multiple of the font size (`normal` is 1.2). */
export function lineHeightMultiple(inh: Inherited): number {
  switch (inh.lineHeight.kind) {
    case 'normal':
      return 1.2;
    case 'multiple':
      return inh.lineHeight.value;
    case 'px':
      return inh.lineHeight.value / inh.fontSize;
  }
}

/** The font key of the first family in the list that is registered, or null. */
export function fontKeyOf(inh: Inherited, fonts: Record<string, string>): string | null {
  for (const family of inh.fontFamily) {
    const candidate = fontKey(family, inh.fontWeight, inh.fontStyle);
    if (candidate in fonts) return candidate;
  }
  return null;
}
