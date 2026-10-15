// What a box paints (docs/COMPAT.md §4.2): gradients and pictures for `background-image` and `mask-image`, box and
// text shadows, `filter`, `clip-path`.

import type { Clip, Effect, Gradient, LayerJson, Stop } from '@kinetograph/scene';
import type {
  BackgroundImage,
  BackgroundSize,
  BoxShadow,
  ClipShape,
  ColorStop,
  ColorValue,
  FilterOp,
  Length,
  Rgba,
  TextShadow,
} from '../css/types.js';
import { boxPath, boxShape, hasRadii, NO_RADII, resolveRadii, type Radii } from './shapes.js';
import { hex, px, r3, type LengthEnv } from './util.js';

/** Reports something this mapping cannot draw: the property, its value and why. */
export type Bad = (property: string, value: string, reason: string) => void;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-6;

const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};

export function colorString(value: ColorValue, current: Rgba, alphaScale = 1): string {
  return hex(value === 'currentcolor' ? current : value, alphaScale);
}

/** The boxes of an element, in px, in the border box's own space (its top-left corner is the origin). */
export interface BoxGeometry {
  width: number;
  height: number;
  /** top, right, bottom, left */
  border: [number, number, number, number];
  padding: [number, number, number, number];
  /** Outer border radii. */
  radii: Radii;
}

export function borderBox(g: BoxGeometry): Rect {
  return { x: 0, y: 0, w: g.width, h: g.height };
}
export function paddingBox(g: BoxGeometry): Rect {
  const [t, r, b, l] = g.border;
  return { x: l, y: t, w: Math.max(0, g.width - l - r), h: Math.max(0, g.height - t - b) };
}
export function contentBox(g: BoxGeometry): Rect {
  const [t, r, b, l] = g.border;
  const [pt, pr, pb, pl] = g.padding;
  return {
    x: l + pl,
    y: t + pt,
    w: Math.max(0, g.width - l - r - pl - pr),
    h: Math.max(0, g.height - t - b - pt - pb),
  };
}

/** The corner radii of the edge `inset` px inside the border box (top, right, bottom, left). */
export function innerRadii(radii: Radii, inset: [number, number, number, number]): Radii {
  const [t, r, b, l] = inset;
  const cut = (value: number, by: number): number => Math.max(0, value - by);
  const corner = (h: number, v: number, hBy: number, vBy: number): [number, number] => {
    const nh = cut(h, hBy);
    const nv = cut(v, vBy);
    return nh > 0 && nv > 0 ? [nh, nv] : [0, 0];
  };
  return {
    tl: corner(radii.tl[0], radii.tl[1], l, t),
    tr: corner(radii.tr[0], radii.tr[1], r, t),
    br: corner(radii.br[0], radii.br[1], r, b),
    bl: corner(radii.bl[0], radii.bl[1], l, b),
  };
}

export type Region = 'border-box' | 'padding-box' | 'content-box';

/** A region of the box and the radii of its edge. */
export function region(g: BoxGeometry, which: Region): { rect: Rect; radii: Radii } {
  if (which === 'border-box') return { rect: borderBox(g), radii: g.radii };
  const [bt, br, bb, bl] = g.border;
  if (which === 'padding-box') return { rect: paddingBox(g), radii: innerRadii(g.radii, [bt, br, bb, bl]) };
  const [pt, pr, pb, pl] = g.padding;
  return { rect: contentBox(g), radii: innerRadii(g.radii, [bt + pt, br + pr, bb + pb, bl + pl]) };
}

// ---- gradients ----

/** CSS's colour stop positions: the first defaults to 0 and the last to 1, none goes back, and a run of unplaced
 *  stops is spread evenly between the stops around it. `fraction` turns a stop's position into 0..1 (null: invalid). */
