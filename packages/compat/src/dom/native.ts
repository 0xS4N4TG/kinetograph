// Native `kg-*` elements inside a DOM island: the box each takes in the CSS layout (docs/ENGINE.md §2), and where its
// layers go once Rust has placed that box.

import type { LayerJson } from '@kinetograph/scene';
import { addonFunction, hasAddonFunction } from '../addon.js';
import type { DomNode } from '../types.js';

type ElementNode = Extract<DomNode, { kind: 'element' }>;

/** The first value of a number or of an animated one: a box is laid out once. */
function first(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && typeof value[0]?.value === 'number') return value[0].value as number;
  return undefined;
}

/**
 * The size a native element has as a replaced box: its own `width` and `height` (a group's `layout`), a text layer's
 * `maxWidth` and measured height. A layer without a box (a path, a group without `layout`) is 0 by 0. An animated size
 * is its first value.
 */
export function nativeSize(node: ElementNode): { width?: number; height?: number } {
  const props = node.props;
  switch (node.type) {
    case 'kg-layer': {
      const layout = props.layout;
      return { width: first(layout?.width) ?? 0, height: first(layout?.height) ?? 0 };
    }
    case 'kg-shape':
      return props.kind === 'path' ? { width: 0, height: 0 } : { width: first(props.width) ?? 0, height: first(props.height) ?? 0 };
    case 'kg-path':
      return { width: 0, height: 0 };
    case 'kg-text':
      return textSize(node);
    case 'kg-camera':
    case 'kg-audio':
    case 'kg-sequence':
      return { width: 0, height: 0 };
    default:
      return { width: first(props.width) ?? 0, height: first(props.height) ?? 0 };
  }
}

/**
 * The native elements that are drawn rather than laid out lie over the DOM around them, at the top left corner of the
 * nearest positioned element (what an `<AbsoluteFill>` around each did by hand), and take no room in the flow: a
 * `<Layer>`, a shape, a canvas, a shader, a 3D scene, a video. An image, a GIF, a Lottie and a text box are content of
 * the flow, as the replaced elements and text they stand for are in CSS.
 */
export function overlaysSiblings(node: ElementNode): boolean {
  switch (node.type) {
    case 'kg-layer':
    case 'kg-shape':
    case 'kg-rect':
    case 'kg-ellipse':
    case 'kg-path':
    case 'kg-noise':
    case 'kg-mesh-gradient':
    case 'kg-canvas':
    case 'kg-glsl':
    case 'kg-scene3d':
    case 'kg-video':
      return true;
    default:
      return false;
  }
}

function textSize(node: ElementNode): { width: number; height: number } {
  const props = node.props;
  const text = node.children.map((c) => (c.kind === 'text' ? c.text : '')).join('');
  const maxWidth = first(props.maxWidth);
  if (!hasAddonFunction('layoutText') || text === '' || typeof props.font !== 'string') return { width: maxWidth ?? 0, height: 0 };
  try {
    const layout = addonFunction('layoutText')({
      text,
      font: props.font,
      size: first(props.size) ?? 16,
      ...(props.lineHeight !== undefined ? { lineHeight: first(props.lineHeight) } : {}),
      ...(props.align !== undefined ? { align: props.align } : {}),
      ...(maxWidth !== undefined ? { maxWidth } : {}),
    });
    return { width: maxWidth ?? layout.width, height: layout.height };
  } catch {
    return { width: maxWidth ?? 0, height: 0 };
  }
}

/** A native layer moved to where CSS put its box: its own `x` and `y` are an offset from there. */
export function placeNative(layer: LayerJson, x: number, y: number): LayerJson {
  const t: Record<string, any> = { ...(layer.transform ?? {}) };
  const anchorX = typeof t.anchorX === 'number' ? t.anchorX : 0;
  const anchorY = typeof t.anchorY === 'number' ? t.anchorY : 0;
  const plus = (value: unknown, by: number): unknown => {
    if (value === undefined) return by;
    if (typeof value === 'number') return value + by;
    if (Array.isArray(value)) return value.map((key) => ({ ...key, value: key.value + by }));
    return by;
  };
  const nx = plus(t.x, x + anchorX);
  const ny = plus(t.y, y + anchorY);
  if (nx === 0) delete t.x;
  else t.x = nx;
  if (ny === 0) delete t.y;
  else t.y = ny;
  if (Object.keys(t).length === 0) {
    const { transform: _dropped, ...rest } = layer as LayerJson & { transform?: unknown };
    return rest as LayerJson;
  }
  return { ...layer, transform: t } as LayerJson;
}

/** What `renderDomIsland` leaves where a native element goes (docs/ENGINE.md §2). */
export interface NativePlaceholder {
  type: 'native';
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isPlaceholder(layer: unknown): layer is NativePlaceholder {
  return typeof layer === 'object' && layer !== null && (layer as { type?: unknown }).type === 'native';
}

/**
 * Replaces the placeholders in `layers` (at any depth) with the native elements' own layers, placed at the boxes.
 * A placeholder whose element makes no layer (`<Camera>`, `<Audio>`) is dropped.
 */
export function fillNatives(layers: unknown[], emit: (path: string) => LayerJson | null): LayerJson[] {
  const out: LayerJson[] = [];
  for (const layer of layers) {
    if (isPlaceholder(layer)) {
      const made = emit(layer.path);
      if (made !== null) out.push(placeNative(made, layer.x ?? 0, layer.y ?? 0));
      continue;
    }
    const l = layer as LayerJson;
    if (l.type === 'group' && Array.isArray(l.children)) {
      out.push({ ...l, children: fillNatives(l.children, emit) } as LayerJson);
    } else {
      out.push(l);
    }
  }
  return out;
}
