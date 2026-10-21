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
  /** The root's own top-level list (not a copy): what a script adds to `document.body` goes into it. */
  rootChildren(): DomNode[];
  /**
   * The box of characters `start..end` of a text node, as a `Range` reports it (the union of their line boxes), or null
   * when the engine cannot say (no addon, or the text is not inside an element).
   */
  textRangeBox?(node: Extract<DomNode, { kind: 'text' }>, start: number, end: number): Rect | null;
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

// ---- where a node hangs ----

// The list a node is in belongs to its raw parent: the element (a `<Sequence>` included) whose `children` holds it, or
// null at the top of a root. The reconciler sets the link as it places a node, a script's `appendChild` does too, so a
// tree that holds both React's nodes and a library's has one answer to "who is my parent".
const parents = new WeakMap<DomNode, HostElement | null>();

export function rawParentOf(node: DomNode): HostElement | null {
  return parents.get(node) ?? null;
}

export function setRawParent(node: DomNode, parent: HostElement | null): void {
  parents.set(node, parent);
}

/** The nearest parent that is not a `<Sequence>` (which is transparent), or null at the top. */
export function effectiveParentOf(node: DomNode): HostElement | null {
  let parent = rawParentOf(node);
  while (parent !== null && parent.type === 'kg-sequence') parent = rawParentOf(parent);
  return parent;
}

// ---- the roots a script can reach ----

/** A root that observers and `document` can reach: its readback and the elements it can find. */
const roots = new Set<Readback>();
/** The root `document.body` is: the last one that renders (not one that only discovers compositions). */
let bodyRoot: Readback | null = null;
/** What a script put on `document.body` before a root was there to hold it (at module load). */
const pendingBody: DomNode[] = [];

export function registerReadbackRoot(readback: Readback, options: { adoptPending?: boolean } = {}): void {
  roots.add(readback);
  if (options.adoptPending) {
    bodyRoot = readback;
    const top = readback.rootChildren();
    for (const node of pendingBody) {
      setRawParent(node, null);
      top.push(node);
    }
    pendingBody.length = 0;
  }
}

export function unregisterReadbackRoot(readback: Readback): void {
  roots.delete(readback);
  if (bodyRoot === readback) bodyRoot = null;
}

export function readbackRoots(): ReadonlySet<Readback> {
  return roots;
}

/** The top-level list of `document.body`: the current root's, or the nodes waiting for one. */
export function bodyChildren(): DomNode[] {
  return bodyRoot !== null ? bodyRoot.rootChildren() : pendingBody;
}

export function currentBodyRoot(): Readback | null {
  return bodyRoot;
}

/** `document.head`, `document.documentElement` and `document.body` as host elements (`body` holds the root's top level). */
export const headHost: HostElement = { kind: 'element', type: 'head', props: {}, children: [] };
export const bodyHost = { kind: 'element', type: 'body', props: {}, get children() { return bodyChildren(); } } as HostElement;
export const htmlHost: HostElement = { kind: 'element', type: 'html', props: {}, children: [headHost, bodyHost] };
setRawParent(headHost, htmlHost);
setRawParent(bodyHost, htmlHost);

/** The composition's size, which `html` and `body` report when no root is there to say. */
let pageSize = { width: 1920, height: 1080 };
export function setPageViewport(size: { width: number; height: number }): void {
  pageSize = { width: size.width, height: size.height };
}
export function pageViewport(): { width: number; height: number } {
  return pageSize;
}