export function resolveStops(
  stops: readonly ColorStop[],
  fraction: (length: Length) => number | null,
  current: Rgba,
): Stop[] | null {
  const n = stops.length;
  const at: (number | null)[] = [];
  for (const stop of stops) {
    if (stop.position === null) {
      at.push(null);
      continue;
    }
    const f = fraction(stop.position);
    if (f === null) return null;
    at.push(f);
  }
  if (at[0] === null) at[0] = 0;
  if (at[n - 1] === null) at[n - 1] = 1;
  let highest = at[0]!;
  for (let i = 0; i < n; i += 1) {
    if (at[i] !== null) {
      at[i] = Math.max(at[i]!, highest);
      highest = at[i]!;
    }
  }
  for (let i = 0; i < n; i += 1) {
    if (at[i] !== null) continue;
    let j = i;
    while (at[j] === null) j += 1;
    const from = at[i - 1]!;
    const to = at[j]!;
    for (let k = i; k < j; k += 1) at[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return stops.map((stop, i) => ({ offset: Math.round(at[i]! * 1e6) / 1e6, color: colorString(stop.color, current) }));
}

function radialRadii(
  image: Extract<BackgroundImage, { kind: 'radial' }>,
  tile: Rect,
  cx: number,
  cy: number,
  env: LengthEnv,
): [number, number] | null {
  const left = Math.abs(cx - tile.x);
  const right = Math.abs(tile.x + tile.w - cx);
  const top = Math.abs(cy - tile.y);
  const bottom = Math.abs(tile.y + tile.h - cy);
  const size = image.size;
  if (Array.isArray(size)) {
    const rx = px(size[0], env, tile.w);
    const ry = image.shape === 'circle' ? rx : px(size[1], env, tile.h);
    return [rx, ry];
  }
  if (image.shape === 'circle') {
    const corners = [Math.hypot(left, top), Math.hypot(right, top), Math.hypot(left, bottom), Math.hypot(right, bottom)];
    const r =
      size === 'closest-side'
        ? Math.min(left, right, top, bottom)
        : size === 'farthest-side'
          ? Math.max(left, right, top, bottom)
          : size === 'closest-corner'
            ? Math.min(...corners)
            : Math.max(...corners);
    return [r, r];
  }
  // An ellipse: the radii of the side keywords, and for a corner keyword the same ratio through the corner.
  const closest: [number, number] = [Math.min(left, right), Math.min(top, bottom)];
  const farthest: [number, number] = [Math.max(left, right), Math.max(top, bottom)];
  if (size === 'closest-side') return closest;
  if (size === 'farthest-side') return farthest;
  const base = size === 'closest-corner' ? closest : farthest;
  return [base[0] * Math.SQRT2, base[1] * Math.SQRT2];
}

/**
 * The scene gradient for a CSS gradient painted over `tile`, a rectangle in the painted shape's own space (the
 * shape's top-left corner is the origin). `shape` is the size of that shape, for gradients in box units.
 * Null (after reporting) when it cannot be drawn.
 */
export function gradientFor(
  image: Exclude<BackgroundImage, { kind: 'url' }>,
  tile: Rect,
  shape: { w: number; h: number },
  env: LengthEnv,
  current: Rgba,
  bad: Bad,
  property: string,
): Gradient | null {
  const extend = image.repeating ? ({ extend: 'repeat' } as const) : {};
  const fail = (reason: string): null => {
    bad(property, image.kind, reason);
    return null;
  };

  if (image.kind === 'linear') {
    const cx = tile.x + tile.w / 2;
    const cy = tile.y + tile.h / 2;
    let dx: number;
    let dy: number;
    if (typeof image.angle === 'number') {
      const a = (image.angle * Math.PI) / 180;
      dx = Math.sin(a);
      dy = -Math.cos(a);
    } else {
      // "to top right" and so on: the 50% line passes through the other two corners.
      const sx = image.angle.includes('right') ? 1 : -1;
      const sy = image.angle.includes('bottom') ? 1 : -1;
      const len = Math.hypot(tile.w, tile.h) || 1;
      dx = (sx * tile.h) / len;
      dy = (sy * tile.w) / len;
    }
    const length = Math.abs(tile.w * dx) + Math.abs(tile.h * dy);
    const stops = resolveStops(
      image.stops,
      (l) => (l.unit === '%' ? l.value / 100 : length > 0 ? px(l, env, 0) / length : 0),
      current,
    );
    if (stops === null) return fail('colour stop position');
    return {
      type: 'linear',
      x0: r3(cx - (dx * length) / 2),
      y0: r3(cy - (dy * length) / 2),
      x1: r3(cx + (dx * length) / 2),
      y1: r3(cy + (dy * length) / 2),
      stops,
      ...extend,
    };
  }

  const cx = tile.x + px(image.cx, env, tile.w);
  const cy = tile.y + px(image.cy, env, tile.h);

  if (image.kind === 'radial') {
    const radii = radialRadii(image, tile, cx, cy, env);
    if (radii === null) return fail('size');
    const [rx, ry] = radii;
    const stopsAt = (reference: number) =>
      resolveStops(image.stops, (l) => (l.unit === '%' ? l.value / 100 : reference > 0 ? px(l, env, 0) / reference : 0), current);
    if (Math.abs(rx - ry) < 1e-6 * Math.max(1, rx)) {
      const stops = stopsAt(rx);
      if (stops === null) return fail('colour stop position');
      return { type: 'radial', cx: r3(cx), cy: r3(cy), r: r3(rx), stops, ...extend };
    }
    // An ellipse is a circle in box units, whose box is the shape's: it needs the ellipse's shape to be the box's.
    if (shape.w > 0 && shape.h > 0 && Math.abs(rx / ry - shape.w / shape.h) < 1e-4 * (shape.w / shape.h)) {
      const stops = stopsAt(rx);
      if (stops === null) return fail('colour stop position');
      return { type: 'radial', units: 'box', cx: r3(cx / shape.w * 1e3) / 1e3, cy: r3(cy / shape.h * 1e3) / 1e3, r: r3((rx / shape.w) * 1e3) / 1e3, stops, ...extend };
    }
    return fail('an ellipse whose shape is not the box');
  }

  // conic: positions are shares of the turn.
  const stops = resolveStops(image.stops, (l) => (l.unit === '%' ? l.value / 100 : null), current);
  if (stops === null) return fail('colour stop position (only percentages of the turn are drawn)');
  return { type: 'conic', cx: r3(cx), cy: r3(cy), angle: image.angle, stops, ...extend };
}

// ---- background layers ----

export interface LayerPaint {
  /** Painted image, size, position, repeat of one layer of `background-*` or `mask-*`. */
  image: BackgroundImage;
  size: BackgroundSize | undefined;
  position: [Length, Length] | undefined;
  repeat: string | undefined;
}

/** The size of the tile, or null for a picture of natural size, which is not known here. */
function tileSize(
  image: BackgroundImage,
  size: BackgroundSize | undefined,
  area: Rect,
  env: LengthEnv,
): { w: number; h: number; natural?: boolean } | { natural: true } {
  if (size === undefined || size === 'cover' || size === 'contain') {
    if (image.kind === 'url' && size === undefined) return { natural: true };
    return { w: area.w, h: area.h };
  }
  const [sw, sh] = size;
  if (image.kind === 'url' && (sw === 'auto' || sh === 'auto')) return { natural: true };
  return { w: sw === 'auto' ? area.w : px(sw, env, area.w), h: sh === 'auto' ? area.h : px(sh, env, area.h) };
}

export interface BackgroundOptions {
  /** Where the gradient or picture is positioned: the `background-origin` box. */
  area: Rect;
  /** Where it is painted: the `background-clip` box and its radii. */
  clip: { rect: Rect; radii: Radii };
  env: LengthEnv;
  current: Rgba;
  bad: Bad;
  /** `background` or `mask`: the property named in reports. */
  property: string;
  /** The border area is covered by an opaque border, so a tile that stops at the padding box need not repeat. */
  borderCovers: boolean;
  /** `<node>.bg-0` and so on. */
  id: string;
}

/**
 * One layer of `background-image` (or a url `mask-image`): a shape filled with the gradient, or an image layer.
 * Positions are in the border box's space.
 */
export function backgroundLayer(item: LayerPaint, o: BackgroundOptions): LayerJson | null {
  const { image, size, position, repeat } = item;
  const fail = (property: string, value: string, reason: string): null => {
    o.bad(property, value, reason);
    return null;
  };
  const tileInfo = tileSize(image, size, o.area, o.env);
  const noRepeat = repeat === 'no-repeat';
  const fits = size === 'cover' || size === 'contain';

  if ('natural' in tileInfo) {
    // A picture at its own size: only drawn at the origin of its area, once.
    if (!noRepeat) return fail(`${o.property}Repeat`, repeat ?? 'repeat', 'a picture of its natural size repeats; use no-repeat');
    const at = position ?? [{ unit: 'px', value: 0 }, { unit: 'px', value: 0 }];
    const ax = px(at[0], o.env, 0);
    const ay = px(at[1], o.env, 0);
    if ((at[0].unit === '%' && at[0].value !== 0) || (at[1].unit === '%' && at[1].value !== 0)) {
      return fail(`${o.property}Position`, `${at[0].value}% ${at[1].value}%`, 'a percentage needs the size of the picture');
    }
    return imageLayer(o.id, image as Extract<BackgroundImage, { kind: 'url' }>, { x: o.area.x + ax, y: o.area.y + ay }, undefined, undefined, o);
  }

  // A tile of a known size at its position in the area.
  const at = position ?? [{ unit: 'px', value: 0 }, { unit: 'px', value: 0 }];
  if (fits) {
    const centre = at[0].unit === '%' && at[0].value === 50 && at[1].unit === '%' && at[1].value === 50;
    if (!centre) {
      return fail(`${o.property}Position`, `${at[0].value}${at[0].unit} ${at[1].value}${at[1].unit}`, `${size} is drawn centred`);
    }
  }
  const tile: Rect = {
    x: o.area.x + (at[0].unit === '%' ? ((o.area.w - tileInfo.w) * at[0].value) / 100 : px(at[0], o.env, 0)),
    y: o.area.y + (at[1].unit === '%' ? ((o.area.h - tileInfo.h) * at[1].value) / 100 : px(at[1], o.env, 0)),
    w: tileInfo.w,
    h: tileInfo.h,
  };

  let visible = o.clip.rect;
  if (noRepeat) {
    visible = intersect(tile, o.clip.rect);
  } else if (!contains(tile, o.clip.rect) && !o.borderCovers) {
    return fail(`${o.property}Repeat`, repeat ?? 'repeat', 'the tile is smaller than the painted area, so it would repeat; use no-repeat');
  }

  if (image.kind === 'url') {
    // cover / contain / explicit size: the image layer is the tile.
    const fit = size === 'cover' ? 'cover' : size === 'contain' ? 'contain' : 'fill';
    return imageLayer(o.id, image, { x: tile.x, y: tile.y }, tile.w, tile.h, o, fit);
  }

  // A gradient: a shape of the visible rectangle, with the clip region's rounding when it is that rectangle.
  const whole = contains(visible, o.clip.rect) && contains(o.clip.rect, visible);
  const radii = whole ? o.clip.radii : NO_RADII;
  const local: Rect = { x: tile.x - visible.x, y: tile.y - visible.y, w: tile.w, h: tile.h };
  const gradient = gradientFor(image, local, { w: visible.w, h: visible.h }, o.env, o.current, o.bad, o.property);
  if (gradient === null) return null;
  const layer: LayerJson = {
    id: o.id,
    type: 'shape',
    shape: boxShape(visible.w, visible.h, radii),
    fill: gradient,
    ...(visible.x !== 0 || visible.y !== 0 ? { transform: { x: r3(visible.x), y: r3(visible.y) } } : {}),
  };
  if (!whole && hasRadii(o.clip.radii)) {
    // The visible rectangle is part of a rounded region: cut it to the region's outline.
    layer.clip = { kind: 'path', d: boxPath(o.clip.rect.x - visible.x, o.clip.rect.y - visible.y, o.clip.rect.w, o.clip.rect.h, o.clip.radii) };
  }
  return layer;
}

function imageLayer(
  id: string,
  image: Extract<BackgroundImage, { kind: 'url' }>,
  at: { x: number; y: number },
  width: number | undefined,
  height: number | undefined,
  o: BackgroundOptions,
  fit?: 'fill' | 'contain' | 'cover',
): LayerJson {
  const layer: LayerJson = {
    id,
    type: 'image',
    src: image.url,
    ...(width !== undefined ? { width: r3(width) } : {}),
    ...(height !== undefined ? { height: r3(height) } : {}),
    ...(fit !== undefined && fit !== 'fill' ? { fit } : {}),
    ...(at.x !== 0 || at.y !== 0 ? { transform: { x: r3(at.x), y: r3(at.y) } } : {}),
  };
  // The picture may reach past the painted region, or the region may be rounded.
  const rect: Rect = { x: at.x, y: at.y, w: width ?? Infinity, h: height ?? Infinity };
  if (hasRadii(o.clip.radii) || !contains(o.clip.rect, rect)) {
    layer.clip = { kind: 'path', d: boxPath(o.clip.rect.x - at.x, o.clip.rect.y - at.y, o.clip.rect.w, o.clip.rect.h, o.clip.radii) };
  }
  return layer;
}

// ---- shadows ----

/** A box shadow as an effect. CSS's blur radius is twice the Gaussian's deviation, which is what `blur` is. */
function shadowEffect(
  type: 'dropShadow' | 'insetShadow',
  s: { x: Length; y: Length; blur: Length; spread?: Length; color: ColorValue },
  env: LengthEnv,
  current: Rgba,
): Effect {
  const effect: Record<string, unknown> = { type, x: r3(px(s.x, env)), y: r3(px(s.y, env)) };
  const blur = px(s.blur, env) / 2;
  if (blur !== 0) effect.blur = r3(blur);
  const spread = s.spread === undefined ? 0 : px(s.spread, env);
  if (spread !== 0) effect.spread = r3(spread);
  effect.color = colorString(s.color, current);
  return effect as unknown as Effect;
}

/** The effects for the shadows of `boxShadow`: the inset ones, then the outer ones, each list last first. */
export function boxShadowEffects(shadows: readonly BoxShadow[], env: LengthEnv, current: Rgba): { outer: Effect[]; inset: Effect[] } {
  const outer: Effect[] = [];
  const inset: Effect[] = [];
  for (const shadow of [...shadows].reverse()) {
    (shadow.inset ? inset : outer).push(shadowEffect(shadow.inset ? 'insetShadow' : 'dropShadow', shadow, env, current));
  }
  return { outer, inset };
}

export function textShadowEffects(shadows: readonly TextShadow[], env: LengthEnv, current: Rgba): Effect[] {
  return [...shadows].reverse().map((s) => shadowEffect('dropShadow', s, env, current));
}

// ---- filter ----

/** `filter` as effects, and the product of its `opacity()` functions. */
export function filterEffects(
  ops: readonly FilterOp[],
  env: LengthEnv,
  current: Rgba,
): { effects: Effect[]; opacity: number } {
  const effects: Effect[] = [];
  let opacity = 1;
  for (const op of ops) {
    switch (op.op) {
      case 'blur':
        effects.push({ type: 'blur', radius: r3(px(op.radius, env)) });
        break;
      case 'drop-shadow':
        effects.push(shadowEffect('dropShadow', { ...op, spread: undefined }, env, current));
        break;
      case 'hue-rotate':
        effects.push({ type: 'hueRotate', angle: op.angle });
        break;
      case 'opacity':
        opacity *= Math.max(0, Math.min(1, op.amount));
        break;
      default:
        effects.push({ type: op.op, amount: op.amount } as Effect);
    }
  }
  return { effects, opacity };
}

// ---- clip-path ----

/** `clip-path` as a scene clip on a group (a group has no box, so `inset()` is a path), in the border box's space. */
export function clipFor(shape: ClipShape, box: Rect, env: LengthEnv): Clip {
  const { w, h } = box;
  switch (shape.kind) {
    case 'inset': {
      const [t, r, b, l] = shape.sides;
      const top = px(t, env, h);
      const right = px(r, env, w);
      const bottom = px(b, env, h);
      const left = px(l, env, w);
      const inner: Rect = {
        x: box.x + left,
        y: box.y + top,
        w: Math.max(0, w - left - right),
        h: Math.max(0, h - top - bottom),
      };
      return { kind: 'path', d: boxPath(inner.x, inner.y, inner.w, inner.h, resolveRadii(shape.radius, inner.w, inner.h, env)) };
    }
    case 'circle': {
      const cx = px(shape.cx, env, w);
      const cy = px(shape.cy, env, h);
      const sides = [cx, w - cx, cy, h - cy].map(Math.abs);
      const r =
        shape.r === 'closest-side'
          ? Math.min(...sides)
          : shape.r === 'farthest-side'
            ? Math.max(...sides)
            : px(shape.r, env, Math.sqrt((w * w + h * h) / 2));
      return { kind: 'ellipse', cx: r3(box.x + cx), cy: r3(box.y + cy), rx: r3(r), ry: r3(r) };
    }
    case 'ellipse': {
      const cx = px(shape.cx, env, w);
      const cy = px(shape.cy, env, h);
      const radius = (value: typeof shape.rx, near: number, far: number, of: number): number =>
        value === 'closest-side' ? Math.min(Math.abs(near), Math.abs(far)) : value === 'farthest-side' ? Math.max(Math.abs(near), Math.abs(far)) : px(value, env, of);
      return {
        kind: 'ellipse',
        cx: r3(box.x + cx),
        cy: r3(box.y + cy),
        rx: r3(radius(shape.rx, cx, w - cx, w)),
        ry: r3(radius(shape.ry, cy, h - cy, h)),
      };
    }
    case 'polygon':
      return {
        kind: 'polygon',
        points: shape.points.map(([x, y]) => [r3(box.x + px(x, env, w)), r3(box.y + px(y, env, h))] as [number, number]),
      };
    case 'path':
      return { kind: 'path', d: shape.d };
  }
}
