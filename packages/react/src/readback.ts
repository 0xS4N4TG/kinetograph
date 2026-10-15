// Readback (docs/ENGINE.md §1): what a ref to a DOM host element, `getComputedStyle` and the observers learn about the
// current host tree. The island that holds the element is sent to the addon as an `IslandRequest` (the same JSON the
// frame is drawn from) and its boxes or computed styles come back; both are cached until the tree changes (`generation`).

import {
  addonFunction,
  collectStyleElements,
  hasAddonFunction,
  importedStylesheets,
  isDomElement,
  noteStylesheet,
  requestFor,
} from '@kinetograph/compat/dom';
import type { BoxInfo, Readback } from '@kinetograph/compat/shim';
import { propsWithOverlay } from '@kinetograph/compat/shim';
import { flattenDomElement, type EmitOptions, type HostElement, type HostNode } from './emit.js';

/** The root of the host tree, as `root.ts` keeps it. */
export interface Container {
  children: HostNode[];
  /** Bumped when the tree changes: a commit, or a script's write to a style or attribute. */
  generation: number;
  readback: Readback | null;
  /** The tree generations measured since the frame's work began (see `settle`): one per pass of measuring. */
  measuredGenerations: Set<number>;
}

/** What the reconciler learns about a host node as it is placed: where it hangs, and in which root. */
export interface HostMeta {
  parent: HostElement | null;
  container: Container;
}
export const hostMeta = new WeakMap<HostNode, HostMeta>();

type Boxes = Record<string, BoxInfo>;

interface Island {
  root: HostElement;
  path: string;
  json: string;
  boxes?: Boxes;
  computed: Map<string, string | null>;
}

/** The nearest ancestor that is not a `<Sequence>` (which is transparent). */
function effectiveParent(node: HostNode): HostElement | null {
  let parent = hostMeta.get(node)?.parent ?? null;
  while (parent !== null && parent.type === 'kg-sequence') parent = hostMeta.get(parent)?.parent ?? null;
  return parent;
}

/** The elements among `nodes`, with each `<Sequence>` replaced by what is inside it; text counted too when asked. */
function flatten(nodes: HostNode[], out: HostNode[] = []): HostNode[] {
  for (const node of nodes) {
    if (node.kind === 'element' && node.type === 'kg-sequence') flatten(node.children, out);
    else out.push(node);
  }
  return out;
}

/** Passes of render that measure the layout and set state from it, before it is called a loop that never ends. */
export const MAX_MEASURE_PASSES = 8;

export function measureLoopError(): Error {
  return new Error(
    `The tree did not settle after ${MAX_MEASURE_PASSES} passes: an effect measures an element (getBoundingClientRect, ` +
      'offsetWidth, getComputedStyle, a ResizeObserver) and sets state that changes what it measured, again and again. ' +
      'Make the measured size not depend on the state it sets.',
  );
}

