// AbsoluteFill and Img: Remotion's two CSS-shaped components, mapped onto the
// engine's layers (packages/cli/skills/kinetograph/references/AUTHORING.md §7.1). Only the style keys that mean
// something to a layer are read, and with only those keys the mapping is the
// layers' (the hand ports render as they did). With any other key they are the
// DOM elements they are in Remotion, `div` and `img`, which compat mode maps
// (kinetograph site, /docs/compat/).

import type { ReactNode } from 'react';
import { Image, Layer, Rect } from '@kinetographdev/react';
import type { Layout } from '@kinetographdev/scene';
import { parseColor } from './colors.js';
import { useVideoConfig } from './timeline.js';

/** CSS-like style keys that map onto the engine (AUTHORING.md §7.1). */
export type FillStyle = Record<string, string | number | undefined>;

const warned = new Set<string>();
function warnOnce(component: string, key: string, why: string): void {
  const id = `${component}.${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`<${component}> ignores style.${key}: ${why}`);
}

/** Forgets which keys were warned about (for tests). */
export function resetStyleWarnings(): void {
  warned.clear();
}

const FLEX_KEYS = ['flexDirection', 'justifyContent', 'alignItems', 'flexWrap'] as const;

/** The `AbsoluteFill` style keys the layer mapping reads. */
const FILL_KEYS = new Set<string>([...FLEX_KEYS, 'display', 'gap', 'padding', 'opacity', 'backgroundColor', 'background']);
/** The `Img` style keys the layer mapping reads. */
const IMG_KEYS = new Set<string>(['width', 'height', 'objectFit']);

/** Whether `style` sets a key outside `keys` (a key set to undefined or null is not set). */
function hasOtherKeys(style: FillStyle, keys: ReadonlySet<string>): boolean {
  return Object.entries(style).some(([key, value]) => value !== undefined && value !== null && !keys.has(key));
}

/**
 * Whether the layer mapping can take every value of a fill's style: a plain colour for the background, `flex` for
 * `display`, a number for `opacity`, pixels for `gap` and `padding`. Anything else (a gradient, `display: grid`, `2em`)
 * is CSS for the engine's CSS engine, so the fill is the `div`.
 */
function layerCanTake(style: FillStyle): boolean {
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    if (key === 'backgroundColor' || key === 'background') {
      if (typeof value !== 'string' || parseColor(value) === null) return false;
    } else if (key === 'display') {
      if (value !== 'flex' && value !== 'none') return false;
    } else if (key === 'opacity') {
      if (typeof value !== 'number') return false;
    } else if (key === 'gap') {
      if (px(value) === null) return false;
    } else if (key === 'padding') {
      if (parsePadding(value) === null) return false;
    }
  }
  return true;
}

/** `10`, `'10px'` -> 10; anything else -> null. */
function px(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

/** CSS `padding`: one to four values in px, as `[top, right, bottom, left]`. */
function parsePadding(value: unknown): number | [number, number, number, number] | null {
  const single = px(value);
  if (single !== null) return single;
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/).map(px);
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === null)) return null;
  const [a, b = a, c = a, d = b] = parts as number[];
  return [a!, b!, c!, d!];
}

function isTransparent(color: string): boolean {
  const parsed = parseColor(color);
  return parsed !== null && parsed.a === 0;
}

export interface AbsoluteFillProps {
  style?: FillStyle;
  id?: string;
  /** Not read by the layer mapping: with it, `AbsoluteFill` is a `div` (and compat mode reports the class). */
  className?: string;
  children?: ReactNode;
}

/**
 * Covers the whole composition and stacks its children in a column, as the
 * CSS box does; it overlays its siblings instead of sharing the flow with them.
 */
export function AbsoluteFill({ style = {}, id, className, children }: AbsoluteFillProps): ReactNode {
  const { width, height } = useVideoConfig();
  if (className !== undefined || hasOtherKeys(style, FILL_KEYS) || !layerCanTake(style)) {
    // Remotion's own: a column flex box over the whole page, the author's style laid over it.
    return (
      <div id={id} className={className} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', ...style }}>
        {children}
      </div>
    );
  }
  const layout: Layout = { flexDirection: 'column', width, height };
  let opacity: number | undefined;
  let background: string | undefined;

  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    if ((FLEX_KEYS as readonly string[]).includes(key)) {
      (layout as Record<string, unknown>)[key] = value;
    } else if (key === 'display') {
      if (value === 'none') return null;
      if (value !== 'flex') warnOnce('AbsoluteFill', key, `only "flex" is supported, got "${value}"`);
    } else if (key === 'gap') {
      const gap = px(value);
      if (gap === null) warnOnce('AbsoluteFill', key, `expected a number of pixels, got "${value}"`);
      else layout.gap = gap;
    } else if (key === 'padding') {
      const padding = parsePadding(value);
      if (padding === null) warnOnce('AbsoluteFill', key, `expected one to four pixel values, got "${value}"`);
      else layout.padding = padding;
    } else if (key === 'opacity') {
      if (typeof value === 'number') opacity = value;
      else warnOnce('AbsoluteFill', key, `expected a number, got "${value}"`);
    } else if (key === 'backgroundColor' || key === 'background') {
      if (typeof value === 'string' && parseColor(value) !== null) background = value;
      else warnOnce('AbsoluteFill', key, `only a plain colour is supported, got "${value}"`);
    }
  }

  return (
    <Layer
      id={id}
      // Not a stacking context in CSS: a child's `mixBlendMode` blends with what is behind the fill.
      passThrough
      layout={layout}
      layoutItem={{ position: 'absolute' }}
      opacity={opacity}
      domFill={{ style, ...(id !== undefined ? { id } : {}), background: background !== undefined && !isTransparent(background) }}
    >
      {background !== undefined && !isTransparent(background) ? (
        <Rect width={width} height={height} fill={background} layoutItem={{ position: 'absolute' }} />
      ) : null}
      {children}
    </Layer>
  );
}

export interface ImgProps {
  src: string;
  style?: FillStyle;
  width?: number;
  height?: number;
  id?: string;
  /** Not read by the layer mapping: with it, `Img` is an `img` (and compat mode reports the class). */
  className?: string;
}

/** An image whose CSS-style `width`, `height` and `objectFit` become the layer's box and fit. */
export function Img({ src, style = {}, width, height, id, className }: ImgProps): ReactNode {
  // Pixels for the size and a fit the image layer has are the layer mapping; a percentage, `auto`, `object-fit: none`
  // are CSS (packages/cli/skills/kinetograph/references/ENGINE.md §10.1).
  const layerFit = style.objectFit === undefined || ['fill', 'contain', 'cover', 'scale-down'].includes(String(style.objectFit));
  const layerSize = (style.width === undefined || px(style.width) !== null) && (style.height === undefined || px(style.height) !== null);
  if (className !== undefined || hasOtherKeys(style, IMG_KEYS) || !layerFit || !layerSize) {
    return <img id={id} className={className} src={src} width={width} height={height} style={style} />;
  }
  const w = px(style.width) ?? width;
  const h = px(style.height) ?? height;
  const objectFit = style.objectFit;
  let fit: 'fill' | 'contain' | 'cover' | undefined;
  if (objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover') fit = objectFit;
  else if (objectFit === 'scale-down') fit = 'contain';
  else if (objectFit !== undefined) warnOnce('Img', 'objectFit', `"${objectFit}" is not supported, using the default`);
  return <Image id={id} src={src} width={w} height={h} fit={fit} />;
}
