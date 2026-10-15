// How a native element's common props become CSS (docs/COMPAT.md §6.2): the layer transform, opacity and blend mode,
// the effects CSS has, clip paths, and the flex layout. Pure functions of the props and the frame, so the markup is
// the same however the frames are visited.

import type { CSSProperties } from 'react';
import { evalNum, type Clip, type Effect, type Layout, type LayoutItem, type Num } from '@kinetograph/scene';
import type { CommonProps } from './props.js';

/** Reports what the Chrome frame leaves out; `key` makes it one warning however many frames repeat it. */
export type Warn = (key: string, message: string) => void;

/** A number rounded for markup: no float noise, no trailing zeros. */
export function fmt(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const px = (value: number): string => `${fmt(value)}px`;

/** An animatable number at `frame`; an absent one is `fallback`. */
export function num(value: Num | undefined, frame: number, fallback: number): number {
  return value === undefined ? fallback : evalNum(value, frame);
}

/** A list of `n` numbers (each possibly keyframes), as opposed to a list of keyframe objects, which is one number. */
function isList(value: unknown, n: number): value is Num[] {
  return Array.isArray(value) && value.length === n && value.every((v) => typeof v === 'number' || Array.isArray(v));
}

/** Padding or margin: `[top, right, bottom, left]`, or one number for all four sides. */
function sides(value: Num | [Num, Num, Num, Num], frame: number): string {
  if (isList(value, 4)) return value.map((v) => px(evalNum(v, frame))).join(' ');
  return px(evalNum(value as Num, frame));
}

// ---- the layer transform ----

export interface TransformCss {
  transform?: string;
  transformOrigin: string;
}

/**
 * SCENE.md "Layers" and "Transform origin" as CSS. The layer matrix is
 * `translate(x + ox, y + oy) rotate scale translate(-(anchorX + ox), -(anchorY + oy))`, with `(ox, oy)` the origin as
 * fractions of the layer's box. CSS applies `translate(P) <transform> translate(-P)` about `transform-origin: P`, so
 * with `P = (anchor + origin)` the transform is `translate(x - anchorX, y - anchorY) rotate scale`. A 3D turn and `z`
 * come after the 2D matrix, so they stand to its left. `hasBox` is false for a group without a layout, which has no
 * box and so ignores the origin.
 */
export function transformCss(props: CommonProps, frame: number, hasBox = true): TransformCss {
  const x = num(props.x, frame, 0);
  const y = num(props.y, frame, 0);
  const scale = num(props.scale, frame, 1);
  const rotation = num(props.rotation, frame, 0);
  const anchorX = num(props.anchorX, frame, 0);
  const anchorY = num(props.anchorY, frame, 0);
  const rotateX = num(props.rotateX, frame, 0);
  const rotateY = num(props.rotateY, frame, 0);
  const z = num(props.z, frame, 0);
  const centred = props.origin === 'center' ? [0.5, 0.5] : Array.isArray(props.origin) ? props.origin : [0, 0];
  const originX = hasBox ? num(props.originX, frame, centred[0] ?? 0) : 0;
  const originY = hasBox ? num(props.originY, frame, centred[1] ?? 0) : 0;

  const parts: string[] = [];
  if (x - anchorX !== 0 || y - anchorY !== 0) parts.push(`translate(${px(x - anchorX)}, ${px(y - anchorY)})`);
  if (z !== 0) parts.push(`translateZ(${px(z)})`);
  if (rotateY !== 0) parts.push(`rotateY(${fmt(rotateY)}deg)`);
  if (rotateX !== 0) parts.push(`rotateX(${fmt(rotateX)}deg)`);
  if (rotation !== 0) parts.push(`rotate(${fmt(rotation)}deg)`);
  if (scale !== 1) parts.push(`scale(${fmt(scale)})`);

  const axis = (anchor: number, origin: number): string => {
    if (origin === 0) return px(anchor);
    return anchor === 0 ? `${fmt(origin * 100)}%` : `calc(${px(anchor)} + ${fmt(origin * 100)}%)`;
  };
  const result: TransformCss = { transformOrigin: `${axis(anchorX, originX)} ${axis(anchorY, originY)}` };
  if (parts.length > 0) result.transform = parts.join(' ');
  return result;
}

// ---- opacity, blend mode ----

const BLEND_MODES: Record<string, string> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  colorDodge: 'color-dodge',
  colorBurn: 'color-burn',
  hardLight: 'hard-light',
  softLight: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

// ---- effects ----

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The CSS `filter` list for the effects that CSS has: `blur`, `dropShadow`, a coloured `glow`, and the seven colour
 * filters. CSS's `blur()` and `drop-shadow()` take the standard deviation of the Gaussian, as SCENE.md's `blur` and
 * `dropShadow.blur` do (checked against Chrome), so the numbers carry over. The others are left out with a warning.
 */
export function filterCss(effects: readonly (Effect | { type: 'motionBlur' })[] | undefined, frame: number, warn: Warn): string | undefined {
  const parts: string[] = [];
  for (const effect of effects ?? []) {
    switch (effect.type) {
      case 'blur': {
        const radius = clamp(num(effect.radius, frame, 0), 0, 128);
        if (radius >= 1) parts.push(`blur(${px(radius)})`);
        break;
      }
      case 'dropShadow': {
        if (num(effect.spread, frame, 0) !== 0) warn('dropShadow.spread', 'a dropShadow spread has no CSS filter equivalent and is left out');
        const blur = clamp(num(effect.blur, frame, 0), 0, 128);
        parts.push(`drop-shadow(${px(num(effect.x, frame, 0))} ${px(num(effect.y, frame, 0))} ${px(blur)} ${effect.color ?? '#000000'})`);
        break;
      }
      case 'glow': {
        const radius = clamp(num(effect.radius, frame, 0), 0, 128);
        const intensity = clamp(num(effect.intensity, frame, 1), 0, 4);
        if (radius < 1 || intensity === 0) break;
        if (effect.color === undefined) {
          warn('glow.color', 'a glow without a colour takes its colours from the layer; CSS cannot, so it is left out');
          break;
        }
        const colour = intensity < 1 ? `color-mix(in srgb, ${effect.color} ${fmt(intensity * 100)}%, transparent)` : effect.color;
        for (let i = 0; i < Math.max(1, Math.round(intensity)); i++) parts.push(`drop-shadow(0px 0px ${px(radius)} ${colour})`);
        break;
      }
      case 'saturate':
        parts.push(`saturate(${fmt(Math.max(0, num(effect.amount, frame, 1)))})`);
        break;
      case 'contrast':
        parts.push(`contrast(${fmt(Math.max(0, num(effect.amount, frame, 1)))})`);
        break;
      case 'brightness':
        parts.push(`brightness(${fmt(Math.max(0, num(effect.amount, frame, 1)))})`);
        break;
      case 'grayscale':
        parts.push(`grayscale(${fmt(clamp(num(effect.amount, frame, 1), 0, 1))})`);
        break;
      case 'sepia':
        parts.push(`sepia(${fmt(clamp(num(effect.amount, frame, 1), 0, 1))})`);
        break;
      case 'invert':
        parts.push(`invert(${fmt(clamp(num(effect.amount, frame, 1), 0, 1))})`);
        break;
      case 'hueRotate':
        parts.push(`hue-rotate(${fmt(num(effect.angle, frame, 0))}deg)`);
        break;
      case 'motionBlur':
        warn('motionBlur', 'motion blur is not drawn in Chrome frames');
        break;
      default:
        warn(`effect.${effect.type}`, `the ${effect.type} effect has no CSS equivalent and is left out of Chrome frames`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

// ---- clip paths ----

/** SCENE.md "Clip paths" as CSS `clip-path`; coordinates are relative to the element's box, as CSS's are. */
export function clipPathCss(clip: Clip | undefined, frame: number): string | undefined {
  if (clip === undefined) return undefined;
  switch (clip.kind) {
    case 'polygon':
      return `polygon(${clip.points.map(([x, y]) => `${px(num(x, frame, 0))} ${px(num(y, frame, 0))}`).join(', ')})`;
    case 'inset': {
      const radius = num(clip.radius, frame, 0);
      const sidesCss = [clip.top, clip.right, clip.bottom, clip.left].map((s) => px(num(s, frame, 0))).join(' ');
      return `inset(${sidesCss}${radius > 0 ? ` round ${px(radius)}` : ''})`;
    }
    case 'ellipse':
      return `ellipse(${px(Math.max(0, num(clip.rx, frame, 0)))} ${px(Math.max(0, num(clip.ry, frame, 0)))} at ${px(num(clip.cx, frame, 0))} ${px(num(clip.cy, frame, 0))})`;
    case 'path':
      return `path('${clip.d.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
  }
}

/** The paint props every element shares: opacity, blend mode, filter, clip. Mask and matte are left out with a warning. */
export function paintCss(props: CommonProps, frame: number, warn: Warn): CSSProperties {
  const style: CSSProperties = {};
  if (props.opacity !== undefined) {
    const opacity = clamp(num(props.opacity, frame, 1), 0, 1);
    if (opacity !== 1) style.opacity = opacity;
  }
  if (props.blendMode !== undefined && props.blendMode !== 'normal') style.mixBlendMode = BLEND_MODES[props.blendMode] as CSSProperties['mixBlendMode'];
  const filter = filterCss(props.effects, frame, warn);
  if (filter) style.filter = filter;
  const clipPath = clipPathCss(props.clip, frame);
  if (clipPath) style.clipPath = clipPath;
  if (props.mask) warn('mask', 'a gradient mask is not drawn in Chrome frames');
  if (props.matte) warn('matte', 'a track matte is not drawn in Chrome frames');
  if (props.motionBlur) warn('motionBlur', 'motion blur is not drawn in Chrome frames');
  return style;
}

// ---- flex layout ----

/** SCENE.md "Layout": a `layout` becomes the container's flex style. */
export function layoutCss(layout: Layout, frame: number): CSSProperties {
  const style: CSSProperties = { display: 'flex' };
  if (layout.flexDirection) style.flexDirection = layout.flexDirection;
  if (layout.flexWrap) style.flexWrap = layout.flexWrap;
  if (layout.justifyContent) style.justifyContent = layout.justifyContent;
  if (layout.alignItems) style.alignItems = layout.alignItems;
  if (layout.alignContent) style.alignContent = layout.alignContent;
  if (layout.gap !== undefined) {
    const gap = layout.gap;
    // `[row, column]` is two numbers; a list of keyframe objects is one animated number.
    style.gap = isList(gap, 2)
      ? `${px(evalNum(gap[0] as Num, frame))} ${px(evalNum(gap[1] as Num, frame))}`
      : px(evalNum(gap as Num, frame));
  }
  if (layout.padding !== undefined) style.padding = sides(layout.padding, frame);
  if (layout.width !== undefined) style.width = px(evalNum(layout.width, frame));
  if (layout.height !== undefined) style.height = px(evalNum(layout.height, frame));
  return style;
}

/** How a layer takes part in its parent's layout. `position: absolute` is a class (`kg-abs`), not a style. */
export function layoutItemCss(item: LayoutItem | undefined, frame: number): CSSProperties {
  const style: CSSProperties = {};
  if (!item) return style;
  if (item.flexGrow !== undefined) style.flexGrow = num(item.flexGrow, frame, 0);
  if (item.flexShrink !== undefined) style.flexShrink = num(item.flexShrink, frame, 1);
  if (item.flexBasis !== undefined) style.flexBasis = item.flexBasis === 'auto' ? 'auto' : px(evalNum(item.flexBasis, frame));
  if (item.alignSelf && item.alignSelf !== 'auto') style.alignSelf = item.alignSelf;
  if (item.margin !== undefined) style.margin = sides(item.margin, frame);
  if (item.width !== undefined) style.width = px(evalNum(item.width, frame));
  if (item.height !== undefined) style.height = px(evalNum(item.height, frame));
  return style;
}

export const isAbsolute = (item: LayoutItem | undefined): boolean => item?.position === 'absolute';

// ---- shared style sheet ----

/**
 * The positioning rules the elements rely on, written as a style sheet because they depend on the parent: a native
 * element is out of the flow at its parent's origin inside a group without a layout, in the flow inside a group with
 * one, and a block like any other inside a DOM element (docs/COMPAT.md §2: a native element in DOM is a replaced
 * box). Every native element is positioned, so the elements paint in tree order, as the scene's layers do.
 */
export const BROWSER_CSS = `
.kg-layer { position: relative; box-sizing: border-box; isolation: isolate; }
.kg-el, .kg-item, .kg-leaf { box-sizing: border-box; position: relative; }
.kg-layer:not(.kg-flex) > .kg-el, .kg-layer:not(.kg-flex) > .kg-item,
.kg-layer.kg-flex > .kg-abs { position: absolute; left: 0; top: 0; }
.kg-layer.kg-flex > .kg-el:not(.kg-abs), .kg-layer.kg-flex > .kg-item:not(.kg-abs) { position: relative; }
.kg-layer:not(.kg-flex) > .kg-box, .kg-layer.kg-flex > .kg-box.kg-abs { width: var(--kg-w); height: var(--kg-h); }
.kg-layer.kg-flex > .kg-box:not(.kg-abs) { width: 0; height: 0; }
.kg-leaf { display: block; }
`;