export function createReadback(container: Container, options: EmitOptions): Readback {
  let cachedGeneration = -1;
  let paths = new Map<HostElement, string>();
  const islands = new Map<HostElement, Island>();

  const fresh = (): void => {
    if (cachedGeneration === container.generation) return;
    cachedGeneration = container.generation;
    paths = new Map();
    islands.clear();
  };

  /** The host-tree path of an element (`$0.2.1`): its index among the elements of its parent, `<Sequence>` transparent. */
  const pathOf = (host: HostElement): string => {
    fresh();
    const known = paths.get(host);
    if (known !== undefined) return known;
    const parent = effectiveParent(host);
    const siblings = flatten(parent === null ? container.children : parent.children).filter((n) => n.kind === 'element');
    const index = siblings.indexOf(host);
    const path = parent === null ? `$${index}` : `${pathOf(parent)}.${index}`;
    paths.set(host, path);
    return path;
  };

  const isDom = (node: HostElement | null): node is HostElement => node !== null && isDomElement(node.type);

  /** The DOM element at the top of the run of DOM elements `host` is in: the root of its island. */
  const islandRootOf = (host: HostElement): HostElement => {
    let top = host;
    for (let p = effectiveParent(top); isDom(p); p = effectiveParent(top)) top = p;
    return top;
  };

  const islandOf = (host: HostElement): Island | null => {
    fresh();
    const root = islandRootOf(host);
    let island = islands.get(root);
    if (island === undefined) {
      const path = pathOf(root);
      const stylesheets = [...importedStylesheets(), ...collectStyleElements(container.children)];
      for (const css of stylesheets) noteStylesheet(css);
      const { request } = requestFor(flattenDomElement(root, path, null), {
        path,
        viewport: options.viewport ?? { width: 1920, height: 1080 },
        fonts: options.fonts?.() ?? {},
        emitNative: () => null,
        time: options.time?.() ?? 0,
        stylesheets,
      });
      island = { root, path, json: JSON.stringify(request), computed: new Map() };
      islands.set(root, island);
    }
    return island;
  };

  /** Notes that the layout of this generation of the tree is being read; a ninth generation in one frame is a loop. */
  const measuring = (): void => {
    container.measuredGenerations.add(container.generation);
    if (container.measuredGenerations.size > MAX_MEASURE_PASSES) throw measureLoopError();
  };

  const readback: Readback = {
    generation: () => container.generation,
    box(host) {
      measuring();
      if (!hasAddonFunction('domLayoutBoxes')) return null;
      const island = islandOf(host);
      if (island === null) return null;
      island.boxes ??= JSON.parse(addonFunction('domLayoutBoxes')(island.json)) as Boxes;
      return island.boxes[pathOf(host)] ?? null;
    },
    computed(host, property) {
      measuring();
      const island = islandOf(host);
      if (island === null) return inlineValue(host, property);
      const key = `${pathOf(host)}\0${property}`;
      if (island.computed.has(key)) return island.computed.get(key) ?? null;
      let value: string | null;
      if (hasAddonFunction('domComputedStyle')) {
        const answer = JSON.parse(addonFunction('domComputedStyle')(island.json, pathOf(host), [property])) as Record<string, string>;
        value = answer[property] ?? null;
      } else {
        value = inlineValue(host, property);
      }
      island.computed.set(key, value);
      return value;
    },
    parent: (host) => {
      const parent = effectiveParent(host);
      return isDom(parent) ? parent : null;
    },
    childNodes: (host) => flatten(host.children).filter((n) => n.kind === 'text' || isDomElement(n.type)),
    isConnected(host) {
      let top: HostElement = host;
      for (let p = hostMeta.get(top)?.parent ?? null; p !== null; p = hostMeta.get(top)?.parent ?? null) top = p;
      return container.children.includes(top);
    },
    viewport: () => options.viewport ?? { width: 1920, height: 1080 },
    touch() {
      container.generation++;
    },
    roots: () => flatten(container.children),
    descendants() {
      const out: HostElement[] = [];
      const visit = (nodes: HostNode[]): void => {
        for (const n of nodes) {
          if (n.kind !== 'element') continue;
          if (isDomElement(n.type)) out.push(n);
          visit(n.children);
        }
      };
      visit(container.children);
      return out;
    },
  };
  return readback;
}

/** A property's value from the element's inline style or attributes, when the engine cannot say. */
function inlineValue(host: HostElement, property: string): string | null {
  const props = propsWithOverlay(host);
  const style = props.style;
  if (typeof style === 'object' && style !== null) {
    const camel = property.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const value = (style as Record<string, unknown>)[camel] ?? (style as Record<string, unknown>)[property];
    if (value !== undefined && value !== null && value !== '') return typeof value === 'number' && value !== 0 && !/opacity|z-index|flex|weight|line-height/.test(property) ? `${value}px` : String(value);
  }
  return null;
}
