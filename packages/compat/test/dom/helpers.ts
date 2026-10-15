// Test helpers for the DOM mapping: styled trees built by hand (no `parseStyle`: stream 1 writes it in parallel),
// laid out by the real addon on the CPU.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { LayerJson } from '@kinetograph/scene';
import type { Length, ParsedStyle, Rgba } from '../../src/css/types.js';
import { mapStyledIsland, setLayoutDom, type LayoutDom, type StyledElement, type StyledNode } from '../../src/dom/index.js';
import { Report } from '../../src/dom/tree.js';
import type { DomNode, IslandContext, IslandResult } from '../../src/types.js';

export const FONT_FILE = fileURLToPath(new URL('../../../../assets/fonts/DMSans-Medium.ttf', import.meta.url));
export const FONTS = { 'DM Sans': FONT_FILE };

export const px = (value: number): Length => ({ unit: 'px', value });
export const pct = (value: number): Length => ({ unit: '%', value });
export const em = (value: number): Length => ({ unit: 'em', value });
export const rgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
export const sides = <T,>(top: T, right: T = top, bottom: T = top, left: T = right): [T, T, T, T] => [top, right, bottom, left];
export const corners = (r: number): ParsedStyle['borderRadius'] => [
  [px(r), px(r)],
  [px(r), px(r)],
  [px(r), px(r)],
  [px(r), px(r)],
];

/** The addon's `layoutDom`, or null where the addon is not built. */
export function nativeLayout(): LayoutDom | null {
  try {
    return (createRequire(import.meta.url)('@kinetograph/native') as { layoutDom: LayoutDom }).layoutDom;
  } catch {
    return null;
  }
}

export const hasAddon = nativeLayout() !== null;

export function el(type: string, style: ParsedStyle = {}, children: (StyledNode | string)[] = [], props: Record<string, any> = {}): StyledElement {
  return {
    kind: 'element',
    type,
    path: '$0',
    id: '$0',
    props,
    rawStyle: {},
    style,
    diagnostics: [],
    children: children.map((c) => (typeof c === 'string' ? { kind: 'text' as const, text: c } : c)),
  };
}

export const div = (style: ParsedStyle = {}, children: (StyledNode | string)[] = [], props: Record<string, any> = {}): StyledElement =>
  el('div', style, children, props);

/** Numbers every element by its place among its siblings, as the reconciler does. */
function number(node: StyledElement, path: string): void {
  node.path = path;
  node.id = typeof node.props.id === 'string' ? node.props.id : path;
  let i = 0;
  for (const child of node.children) {
    if (child.kind === 'element') number(child, `${path}.${i++}`);
    else if (child.kind === 'native') child.path = `${path}.${i++}`;
  }
}

export interface Run extends IslandResult {
  /** The first (only) layer: the island's root group. */
  root: any;
}

export function context(extra: Partial<IslandContext> = {}): IslandContext {
  return {
    path: '$0',
    viewport: { width: 1000, height: 800 },
    fonts: FONTS,
    emitNative: () => null,
    ...extra,
  };
}

/** Lays out and maps `root` in a 1000 x 800 composition. */
export function run(root: StyledElement, extra: Partial<IslandContext> = {}): Run {
  const layout = nativeLayout();
  if (layout === null) throw new Error('the addon is not built');
  setLayoutDom(layout);
  number(root, '$0');
  const result = mapStyledIsland(root, context(extra), new Report());
  return { ...result, root: result.layers[0] };
}

/** Finds a layer by id anywhere under `layer`. */
export function find(layer: LayerJson | undefined, id: string): any {
  if (layer === undefined) return undefined;
  if (layer.id === id) return layer;
  if (layer.type !== 'group') return undefined;
  for (const child of layer.children) {
    const found = find(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The ids under `layer`, depth first. */
export function ids(layer: LayerJson | undefined): string[] {
  if (layer === undefined) return [];
  return [layer.id, ...(layer.type === 'group' ? layer.children.flatMap((c) => ids(c)) : [])];
}

export function nativeNode(type: string, props: Record<string, any> = {}): Extract<DomNode, { kind: 'element' }> {
  return { kind: 'element', type, props, children: [] };
}
