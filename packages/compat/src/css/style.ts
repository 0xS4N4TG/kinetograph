// `parseStyle`: a React inline `style` object to a `ParsedStyle` plus a `Diagnostic` for everything that is not read.

import {
  backgroundShorthandOf,
  imageListOf,
  positionListOf,
  repeatListOf,
  sizeListOf,
} from './background.js';
import {
  autoSides,
  autoSidesOf,
  aspectRatioOf,
  borderColorTok,
  borderShorthandOf,
  borderStyleTok,
  borderWidthTok,
  flexBasisOf,
  flexGrowShrinkOf,
  flexShorthandOf,
  gapOf,
  integerValueOf,
  maxSizeOf,
  oneAutoSide,
  oneGapOf,
  oneOverflowOf,
  onePaddingSide,
  opacityOf,
  overflowOf,
  paddingOf,
  sizeOf,
  zIndexOf,
  zeroAutoSides,
  zeroSides,
} from './box.js';
import { requireColor } from './color.js';
import { boxShadowOf, filterOf, textShadowOf } from './effects.js';
import { borderRadiusOf, clipPathOf, cornerRadiusOf, zeroCorners } from './shape.js';
import {
  fontFamilyOf,
  fontShorthandOf,
  fontSizeOf,
  fontStyleOf,
  fontWeightOf,
  lineHeightOf,
  spacingOf,
  textDecorationOf,
} from './text.js';
import { type Tok, CssError, fail, isKw, keyword, lex, single, splitCommas } from './tokens.js';
import { perspectiveOf, transformOf, transformOriginOf } from './transform.js';
import type { ColorValue, Diagnostic, Length, ParsedStyle, Sides, SvgPaint } from './types.js';
import { lengthOf, numberOrPercent, positionOf } from './values.js';

type Mut = Record<string, unknown>;
type Handler = (toks: Tok[], out: Mut) => void;

const HANDLERS = new Map<string, Handler>();
const on = (name: string, fn: Handler): void => {
  HANDLERS.set(name, fn);
};
/** A property that holds exactly what `parse` returns. */
const prop = <T>(name: string, parse: (toks: Tok[]) => T): void => on(name, (toks, o) => void (o[name] = parse(toks)));
const enumProp = (name: string, allowed: readonly string[]): void => prop(name, (toks) => keyword(toks, allowed));
/** Keyword values Chrome has but this pass does not read. */
const unsupportedKeywords = (name: string, supported: readonly string[], unsupported: readonly string[]): void =>
  prop(name, (toks) => {
    const t = single(toks);
    if (t.type === 'ident' && unsupported.includes(t.name)) return fail(`${name}: \`${t.text}\` is not supported`);
    return keyword(toks, supported);
  });

const colorProp = (name: string): void => prop(name, (toks) => requireColor(single(toks)));

/** Alignment keywords, validated word by word and kept as the written words. */
const alignmentProp = (name: string, words: readonly string[]): void =>
  prop(name, (toks) => {
    if (toks.length > 3) return fail('too many values');
    for (const t of toks) if (!isKw(t, ...words)) return fail(`\`${t.text}\` is not an alignment value`);
    return toks.map((t) => (t as Extract<Tok, { type: 'ident' }>).name).join(' ');
  });

// ---- layout ----

unsupportedKeywords('display', ['block', 'flex', 'inline-block', 'inline-flex', 'inline', 'none'], [
  'grid', 'inline-grid', 'table', 'inline-table', 'table-row', 'table-cell', 'table-row-group', 'table-header-group',
  'table-footer-group', 'table-column', 'table-column-group', 'table-caption', 'contents', 'flow-root', 'list-item', 'ruby',
]);
unsupportedKeywords('position', ['static', 'relative', 'absolute', 'fixed'], ['sticky', '-webkit-sticky']);

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

function sidesProp<T>(name: string, initial: () => Sides<T>, parseAll: (toks: Tok[]) => Sides<T>, parseOne: (toks: Tok[]) => T, longhands: string[]): void {
  prop(name, parseAll);
  longhands.forEach((long, i) => {
    on(long, (toks, o) => {
      const sides = [...((o[name] as Sides<T> | undefined) ?? initial())] as Sides<T>;
      sides[i] = parseOne(toks);
      o[name] = sides;
    });
  });
}

sidesProp('margin', zeroAutoSides, autoSidesOf, (t) => oneAutoSide(t), SIDES.map((s) => `margin${s}`));
sidesProp('padding', zeroSides, paddingOf, onePaddingSide, SIDES.map((s) => `padding${s}`));
sidesProp('inset', autoSides, autoSidesOf, (t) => oneAutoSide(t), ['top', 'right', 'bottom', 'left']);

