// Readback (packages/cli/skills/kinetograph/references/ENGINE.md §1): what a ref to a DOM host element, `getComputedStyle` and the observers learn about the
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
} from '@kinetographdev/compat/dom';
import type { BoxInfo, Readback } from '@kinetographdev/compat/shim';
import { effectiveParentOf, headHost, propsWithOverlay, rawParentOf, setRawParent } from '@kinetographdev/compat/shim';
import type { Unsupported } from '@kinetographdev/scene';
import { domFillOf, flattenDomElement, type EmitOptions, type HostElement, type HostNode } from './emit.js';

/** The root of the host tree, as `root.ts` keeps it. */
export interface Container {
  children: HostNode[];
  /** Bumped when the tree changes: a commit, or a script's write to a style or attribute. */
  generation: number;
  /** Bumped by a commit only: a script's writes (GSAP's, between its reads) are not passes of rendering. */
  commits: number;
  readback: Readback | null;
  /** What a read of the layout could not answer (the engine has no such element): reported with the frame's unsupported content. */
  readFailures: Map<string, Unsupported>;
  /** The commits measured since the frame's work began (see `settle`): one per pass of measuring. */
  measuredGenerations: Set<number>;
  /** The `<img>`, `<video>` and `<audio>` elements made so far (their load events are delivered, see `settle`). */
  media: Set<HostElement>;
}

/** What the reconciler learns about a host node as it is placed: where it hangs, and in which root. */
export interface HostMeta {
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

/** The nearest ancestor that is not a `<Sequence>` (which is transparent); the links are the shim's, which scripts change too. */
const effectiveParent = effectiveParentOf;

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

/** The properties scripts usually read together from one element (GSAP's probes, layout measurements, visibility checks). */
const COMMON_PROPERTIES = [
  'display', 'visibility', 'opacity', 'position', 'overflow', 'overflow-x', 'overflow-y', 'z-index', 'transform', 'transform-origin',
  'transform-box', 'translate', 'rotate', 'scale', 'perspective', 'perspective-origin', 'transform-style', 'will-change', 'filter',
  'width', 'height', 'top', 'left', 'right', 'bottom', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-left-width', 'box-sizing', 'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'flex-direction', 'align-items',
  'justify-content', 'pointer-events', 'clip-path', 'mask-image', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray',
  'stroke-dashoffset', 'cursor', 'content', 'vector-effect',
];

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

  /**
   * The children of `parent` the island sees: an `<AbsoluteFill>` inside DOM is the `div` of `domFillOf`, which drops the
   * layer mapping's background rectangle (the `div`'s own `background` is that), so paths count without it.
   */
  const childrenOf = (parent: HostElement | null): HostNode[] =>
    parent === null ? container.children : parent.type === 'kg-layer' && inCss(parent) ? (domFillOf(parent, true) ?? parent).children : parent.children;

  /** The host-tree path of an element (`$0.2.1`): its index among the elements of its parent, `<Sequence>` transparent. */
  const pathOf = (host: HostElement): string => {
    fresh();
    const known = paths.get(host);
    if (known !== undefined) return known;
    const parent = effectiveParent(host);
    const siblings = flatten(childrenOf(parent)).filter((n) => n.kind === 'element');
    const index = siblings.indexOf(host);
    const path = parent === null ? `$${index}` : `${pathOf(parent)}.${index}`;
    paths.set(host, path);
    return path;
  };

  /** The path of an element computed from the tree as it is now, not from the cache. */
  const pathOfFresh = (host: HostElement): string => {
    const parent = effectiveParent(host);
    const siblings = flatten(childrenOf(parent)).filter((n) => n.kind === 'element');
    const index = siblings.indexOf(host);
    return parent === null ? `$${index}` : `${pathOfFresh(parent)}.${index}`;
  };

  /** A read the engine could not answer is a warning and a fallback, never an error. */
  const failed = (host: HostElement, what: string, error: unknown): void => {
    const path = pathOfFresh(host);
    const reason = `${what} could not be read from the layout (${error instanceof Error ? error.message : String(error)}); answered from the element's own style`;
    container.readFailures.set(`${path}\0${what}`, { path, element: host.type, property: null, value: null, reason });
  };

  const isDom = (node: HostElement | null): node is HostElement => node !== null && isDomElement(node.type);

  /**
   * Whether `node` is part of a CSS tree: a DOM element, or an `<AbsoluteFill>` / `<Sequence>` wrapper that `emit`
   * draws as a `div` (see `domFillOf`): inside DOM always, at the top only when DOM is inside it.
   */
  const inCss = (node: HostElement | null): boolean => {
    if (node === null) return false;
    if (isDomElement(node.type)) return true;
    if (node.type !== 'kg-layer' || node.props.domFill === undefined) return false;
    return inCss(effectiveParent(node)) || domFillOf(node) !== null;
  };

  /** The element at the top of the CSS tree `host` is in: the root of its island. */
  const islandRootOf = (host: HostElement): HostElement => {
    let top = host;
    for (let p = effectiveParent(top); inCss(p); p = effectiveParent(top)) top = p!;
    return top;
  };

