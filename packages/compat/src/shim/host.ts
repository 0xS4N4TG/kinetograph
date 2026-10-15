// What the DOM shim needs from the reconciler (docs/ENGINE.md §1, "Readback"): the host tree around an element and the
// island's boxes and computed styles, which come from the addon. `@kinetograph/react` implements `Readback` per root.

import type { DomNode } from '../types.js';

export type HostElement = Extract<DomNode, { kind: 'element' }>;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element's boxes, in the island's coordinates (the composition's, for the island at the origin). */
export interface BoxInfo {
  /** The offset (border) box before transforms. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The border box after transforms, as `getBoundingClientRect` reports it. */
  rect: Rect;
  client: { width: number; height: number };
  scroll: { width: number; height: number };
}

export interface Readback {
  /** Changes whenever the host tree may have changed (a commit, a script's change to a style or attribute). */
  generation(): number;
  /** The element's boxes, or null when it has none (not attached, or `display: none`). */
  box(host: HostElement): BoxInfo | null;
  /** The computed value of a CSS property (kebab-case), or null when the engine cannot say. */
  computed(host: HostElement, property: string): string | null;
  /** The nearest parent element (a `<Sequence>` is transparent), or null at the top. */
  parent(host: HostElement): HostElement | null;
  /** The children (elements and text) with each `<Sequence>` replaced by what is inside it. */
  childNodes(host: HostElement): DomNode[];
  /** Whether the element is part of the root's tree. */
  isConnected(host: HostElement): boolean;
  /** The composition's size. */
  viewport(): { width: number; height: number };
  /** Marks the tree changed after a script wrote a style or attribute. */
  touch(): void;
  /** The top-level nodes of the root (`<Sequence>`s replaced by what is inside them). */
  roots(): DomNode[];
  /** Every DOM element in the root, in document order, also inside native elements. */
  descendants(): HostElement[];
}

/** What a script wrote with `element.style.x = …` or `setAttribute`, laid over the props React gave. */
export interface Overlay {
  style: Map<string, string>;
  attrs: Map<string, string | null>;
}

const overlays = new WeakMap<object, Overlay>();

export function overlayOf(host: object, create: boolean): Overlay | undefined {
  let overlay = overlays.get(host);
  if (overlay === undefined && create) {
    overlay = { style: new Map(), attrs: new Map() };
    overlays.set(host, overlay);
  }
  return overlay;
}

/**
 * The props of `host` with a script's changes laid over them: `style` entries (kebab-case names) and attributes. A
 * `null` attribute removes it. Without changes the props are returned as they are.
 */
export function propsWithOverlay(host: HostElement): Record<string, any> {
  const overlay = overlays.get(host);
  if (overlay === undefined || (overlay.style.size === 0 && overlay.attrs.size === 0)) return host.props;
  const props: Record<string, any> = { ...host.props };
  if (overlay.style.size > 0) {
    const style: Record<string, unknown> = typeof props.style === 'object' && props.style !== null ? { ...props.style } : {};
    for (const [name, value] of overlay.style) style[name] = value;
    props.style = style;
  }
  for (const [name, value] of overlay.attrs) {
    if (name === 'class') props.className = value ?? undefined;
    else if (value === null) delete props[name];
    else props[name] = value;
  }
  return props;
}
