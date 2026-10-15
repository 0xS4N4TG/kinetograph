// Images and gradients (CSS Images 3 and 4), and the `background` / `mask` layer properties (CSS Backgrounds 3,
// CSS Masking 1).

import { colorOf } from './color.js';
import { type Tok, fail, isKw, isLengthLike, nameOf, splitCommas } from './tokens.js';
import type {
  BackgroundImage,
  BackgroundSize,
  ColorStop,
  ColorValue,
  Corner,
  Length,
  LengthOrAuto,
  RadialSize,
} from './types.js';
import { angleOf, isAngle, lengthOf, positionOf } from './values.js';

const CENTER: [Length, Length] = [
  { unit: '%', value: 50 },
  { unit: '%', value: 50 },
];

// ---- colour stops ----

function stopsOf(segs: Tok[][], conic: boolean): ColorStop[] {
  const stops: ColorStop[] = [];
  const position = (t: Tok): Length => {
    if (conic) {
      if (t.type === 'percent') return { unit: '%', value: t.value };
      if (isAngle(t)) return { unit: '%', value: (angleOf(t) / 360) * 100 };
      return fail(`expected an angle or percentage, found \`${t.text}\``);
    }
    return lengthOf(t);
  };
  for (const seg of segs) {
    const color = colorOf(seg[0]);
    if (color === null) {
      if (seg.length === 1 && (isLengthLike(seg[0]) || isAngle(seg[0]))) {
        return fail('colour hints (transition midpoints) are not supported');
      }
      return fail(`expected a colour stop, found \`${seg.map((t) => t.text).join(' ')}\``);
    }
    if (seg.length > 3) return fail(`a colour stop takes a colour and at most two positions, found \`${seg.map((t) => t.text).join(' ')}\``);
    if (seg.length === 1) stops.push({ color, position: null });
    else for (const t of seg.slice(1)) stops.push({ color, position: position(t) });
  }
  if (stops.length === 0) return fail('a gradient needs a colour stop');
  return stops;
}

// ---- gradients ----

const SIDE_ANGLE: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function linearDirection(prelude: Tok[]): number | Corner {
  if (prelude.some((t) => isKw(t, 'in'))) return fail('a colour interpolation space (`in …`) is not supported');
  if (isKw(prelude[0], 'to')) {
    const sides = prelude.slice(1);
    if (!sides.every((t) => t.type === 'ident' && Object.hasOwn(SIDE_ANGLE, t.name))) return fail('`to` takes side or corner keywords');
    const names = sides.map((t) => (t as Extract<Tok, { type: 'ident' }>).name);
    if (names.length === 1) return SIDE_ANGLE[names[0]!]!;
    if (names.length === 2) {
      const vertical = names.find((n) => n === 'top' || n === 'bottom');
      const horizontal = names.find((n) => n === 'left' || n === 'right');
      if (vertical && horizontal) return `${vertical} ${horizontal}` as Corner;
    }
    return fail('`to` takes one side or one vertical and one horizontal keyword');
  }
  if (prelude.length === 1 && isAngle(prelude[0])) return angleOf(prelude[0]);
  return fail(`unexpected \`${prelude.map((t) => t.text).join(' ')}\` before the colour stops`);
}