  const islandOf = (host: HostElement): Island | null => {
    fresh();
    const root = islandRootOf(host);
    let island = islands.get(root);
    if (island === undefined) {
      const path = pathOf(root);
      const stylesheets = [...importedStylesheets(), ...collectStyleElements([headHost, ...container.children])];
      for (const css of stylesheets) noteStylesheet(css);
      const { request } = requestFor(flattenDomElement(domFillOf(root) ?? root, path, null), {
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

  /** Notes that the layout of this commit's tree is being read; a ninth commit measured in one frame is a loop. */
  const measuring = (): void => {
    container.measuredGenerations.add(container.commits);
    if (container.measuredGenerations.size > MAX_MEASURE_PASSES) throw measureLoopError();
  };

  const readback: Readback = {
    generation: () => container.generation,
    box(host) {
      measuring();
      if (!hasAddonFunction('domLayoutBoxes')) return null;
      const island = islandOf(host);
      if (island === null) return null;
      try {
        island.boxes ??= JSON.parse(addonFunction('domLayoutBoxes')(island.json)) as Boxes;
      } catch (error) {
        failed(host, 'a box', error);
        island.boxes = {};
      }
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
        // One value per property asked for, "" for one the engine does not know.
        try {
          // The engine styles the whole island for every call whatever the number of properties, and scripts read several
          // properties of one element (GSAP reads a dozen): ask for the usual ones together and answer the rest from the cache.
          const asked = [property, ...COMMON_PROPERTIES.filter((p) => p !== property && !island.computed.has(`${pathOf(host)}\0${p}`))];
          const answer = addonFunction('domComputedStyle')(island.json, pathOf(host), asked);
          asked.forEach((name, i) => island.computed.set(`${pathOf(host)}\0${name}`, answer[i] !== undefined && answer[i] !== '' ? answer[i]! : null));
          value = island.computed.get(key) ?? null;
        } catch (error) {
          failed(host, 'a computed style', error);
          value = inlineValue(host, property);
        }
      } else {
        value = inlineValue(host, property);
      }
      island.computed.set(key, value);
      return value;
    },
    textRangeBox(node, start, end) {
      measuring();
      if (!hasAddonFunction('domLayoutBoxes')) return null;
      const parent = effectiveParent(node);
      if (!isDom(parent)) return null;
      const holder = rawParentOf(node) ?? null;
      const list = holder === null ? container.children : holder.children;
      const at = list.indexOf(node);
      if (at === -1) return null;
      // The text split into before, the characters asked for in a `span`, and after: an inline `span` does not change how
      // a line breaks, and its box is the union of the line boxes of what is in it.
      const marker: HostElement = { kind: 'element', type: 'span', props: { 'data-kg-range': '' }, children: [{ kind: 'text', text: node.text.slice(start, end) }] };
      const pieces: HostNode[] = [];
      if (start > 0) pieces.push({ kind: 'text', text: node.text.slice(0, start) });
      pieces.push(marker);
      if (end < node.text.length) pieces.push({ kind: 'text', text: node.text.slice(end) });
      for (const piece of pieces) setRawParent(piece, holder);
      list.splice(at, 1, ...pieces);
      try {
        // Not cached: the tree is as it is only for this call, and the generation must not move (it counts passes).
        const root = islandRootOf(marker);
        const path = pathOfFresh(root);
        const stylesheets = [...importedStylesheets(), ...collectStyleElements([headHost, ...container.children])];
        const { request } = requestFor(flattenDomElement(domFillOf(root) ?? root, path, null), {
          path,
          viewport: options.viewport ?? { width: 1920, height: 1080 },
          fonts: options.fonts?.() ?? {},
          emitNative: () => null,
          time: options.time?.() ?? 0,
          stylesheets,
        });
        const markerPath = ((): string => {
          const p = effectiveParent(marker)!;
          const siblings = flatten(childrenOf(p)).filter((n) => n.kind === 'element');
          return `${pathOfFresh(p)}.${siblings.indexOf(marker)}`;
        })();
        const boxes = JSON.parse(addonFunction('domLayoutBoxes')(JSON.stringify(request))) as Boxes;
        return boxes[markerPath]?.rect ?? null;
      } finally {
        list.splice(at, pieces.length, node);
        for (const piece of pieces) setRawParent(piece, null);
        setRawParent(node, holder);
      }
    },
    parent: (host) => {
      const parent = effectiveParent(host);
      // An `<AbsoluteFill>` holding DOM is the `div` it is in Remotion: a script sees it as the parent.
      return isDom(parent) || (parent !== null && inCss(parent)) ? parent : null;
    },
    childNodes: (host) => flatten(host.children).filter((n) => n.kind === 'text' || isDomElement(n.type)),
    isConnected(host) {
      let top: HostElement = host;
      for (let p = rawParentOf(top); p !== null; p = rawParentOf(top)) top = p;
      return container.children.includes(top);
    },
    viewport: () => options.viewport ?? { width: 1920, height: 1080 },
    touch() {
      container.generation++;
    },
    roots: () => flatten(container.children),
    rootChildren: () => container.children,
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
