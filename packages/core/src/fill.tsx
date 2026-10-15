// AbsoluteFill and Img: Remotion's two CSS-shaped components, mapped onto the
// engine's layers (docs/AUTHORING.md §7.1). Only the style keys that mean
// something to a layer are read; any other key is ignored with one warning.

import type { ReactNode } from 'react';
import { Image, Layer, Rect } from '@kinetograph/react';
import type { Layout } from '@kinetograph/scene';
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
  children?: ReactNode;
}

/**
 * Covers the whole composition and stacks its children in a column, as the
 * CSS box does; it overlays its siblings instead of sharing the flow with them.
 */
export function AbsoluteFill({ style = {}, id, children }: AbsoluteFillProps): ReactNode {
  const { width, height } = useVideoConfig();
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
    } else {
      warnOnce('AbsoluteFill', key, 'the engine has no such style; use a native element prop instead');
    }
  }

  return (
    <Layer id={id} layout={layout} layoutItem={{ position: 'absolute' }} opacity={opacity}>
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
}

/** An image whose CSS-style `width`, `height` and `objectFit` become the layer's box and fit. */
export function Img({ src, style = {}, width, height, id }: ImgProps): ReactNode {
  const w = px(style.width) ?? width;
  const h = px(style.height) ?? height;
  const objectFit = style.objectFit;
  let fit: 'fill' | 'contain' | 'cover' | undefined;
  if (objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover') fit = objectFit;
  else if (objectFit === 'scale-down') fit = 'contain';
  else if (objectFit !== undefined) warnOnce('Img', 'objectFit', `"${objectFit}" is not supported, using the default`);
  for (const key of Object.keys(style)) {
    if (key !== 'width' && key !== 'height' && key !== 'objectFit') {
      warnOnce('Img', key, 'the engine has no such style; use a native element prop instead');
    }
  }
  return <Image id={id} src={src} width={w} height={h} fit={fit} />;
}