function radialPrelude(prelude: Tok[]): { shape: 'circle' | 'ellipse'; size: RadialSize; cx: Length; cy: Length } {
  if (prelude.some((t) => isKw(t, 'in'))) return fail('a colour interpolation space (`in …`) is not supported');
  const { before, at } = (() => {
    const i = prelude.findIndex((t) => isKw(t, 'at'));
    return i < 0 ? { before: prelude, at: null } : { before: prelude.slice(0, i), at: prelude.slice(i + 1) };
  })();
  let shape: 'circle' | 'ellipse' | null = null;
  let keywordSize: RadialSize | null = null;
  const lengths: Tok[] = [];
  for (const t of before) {
    if (isKw(t, 'circle', 'ellipse')) {
      if (shape) return fail('the gradient shape is given twice');
      shape = nameOf(t) as 'circle' | 'ellipse';
    } else if (isKw(t, 'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner')) {
      if (keywordSize || lengths.length) return fail('the gradient size is given twice');
      keywordSize = nameOf(t) as RadialSize;
    } else if (isLengthLike(t)) {
      if (keywordSize) return fail('the gradient size is given twice');
      lengths.push(t);
    } else {
      return fail(`unexpected \`${t.text}\` in a radial gradient`);
    }
  }
  let size: RadialSize = keywordSize ?? 'farthest-corner';
  if (lengths.length > 0) {
    if (lengths.length > 2) return fail('a radial gradient size takes at most two lengths');
    if (lengths.length === 1) {
      if (shape === 'ellipse') return fail('an ellipse needs two radii');
      shape = 'circle';
      const r = lengthOf(lengths[0], { percent: false, negative: false });
      size = [r, r];
    } else {
      if (shape === 'circle') return fail('a circle takes one radius');
      shape = 'ellipse';
      size = [lengthOf(lengths[0], { negative: false }), lengthOf(lengths[1], { negative: false })];
    }
  }
  const [cx, cy] = at ? positionOf(at) : CENTER;
  return { shape: shape ?? 'ellipse', size, cx, cy };
}

function conicPrelude(prelude: Tok[]): { angle: number; cx: Length; cy: Length } {
  if (prelude.some((t) => isKw(t, 'in'))) return fail('a colour interpolation space (`in …`) is not supported');
  let rest = prelude;
  let angle = 0;
  if (isKw(rest[0], 'from')) {
    angle = angleOf(rest[1]);
    rest = rest.slice(2);
  }
  let at: Tok[] = [];
  if (rest.length) {
    if (!isKw(rest[0], 'at')) return fail(`unexpected \`${rest.map((t) => t.text).join(' ')}\` in a conic gradient`);
    at = rest.slice(1);
  }
  const [cx, cy] = at.length ? positionOf(at) : CENTER;
  return { angle, cx, cy };
}

const GRADIENTS = new Set([
  'linear-gradient', 'repeating-linear-gradient', 'radial-gradient', 'repeating-radial-gradient', 'conic-gradient',
  'repeating-conic-gradient',
]);

function gradientOf(t: Extract<Tok, { type: 'function' }>): BackgroundImage {
  if (!GRADIENTS.has(t.name)) {
    if (/^-(webkit|moz|o)-(repeating-)?(linear|radial)-gradient$/.test(t.name)) return fail(`the prefixed gradient ${t.name}() is not supported`);
    return fail(`the image function ${t.name}() is not supported`);
  }
  const repeating = t.name.startsWith('repeating-');
  const kind = t.name.replace('repeating-', '').replace('-gradient', '') as 'linear' | 'radial' | 'conic';
  if (t.args.length === 0) return fail(`${t.name}() needs colour stops`);
  const segs = splitCommas(t.args);
  // A first item that is not a colour is the direction, shape or angle.
  const hasPrelude = colorOf(segs[0]![0]) === null;
  const prelude = hasPrelude ? segs[0]! : [];
  const stops = stopsOf(hasPrelude ? segs.slice(1) : segs, kind === 'conic');
  if (kind === 'linear') {
    return { kind, angle: hasPrelude ? linearDirection(prelude) : 180, stops, repeating };
  }
  if (kind === 'radial') return { kind, ...radialPrelude(prelude), stops, repeating };
  return { kind, ...conicPrelude(prelude), stops, repeating };
}

/** An `<image>` token: a gradient or `url()`, `'none'` for `none`, `null` for anything else. */
export function imageOf(t: Tok | undefined): BackgroundImage | 'none' | null {
  if (!t) return null;
  if (t.type === 'url') return { kind: 'url', url: t.str };
  if (t.type === 'function') return gradientOf(t);
  if (t.type === 'ident' && t.name === 'none') return 'none';
  return null;
}

