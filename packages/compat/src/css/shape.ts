// `border-radius` and `clip-path` basic shapes (CSS Backgrounds 3, CSS Masking 1, CSS Shapes 1).

import { type Tok, fail, isKw, splitCommas } from './tokens.js';
import type { ClipShape, Corners, Length, ShapeRadius, Sides } from './types.js';
import { expandSides, lengthOf, positionOf } from './values.js';

const ZERO: Length = { unit: 'px', value: 0 };
export const zeroCorners = (): Corners => [[ZERO, ZERO], [ZERO, ZERO], [ZERO, ZERO], [ZERO, ZERO]];

/** `<length-percentage>{1,4} [ / <length-percentage>{1,4} ]?`, as the four corners (top-left first) of [horizontal, vertical]. */
export function borderRadiusOf(toks: Tok[]): Corners {
  const slash = toks.findIndex((t) => t.type === 'slash');
  const side = (part: Tok[]): Sides<Length> => {
    if (part.length === 0) return fail('expected a radius');
    return expandSides(part.map((t) => lengthOf(t, { negative: false })));
  };
  const h = side(slash < 0 ? toks : toks.slice(0, slash));
  const v = slash < 0 ? h : side(toks.slice(slash + 1));
  // `expandSides` yields top, right, bottom, left; for radii these are top-left, top-right, bottom-right, bottom-left.
  return [[h[0], v[0]], [h[1], v[1]], [h[2], v[2]], [h[3], v[3]]];
}

/** One corner longhand (`border-top-left-radius`): one or two values. */
export function cornerRadiusOf(toks: Tok[]): [Length, Length] {
  if (toks.length < 1 || toks.length > 2) return fail(`expected 1 or 2 values, found ${toks.length}`);
  const h = lengthOf(toks[0], { negative: false });
  return [h, toks[1] ? lengthOf(toks[1], { negative: false }) : h];
}

const REFERENCE_BOXES = ['border-box', 'padding-box', 'content-box', 'margin-box', 'fill-box', 'stroke-box', 'view-box'];

function shapeRadius(t: Tok | undefined): ShapeRadius {
  if (t && t.type === 'ident') {
    if (t.name === 'closest-side' || t.name === 'farthest-side') return t.name;
    return fail(`\`${t.text}\` is not a shape radius`);
  }
  return lengthOf(t, { negative: false });
}

/** Splits a shape's arguments at the `at` keyword. */
function splitAt(args: Tok[]): { before: Tok[]; at: Tok[] | null } {
  const i = args.findIndex((t) => isKw(t, 'at'));
  return i < 0 ? { before: args, at: null } : { before: args.slice(0, i), at: args.slice(i + 1) };
}

const CENTER: [Length, Length] = [
  { unit: '%', value: 50 },
  { unit: '%', value: 50 },
];

function fillRuleOf(segs: Tok[][], what: string): 'evenodd' | undefined {
  const first = segs[0]!;
  if (first.length === 1 && first[0]!.type === 'ident' && ['nonzero', 'evenodd'].includes(first[0]!.name)) {
    segs.shift();
    return first[0]!.name === 'evenodd' ? 'evenodd' : undefined;
  }
  if (first.length === 1 && first[0]!.type === 'ident') return fail(`\`${first[0]!.text}\` is not a fill rule in ${what}`);
  return undefined;
}

function shapeOf(t: Extract<Tok, { type: 'function' }>): ClipShape {
  const args = t.args;
  switch (t.name) {
    case 'inset': {
      const i = args.findIndex((a) => isKw(a, 'round'));
      const sides = i < 0 ? args : args.slice(0, i);
      if (sides.length < 1 || sides.length > 4) return fail(`inset() takes 1 to 4 lengths, found ${sides.length}`);
      const radius = i < 0 ? zeroCorners() : borderRadiusOf(args.slice(i + 1));
      return { kind: 'inset', sides: expandSides(sides.map((s) => lengthOf(s))), radius };
    }
    case 'circle': {
      const { before, at } = splitAt(args);
      if (before.length > 1) return fail('circle() takes one radius');
      const [cx, cy] = at ? positionOf(at) : CENTER;
      return { kind: 'circle', r: before.length ? shapeRadius(before[0]) : 'closest-side', cx, cy };
    }
    case 'ellipse': {
      const { before, at } = splitAt(args);
      if (before.length !== 0 && before.length !== 2) return fail('ellipse() takes two radii');
      const [cx, cy] = at ? positionOf(at) : CENTER;
      return {
        kind: 'ellipse',
        rx: before.length ? shapeRadius(before[0]) : 'closest-side',
        ry: before.length ? shapeRadius(before[1]) : 'closest-side',
        cx,
        cy,
      };
    }
    case 'polygon': {
      if (args.length === 0) return fail('polygon() needs at least one point');
      const segs = splitCommas(args);
      const fillRule = fillRuleOf(segs, 'polygon()');
      if (segs.length === 0) return fail('polygon() needs at least one point');
      const points = segs.map((s): [Length, Length] => {
        if (s.length !== 2) return fail('a polygon() point is two lengths');
        return [lengthOf(s[0]), lengthOf(s[1])];
      });
      return fillRule ? { kind: 'polygon', points, fillRule } : { kind: 'polygon', points };
    }
    case 'path': {
      if (args.length === 0) return fail('path() needs path data');
      const segs = splitCommas(args);
      const fillRule = fillRuleOf(segs, 'path()');
      if (segs.length !== 1 || segs[0]!.length !== 1 || segs[0]![0]!.type !== 'string') return fail('path() takes a quoted path string');
      const d = (segs[0]![0] as Extract<Tok, { type: 'string' }>).str;
      if (d.trim() === '') return fail('path() data is empty');
      return fillRule ? { kind: 'path', d, fillRule } : { kind: 'path', d };
    }
    case 'rect':
    case 'xywh':
      return fail(`${t.name}() is not supported`);
    default:
      return fail(`the shape function ${t.name}() is not supported`);
  }
}

/** A `clip-path` value: a basic shape (with an optional `border-box` reference box) or `none`. */
export function clipPathOf(toks: Tok[]): ClipShape | 'none' {
  if (toks.length === 1 && isKw(toks[0], 'none')) return 'none';
  let shape: ClipShape | null = null;
  for (const t of toks) {
    if (t.type === 'url') return fail('`url()` clip paths are not supported');
    if (t.type === 'function') {
      if (shape) return fail('a clip-path holds one shape');
      shape = shapeOf(t);
    } else if (t.type === 'ident' && REFERENCE_BOXES.includes(t.name)) {
      if (t.name !== 'border-box') return fail(`the reference box \`${t.name}\` is not supported; only border-box is`);
    } else {
      return fail(`unexpected \`${t.text}\` in a clip-path`);
    }
  }
  if (!shape) return fail('a reference box without a shape is not supported');
  return shape;
}
