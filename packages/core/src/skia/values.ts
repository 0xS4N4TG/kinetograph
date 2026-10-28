// Props as the Skia addon reads them (crates/skia/render/src/value.rs): colours are `[r, g, b, a]` from 0 to 1, a
// transform is a list of `{ name: number }`, typed arrays are plain arrays. Objects that have a shape of their own
// (paths, images, fonts, paints) serialise themselves through `toJSON`.

import { parseColor } from '../colors.js';
import { unwrap } from './shared-value.js';

/** A colour as RN-Skia holds it: four floats from 0 to 1. */
export type SkColor = Float32Array;

/** `'red'`, `'#f00'`, `'rgba(…)'`, a number as `0xAARRGGBB`, or `[r, g, b, a]` from 0 to 1, as `[r, g, b, a]`. */
export function toColor(input: unknown): [number, number, number, number] {
  if (typeof input === 'string') {
    const color = parseColor(input);
    if (color === null) throw new Error(`Not a colour: ${JSON.stringify(input)}`);
    return [color.r / 255, color.g / 255, color.b / 255, color.a / 255];
  }
  if (typeof input === 'number') {
    return [((input >>> 16) & 255) / 255, ((input >>> 8) & 255) / 255, (input & 255) / 255, ((input >>> 24) & 255) / 255];
  }
  if (ArrayBuffer.isView(input) || Array.isArray(input)) {
    const [r, g, b, a = 1] = Array.from(input as ArrayLike<number>);
    if ([r, g, b, a].every((c) => typeof c === 'number')) return [r!, g!, b!, a];
  }
  throw new Error(`Not a colour: ${JSON.stringify(input)}`);
}

/** The props that hold colours (`colors` holds a list of them). */
const COLOR_KEYS = new Set(['color', 'colors', 'decorationColor']);

/** One item of a `transform` list, as the addon reads it: a `translate: [x, y]` becomes two items. */
function transformItems(item: Record<string, unknown>): Record<string, unknown>[] {
  const [[name, value]] = Object.entries(item) as [[string, unknown]];
  if (name === 'translate' && Array.isArray(value)) return [{ translateX: value[0] }, { translateY: value[1] }];
  if (name === 'scale' && Array.isArray(value)) return [{ scaleX: value[0] }, { scaleY: value[1] }];
  return [item];
}

/** Anything RN-Skia accepts as a prop value, as JSON-able data. */
export function plain(input: unknown): unknown {
  const value = unwrap(input);
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if ('toJSON' in value && typeof value.toJSON === 'function') return value.toJSON();
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== 'function')
      .map(([key, item]) => [key, plain(item)]),
  );
}

/** The props of a node, normalised; `children`, `ref`, functions and undefined values are left out. */
export function normalizeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    const value = unwrap(raw);
    if (key === 'children' || key === 'ref' || key === 'key' || value === undefined || typeof value === 'function') continue;
    if (COLOR_KEYS.has(key)) {
      out[key] = key === 'colors' ? (value as unknown[]).map((c) => toColor(unwrap(c))) : toColor(value);
    } else if (key === 'transform' && Array.isArray(value)) {
      out[key] = value.flatMap((item) => transformItems(plain(item) as Record<string, unknown>));
    } else {
      out[key] = plain(value);
    }
  }
  return out;
}