prop('width', sizeOf);
prop('height', sizeOf);
prop('minWidth', sizeOf);
prop('minHeight', sizeOf);
prop('maxWidth', maxSizeOf);
prop('maxHeight', maxSizeOf);
on('aspectRatio', (toks, o) => {
  const ratio = aspectRatioOf(toks);
  if (ratio === null) delete o.aspectRatio;
  else o.aspectRatio = ratio;
});
enumProp('boxSizing', ['content-box', 'border-box']);

enumProp('flexDirection', ['row', 'row-reverse', 'column', 'column-reverse']);
enumProp('flexWrap', ['nowrap', 'wrap', 'wrap-reverse']);
prop('flexGrow', flexGrowShrinkOf);
prop('flexShrink', flexGrowShrinkOf);
prop('flexBasis', flexBasisOf);
on('flex', (toks, o) => {
  const { grow, shrink, basis } = flexShorthandOf(toks);
  o.flexGrow = grow;
  o.flexShrink = shrink;
  o.flexBasis = basis;
});
const CONTENT_WORDS = [
  'normal', 'stretch', 'start', 'end', 'center', 'flex-start', 'flex-end', 'left', 'right', 'space-between', 'space-around',
  'space-evenly', 'baseline', 'first', 'last', 'safe', 'unsafe',
];
const ITEM_WORDS = [
  'normal', 'stretch', 'start', 'end', 'center', 'flex-start', 'flex-end', 'self-start', 'self-end', 'baseline', 'first',
  'last', 'safe', 'unsafe',
];
alignmentProp('justifyContent', CONTENT_WORDS);
alignmentProp('alignContent', CONTENT_WORDS);
alignmentProp('alignItems', ITEM_WORDS);
alignmentProp('alignSelf', ['auto', ...ITEM_WORDS]);
prop('rowGap', oneGapOf);
prop('columnGap', oneGapOf);
on('gap', (toks, o) => {
  const [row, column] = gapOf(toks);
  o.rowGap = row;
  o.columnGap = column;
});
prop('order', integerValueOf);
prop('zIndex', zIndexOf);
on('overflow', (toks, o) => {
  const [x, y] = overflowOf(toks);
  o.overflowX = x;
  o.overflowY = y;
});
prop('overflowX', oneOverflowOf);
prop('overflowY', oneOverflowOf);
enumProp('visibility', ['visible', 'hidden', 'collapse']);

// ---- borders ----

type BorderState = { w: Sides<Length>; s: Sides<string>; c: Sides<ColorValue> };
const MEDIUM: Length = { unit: 'px', value: 3 };

function borderState(o: Mut): BorderState {
  o.borderWidth ??= [MEDIUM, MEDIUM, MEDIUM, MEDIUM];
  o.borderStyle ??= ['none', 'none', 'none', 'none'];
  o.borderColor ??= ['currentcolor', 'currentcolor', 'currentcolor', 'currentcolor'];
  return { w: o.borderWidth as Sides<Length>, s: o.borderStyle as Sides<string>, c: o.borderColor as Sides<ColorValue> };
}

/** Sets `index` of one border property without touching the arrays an earlier declaration may share. */
function setSide<T>(o: Mut, key: 'borderWidth' | 'borderStyle' | 'borderColor', index: number, value: T): void {
  const sides = [...(o[key] as T[])] as Sides<T>;
  sides[index] = value;
  o[key] = sides;
}

on('border', (toks, o) => {
  const side = borderShorthandOf(toks);
  borderState(o);
  for (let i = 0; i < 4; i++) {
    setSide(o, 'borderWidth', i, side.width);
    setSide(o, 'borderStyle', i, side.style);
    setSide(o, 'borderColor', i, side.color);
  }
});
SIDES.forEach((name, i) => {
  on(`border${name}`, (toks, o) => {
    const side = borderShorthandOf(toks);
    borderState(o);
    setSide(o, 'borderWidth', i, side.width);
    setSide(o, 'borderStyle', i, side.style);
    setSide(o, 'borderColor', i, side.color);
  });
  on(`border${name}Width`, (toks, o) => {
    borderState(o);
    setSide(o, 'borderWidth', i, borderWidthTok(single(toks)));
  });
  on(`border${name}Style`, (toks, o) => {
    borderState(o);
    setSide(o, 'borderStyle', i, borderStyleTok(single(toks)));
  });
  on(`border${name}Color`, (toks, o) => {
    borderState(o);
    setSide(o, 'borderColor', i, borderColorTok(single(toks)));
  });
});
const perSide = <T>(toks: Tok[], one: (t: Tok) => T): Sides<T> => {
  if (toks.length < 1 || toks.length > 4) return fail(`expected 1 to 4 values, found ${toks.length}`);
  const v = toks.map(one);
  return [v[0]!, v[1] ?? v[0]!, v[2] ?? v[0]!, v[3] ?? v[1] ?? v[0]!];
};
on('borderWidth', (toks, o) => {
  const w = perSide(toks, borderWidthTok);
  borderState(o);
  w.forEach((v, i) => setSide(o, 'borderWidth', i, v));
});
on('borderStyle', (toks, o) => {
  const s = perSide(toks, borderStyleTok);
  borderState(o);
  s.forEach((v, i) => setSide(o, 'borderStyle', i, v));
});
on('borderColor', (toks, o) => {
  const c = perSide(toks, borderColorTok);
  borderState(o);
  c.forEach((v, i) => setSide(o, 'borderColor', i, v));
});