/** `background-image` / `mask-image`: a comma list of images; `none` is the empty list. */
export function imageListOf(toks: Tok[]): BackgroundImage[] {
  const segs = splitCommas(toks);
  const images = segs.map((s) => {
    if (s.length !== 1) return fail(`expected one image per layer, found \`${s.map((t) => t.text).join(' ')}\``);
    const image = imageOf(s[0]);
    if (image === null) return fail(`expected an image, found \`${s[0]!.text}\``);
    return image;
  });
  if (images.length === 1 && images[0] === 'none') return [];
  if (images.includes('none')) return fail('`none` among several image layers is not supported');
  return images as BackgroundImage[];
}

// ---- size, position and repeat ----

const AUTO: LengthOrAuto = 'auto';

export function backgroundSizeOf(toks: Tok[]): BackgroundSize {
  if (toks.length === 1 && isKw(toks[0], 'cover', 'contain')) return nameOf(toks[0]) as 'cover' | 'contain';
  if (toks.length < 1 || toks.length > 2) return fail(`expected cover, contain or 1 to 2 sizes, found ${toks.length} values`);
  const one = (t: Tok): LengthOrAuto => (isKw(t, 'auto') ? AUTO : lengthOf(t, { negative: false }));
  return [one(toks[0]!), toks[1] ? one(toks[1]) : AUTO];
}

export function sizeListOf(toks: Tok[]): BackgroundSize[] {
  return splitCommas(toks).map(backgroundSizeOf);
}

export function positionListOf(toks: Tok[]): [Length, Length][] {
  return splitCommas(toks).map(positionOf);
}

const REPEAT_KEYWORDS = ['repeat', 'no-repeat', 'space', 'round'];

/** One `<repeat-style>`: `repeat-x`, `repeat-y`, or one or two of `repeat`, `no-repeat`, `space`, `round`. */
export function repeatOf(toks: Tok[]): string {
  const names = toks.map((t) => (t.type === 'ident' ? t.name : ''));
  if (names.length === 1 && (names[0] === 'repeat-x' || names[0] === 'repeat-y')) return names[0];
  if (names.length < 1 || names.length > 2 || !names.every((n) => REPEAT_KEYWORDS.includes(n))) {
    return fail(`\`${toks.map((t) => t.text).join(' ')}\` is not a repeat style`);
  }
  if (names.length === 1 || names[0] === names[1]) return names[0]!;
  if (names[0] === 'repeat' && names[1] === 'no-repeat') return 'repeat-x';
  if (names[0] === 'no-repeat' && names[1] === 'repeat') return 'repeat-y';
  return names.join(' ');
}

export function repeatListOf(toks: Tok[]): string[] {
  return splitCommas(toks).map(repeatOf);
}

// ---- the background shorthand ----

export interface BackgroundLayers {
  color: ColorValue;
  images: BackgroundImage[];
  size: BackgroundSize[];
  position: [Length, Length][];
  repeat: string[];
  origin: 'border-box' | 'padding-box' | 'content-box';
  clip: 'border-box' | 'padding-box' | 'content-box' | 'text';
}

type Box = 'border-box' | 'padding-box' | 'content-box';
const BOXES = ['border-box', 'padding-box', 'content-box'];
const POSITION_KEYWORDS = ['left', 'right', 'top', 'bottom', 'center'];

interface Layer {
  image: BackgroundImage | 'none';
  position: [Length, Length];
  size: BackgroundSize;
  repeat: string;
  origin: Box;
  clip: Box | 'text';
  color: ColorValue | null;
}