prop('borderRadius', borderRadiusOf);
['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].forEach((name, i) => {
  on(name, (toks, o) => {
    const corners = [...((o.borderRadius as ParsedStyle['borderRadius']) ?? zeroCorners())] as NonNullable<ParsedStyle['borderRadius']>;
    corners[i] = cornerRadiusOf(toks);
    o.borderRadius = corners;
  });
});

// ---- paint ----

prop('opacity', opacityOf);
colorProp('backgroundColor');
prop('backgroundImage', imageListOf);
prop('backgroundSize', sizeListOf);
prop('backgroundPosition', positionListOf);
prop('backgroundRepeat', repeatListOf);

/** A list property that holds a single value in `ParsedStyle`: every layer must agree. */
function uniform(name: string, allowed: readonly string[]): void {
  prop(name, (toks) => {
    const values = splitCommas(toks).map((seg) => keyword(seg, allowed));
    if (values.some((v) => v !== values[0])) return fail(`a different ${name} per layer is not supported`);
    return values[0];
  });
}
uniform('backgroundClip', ['border-box', 'padding-box', 'content-box', 'text']);
uniform('backgroundOrigin', ['border-box', 'padding-box', 'content-box']);
on('background', (toks, o) => {
  const b = backgroundShorthandOf(toks);
  o.backgroundColor = b.color;
  o.backgroundImage = b.images;
  o.backgroundSize = b.size;
  o.backgroundPosition = b.position;
  o.backgroundRepeat = b.repeat;
  o.backgroundOrigin = b.origin;
  o.backgroundClip = b.clip;
});

prop('boxShadow', boxShadowOf);
prop('filter', filterOf);
enumProp('mixBlendMode', [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter', 'plus-darker',
]);
prop('transform', transformOf);
prop('transformOrigin', transformOriginOf);
enumProp('transformStyle', ['flat', 'preserve-3d']);
prop('perspective', perspectiveOf);
prop('perspectiveOrigin', positionOf);
prop('clipPath', clipPathOf);
prop('maskImage', imageListOf);
prop('maskSize', sizeListOf);
prop('maskPosition', positionListOf);
prop('maskRepeat', repeatListOf);
enumProp('objectFit', ['fill', 'contain', 'cover', 'none', 'scale-down']);
prop('objectPosition', positionOf);

// ---- text ----

colorProp('color');
prop('fontFamily', fontFamilyOf);
prop('fontSize', fontSizeOf);
prop('fontWeight', fontWeightOf);
prop('fontStyle', fontStyleOf);
on('font', (toks, o) => {
  Object.assign(o, fontShorthandOf(toks));
});
prop('lineHeight', lineHeightOf);
prop('letterSpacing', spacingOf);
prop('wordSpacing', spacingOf);
enumProp('textAlign', ['left', 'right', 'center', 'justify', 'start', 'end']);
enumProp('textTransform', ['none', 'uppercase', 'lowercase', 'capitalize']);
prop('textDecoration', textDecorationOf);
prop('textShadow', textShadowOf);
enumProp('whiteSpace', ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);

// ---- SVG presentation properties ----

function fallbackPaint(t: Tok): ColorValue | 'none' {
  if (isKw(t, 'none')) return 'none';
  return requireColor(t);
}

function paintOf(toks: Tok[]): SvgPaint {
  const first = toks[0]!;
  if (first.type === 'url') {
    if (toks.length > 2) return fail('a paint takes a url() and one fallback');
    return toks[1] ? { url: first.str, fallback: fallbackPaint(toks[1]) } : { url: first.str };
  }
  if (toks.length !== 1) return fail('expected one paint value');
  if (isKw(first, 'context-fill', 'context-stroke')) return fail(`\`${first.text}\` is not supported`);
  return fallbackPaint(first);
}
prop('fill', paintOf);
prop('stroke', paintOf);
prop('fillOpacity', (toks) => Math.min(1, Math.max(0, numberOrPercent(single(toks)))));
prop('strokeOpacity', (toks) => Math.min(1, Math.max(0, numberOrPercent(single(toks)))));
prop('strokeWidth', (toks) => lengthOf(single(toks), { negative: false, unitless: true }));
enumProp('strokeLinecap', ['butt', 'round', 'square']);
enumProp('strokeLinejoin', ['miter', 'round', 'bevel', 'arcs', 'miter-clip']);
enumProp('fillRule', ['nonzero', 'evenodd']);
prop('strokeDasharray', (toks): Length[] | 'none' => {
  if (toks.length === 1 && isKw(toks[0], 'none')) return 'none';
  return toks.filter((t) => t.type !== 'comma').map((t) => lengthOf(t, { negative: false, unitless: true }));
});

// ---- ignored properties, and name handling ----

/** Properties that do not change the picture (docs/COMPAT.md §4.1). */
const IGNORED = new Set([
  'pointerEvents', 'cursor', 'userSelect', 'willChange', 'contain', 'isolation', 'backfaceVisibility', 'fontDisplay',
  'WebkitFontSmoothing', 'MozOsxFontSmoothing', 'textRendering', 'imageRendering',
]);

/** React's unitless properties: a number stays a plain number instead of becoming px. */
const UNITLESS = new Set([
  'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice', 'borderImageWidth', 'boxFlex',
  'boxFlexGroup', 'boxOrdinalGroup', 'columnCount', 'columns', 'flex', 'flexGrow', 'flexPositive', 'flexShrink',
  'flexNegative', 'flexOrder', 'gridArea', 'gridRow', 'gridRowEnd', 'gridRowSpan', 'gridRowStart', 'gridColumn',
  'gridColumnEnd', 'gridColumnSpan', 'gridColumnStart', 'fontWeight', 'lineClamp', 'lineHeight', 'opacity', 'order',
  'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'floodOpacity', 'stopOpacity',
  'strokeDasharray', 'strokeDashoffset', 'strokeMiterlimit', 'strokeOpacity', 'strokeWidth',
]);

const VENDOR_PREFIX = /^(Webkit|ms|Moz|O)(?=[A-Z])/;

function isUnitless(name: string): boolean {
  const bare = name.replace(VENDOR_PREFIX, '');
  return UNITLESS.has(bare === name ? name : bare.charAt(0).toLowerCase() + bare.slice(1));
}

/** `background-color` and `-webkit-mask-image` to React's `backgroundColor` and `WebkitMaskImage`. */
function reactName(name: string): string {
  if (!name.includes('-') || name.startsWith('--')) return name;
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return camel.startsWith('-') ? camel.charAt(1).toUpperCase() + camel.slice(2) : camel;
}

/** The name a handler is registered under: `WebkitMaskImage` folds into `maskImage`. */
function foldName(name: string): string {
  if (HANDLERS.has(name) || IGNORED.has(name)) return name;
  const m = /^Webkit([A-Z].*)$/.exec(name);
  if (!m) return name;
  const folded = m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1);
  return HANDLERS.has(folded) || IGNORED.has(folded) ? folded : name;
}

/** The value as the browser would receive it from React: a number gets `px` unless the property is unitless. */
function cssText(name: string, value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail(`${value} is not a finite number`);
    return value !== 0 && !isUnitless(name) ? `${value}px` : String(value);
  }
  if (typeof value === 'string') return value;
  return fail(`a ${typeof value} is not a style value`);
}

/**
 * Parses an inline style object as React hands it to the DOM. Properties apply in key order, so a longhand after a
 * shorthand overrides it. `null`, `undefined`, booleans and `''` leave a property unset, as React does; custom
 * properties (`--x`) have no effect on their own (`var()` is what reads them, and that is a diagnostic).
 */
export function parseStyle(style: Record<string, unknown>): { style: ParsedStyle; unsupported: Diagnostic[] } {
  const out: Mut = {};
  const unsupported: Diagnostic[] = [];
  for (const [rawName, value] of Object.entries(style)) {
    const name = reactName(rawName);
    if (name.startsWith('--')) continue;
    const key = foldName(name);
    if (IGNORED.has(key)) continue;
    const handler = HANDLERS.get(key);
    const given = typeof value === 'string' || typeof value === 'number' ? String(value) : Object.prototype.toString.call(value);
    try {
      const text = cssText(name, value);
      if (text === null) continue;
      if (!handler) return fail('not supported');
      handler(lex(text), out);
    } catch (e) {
      if (!(e instanceof CssError)) throw e;
      unsupported.push({ property: rawName, value: given, reason: e.message });
    }
  }
  // A side whose style is none or hidden has no width, whatever was specified.
  const styles = out.borderStyle as string[] | undefined;
  if (styles) {
    out.borderWidth = (out.borderWidth as Length[]).map((w, i) =>
      styles[i] === 'none' || styles[i] === 'hidden' ? { unit: 'px', value: 0 } : w,
    );
  }
  return { style: out as ParsedStyle, unsupported };
}