function layerOf(toks: Tok[]): Layer {
  let image: BackgroundImage | 'none' | null = null;
  let position: [Length, Length] | null = null;
  let size: BackgroundSize | null = null;
  let repeat: string | null = null;
  let color: ColorValue | null = null;
  const boxes: string[] = [];
  let attachment = false;
  let i = 0;
  const once = <T>(slot: T | null, what: string): void => {
    if (slot !== null) fail(`${what} appears twice in a background layer`);
  };
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.type === 'url' || isKw(t, 'none') || (t.type === 'function' && colorOf(t) === null)) {
      once(image, 'an image');
      image = imageOf(t);
      i++;
    } else if (isKw(t, 'repeat-x', 'repeat-y', ...REPEAT_KEYWORDS)) {
      once(repeat, 'a repeat style');
      const two = isKw(toks[i + 1], ...REPEAT_KEYWORDS) && !isKw(t, 'repeat-x', 'repeat-y');
      repeat = repeatOf(two ? [t, toks[i + 1]!] : [t]);
      i += two ? 2 : 1;
    } else if (isKw(t, 'scroll')) {
      if (attachment) return fail('an attachment appears twice in a background layer');
      attachment = true;
      i++;
    } else if (isKw(t, 'fixed', 'local')) {
      return fail(`background-attachment \`${t.text}\` is not supported`);
    } else if (isKw(t, ...BOXES, 'text')) {
      if (boxes.length === 2) return fail('a background layer takes at most two boxes');
      boxes.push(nameOf(t));
      i++;
    } else if (isKw(t, ...POSITION_KEYWORDS) || isLengthLike(t)) {
      once(position, 'a position');
      let j = i;
      while (j < toks.length && (isKw(toks[j], ...POSITION_KEYWORDS) || isLengthLike(toks[j]))) j++;
      position = positionOf(toks.slice(i, j));
      i = j;
      if (toks[i]?.type === 'slash') {
        let k = i + 1;
        while (k < toks.length && (isKw(toks[k], 'auto', 'cover', 'contain') || isLengthLike(toks[k]))) k++;
        size = backgroundSizeOf(toks.slice(i + 1, k));
        i = k;
      }
    } else {
      const c = colorOf(t);
      if (c === null) return fail(`unexpected \`${t.text}\` in a background`);
      once(color, 'a colour');
      color = c;
      i++;
    }
  }
  let origin: Box = 'padding-box';
  let clip: Box | 'text' = 'border-box';
  if (boxes.length === 1) {
    if (boxes[0] === 'text') clip = 'text';
    else origin = clip = boxes[0] as Box;
  } else if (boxes.length === 2) {
    if (boxes[0] === 'text') return fail('`text` can only be the background clip');
    origin = boxes[0] as Box;
    clip = boxes[1] as Box | 'text';
  }
  return {
    image: image ?? 'none',
    position: position ?? [
      { unit: '%', value: 0 },
      { unit: '%', value: 0 },
    ],
    size: size ?? [AUTO, AUTO],
    repeat: repeat ?? 'repeat',
    origin,
    clip,
    color,
  };
}

/** The `background` shorthand: every layer, with the colour on the last one. Unset parts take their initial values. */
export function backgroundShorthandOf(toks: Tok[]): BackgroundLayers {
  const layers = splitCommas(toks).map(layerOf);
  const last = layers.length - 1;
  layers.forEach((l, i) => {
    if (l.color !== null && i !== last) fail('only the last background layer takes a colour');
  });
  // A layer without an image paints nothing; at the end of the list (a colour-only last layer) it can be dropped, but
  // in the middle it would shift the layers that follow.
  const images = layers.map((l) => l.image);
  while (images.length > 0 && images[images.length - 1] === 'none') images.pop();
  if (images.includes('none')) return fail('`none` among several background layers is not supported');
  const kept = layers.slice(0, Math.max(images.length, 1));
  const origin = layers[0]!.origin;
  const clip = layers[0]!.clip;
  if (layers.some((l) => l.origin !== origin || l.clip !== clip)) return fail('a different background-origin or background-clip per layer is not supported');
  return {
    color: layers[last]!.color ?? { r: 0, g: 0, b: 0, a: 0 },
    images: images as BackgroundImage[],
    size: kept.map((l) => l.size),
    position: kept.map((l) => l.position),
    repeat: kept.map((l) => l.repeat),
    origin,
    clip,
  };
}
