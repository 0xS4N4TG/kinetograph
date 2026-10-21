// `ResizeObserver`, `IntersectionObserver` and `MutationObserver` for DOM refs (docs/ENGINE.md §1, "Readback").
// A frame is rendered once, so there is no animation of time between observations: the observers are delivered by the
// root after each pass of React's work on the frame, `deliverObservations()`, and a callback that sets state makes
// the root render again before the frame is emitted. Everything is "visible"; nothing scrolls.

import { DOMRectShim, domElementFor, domNodeFor, hostNodeOf, hostOf, type DomElement } from './element.js';
import { bodyHost, effectiveParentOf, headHost, htmlHost, readbackRoots, registerReadbackRoot, unregisterReadbackRoot, type Readback } from './host.js';
import { isConnectedHost, setMutationSink, type HostMutation } from './tree.js';
import type { DomNode } from '../types.js';

export { readbackRoots, registerReadbackRoot, unregisterReadbackRoot };

const resizeObservers = new Set<ResizeObserverShim>();
const intersectionObservers = new Set<IntersectionObserverShim>();

/** Passes of observer delivery within one `deliverObservations` before it gives up on a loop. */
export const MAX_OBSERVER_DEPTH = 8;

interface SizeBox {
  inlineSize: number;
  blockSize: number;
}

function resizeEntry(target: DomElement, readback: Readback) {
  const box = readback.box(target.host);
  const w = box?.width ?? 0;
  const h = box?.height ?? 0;
  const padding = (side: string): number => parseFloat(readback.computed(target.host, `padding-${side}`) ?? '0') || 0;
  const border = (side: string): number => parseFloat(readback.computed(target.host, `border-${side}-width`) ?? '0') || 0;
  const cw = Math.max(0, w - padding('left') - padding('right') - border('left') - border('right'));
  const ch = Math.max(0, h - padding('top') - padding('bottom') - border('top') - border('bottom'));
  const sizeOf = (a: number, b: number): SizeBox[] => [{ inlineSize: a, blockSize: b }];
  return {
    target,
    contentRect: new DOMRectShim(padding('left') + border('left'), padding('top') + border('top'), cw, ch),
    borderBoxSize: sizeOf(w, h),
    contentBoxSize: sizeOf(cw, ch),
    devicePixelContentBoxSize: sizeOf(cw, ch),
  };
}

export class ResizeObserverShim {
  /** target → the border-box size last delivered (0 x 0 before the first, as the spec starts). */
  readonly targets = new Map<DomElement, { w: number; h: number }>();
  constructor(private readonly callback: (entries: ReturnType<typeof resizeEntry>[], observer: ResizeObserverShim) => void) {
    if (typeof callback !== 'function') throw new TypeError("Failed to construct 'ResizeObserver': The callback provided as parameter 1 is not a function.");
    resizeObservers.add(this);
  }
  observe(target: unknown): void {
    const host = hostOf(target);
    if (host === null) throw new TypeError("Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'.");
    const element = target as DomElement;
    if (!this.targets.has(element)) this.targets.set(element, { w: 0, h: 0 });
  }
  unobserve(target: unknown): void {
    this.targets.delete(target as DomElement);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): [] {
    return [];
  }
  /** Delivers the changes since the last delivery; true when the callback ran. */
  deliver(readbackOf: (element: DomElement) => Readback | null): boolean {
    const entries: ReturnType<typeof resizeEntry>[] = [];
    for (const [element, last] of this.targets) {
      const readback = readbackOf(element);
      if (readback === null || !readback.isConnected(element.host)) continue;
      const entry = resizeEntry(element, readback);
      const { inlineSize: w, blockSize: h } = entry.borderBoxSize[0]!;
      if (w !== last.w || h !== last.h) {
        last.w = w;
        last.h = h;
        entries.push(entry);
      }
    }
    if (entries.length === 0) return false;
    this.callback(entries, this);
    return true;
  }
}

export class IntersectionObserverShim {
  readonly root: unknown;
  readonly rootMargin: string;
  readonly thresholds: number[];
  private readonly targets = new Map<DomElement, boolean>();
  constructor(
    private readonly callback: (entries: object[], observer: IntersectionObserverShim) => void,
    options: { root?: unknown; rootMargin?: string; threshold?: number | number[] } = {},
  ) {
    if (typeof callback !== 'function') throw new TypeError("Failed to construct 'IntersectionObserver': The callback provided as parameter 1 is not a function.");
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold) ? options.threshold : [options.threshold ?? 0];
    intersectionObservers.add(this);
  }
  observe(target: unknown): void {
    if (hostOf(target) === null) throw new TypeError("Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'.");
    if (!this.targets.has(target as DomElement)) this.targets.set(target as DomElement, false);
  }
  unobserve(target: unknown): void {
    this.targets.delete(target as DomElement);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): [] {
    return [];
  }
  /** Everything is visible: each newly observed target is reported once, intersecting entirely. */
  deliver(readbackOf: (element: DomElement) => Readback | null): boolean {
    const entries: object[] = [];
    for (const [element, reported] of this.targets) {
      if (reported) continue;
      const readback = readbackOf(element);
      if (readback === null || !readback.isConnected(element.host)) continue;
      this.targets.set(element, true);
      const rect = element.getBoundingClientRect();
      const view = readback.viewport();
      const hasArea = rect.width > 0 && rect.height > 0;
      entries.push({
        target: element,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: rect,
        intersectionRect: hasArea ? rect : new DOMRectShim(rect.x, rect.y, 0, 0),
        rootBounds: this.root ? null : new DOMRectShim(0, 0, view.width, view.height),
        time: (globalThis.performance?.now?.() ?? 0),
      });
    }
    if (entries.length === 0) return false;
    this.callback(entries, this);
    return true;
  }
}

// ---- MutationObserver ----

interface MutationOptions {
  childList?: boolean;
  attributes?: boolean;
  characterData?: boolean;
  subtree?: boolean;
  attributeOldValue?: boolean;
  characterDataOldValue?: boolean;
  attributeFilter?: string[];
}

interface MutationRecordShim {
  type: 'childList' | 'attributes' | 'characterData';
  target: unknown;
  addedNodes: unknown[];
  removedNodes: unknown[];
  previousSibling: unknown;
  nextSibling: unknown;
  attributeName: string | null;
  attributeNamespace: null;
  oldValue: string | null;
}

const mutationObservers = new Set<MutationObserverShim>();

/** What a script (or the reconciler, for a child it placed) changed in the tree, reported to the observers that watch it. */
function onMutation(mutation: HostMutation): void {
  for (const observer of mutationObservers) observer.record(mutation);
}

/** A `MutationObserver` over the host tree: a script's `appendChild`, `setAttribute` and the rest, and the children React places. Delivered after layout, like the others. */
export class MutationObserverShim {
  private readonly targets = new Map<unknown, MutationOptions>();
  private queue: MutationRecordShim[] = [];
  constructor(private readonly callback: (records: MutationRecordShim[], observer: MutationObserverShim) => void) {
    if (typeof callback !== 'function') throw new TypeError("Failed to construct 'MutationObserver': The callback provided as parameter 1 is not a function.");
  }
  observe(target: unknown, options: MutationOptions = {}): void {
    const host = hostNodeOf(target);
    if (host === null) throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
    const attributes = options.attributes ?? (options.attributeOldValue !== undefined || options.attributeFilter !== undefined ? true : undefined);
    const characterData = options.characterData ?? (options.characterDataOldValue !== undefined ? true : undefined);
    if (!options.childList && !attributes && !characterData) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.");
    }
    this.targets.set(host, { ...options, attributes, characterData });
    mutationObservers.add(this);
    setMutationSink(onMutation);
  }
  disconnect(): void {
    this.targets.clear();
    this.queue = [];
    mutationObservers.delete(this);
    if (mutationObservers.size === 0) setMutationSink(null);
  }
  takeRecords(): MutationRecordShim[] {
    const records = this.queue;
    this.queue = [];
    return records;
  }
  /** The observed target a change in `node` is seen through: `node` itself, or an ancestor watched with `subtree`. */
  private watching(node: DomNode): MutationOptions | null {
    for (let n: DomNode | null = node, first = true; n !== null; n = effectiveParentOf(n) ?? (isConnectedHost(n) && n !== bodyHost && n !== htmlHost && n !== headHost ? bodyHost : null), first = false) {
      const options = this.targets.get(n);
      if (options !== undefined && (first || options.subtree)) return options;
    }
    return null;
  }
  record(mutation: HostMutation): void {
    const options = this.watching(mutation.target);
    if (options === null) return;
    let record: MutationRecordShim;
    if (mutation.type === 'childList') {
      if (!options.childList) return;
      record = {
        type: 'childList',
        target: domNodeFor(mutation.target),
        addedNodes: mutation.added.map(domNodeFor),
        removedNodes: mutation.removed.map(domNodeFor),
        previousSibling: mutation.previous === null ? null : domNodeFor(mutation.previous),
        nextSibling: mutation.next === null ? null : domNodeFor(mutation.next),
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
      };
    } else if (mutation.type === 'attributes') {
      if (!options.attributes) return;
      if (options.attributeFilter && !options.attributeFilter.includes(mutation.name)) return;
      record = {
        type: 'attributes', target: domNodeFor(mutation.target), addedNodes: [], removedNodes: [], previousSibling: null, nextSibling: null,
        attributeName: mutation.name, attributeNamespace: null, oldValue: options.attributeOldValue ? mutation.old : null,
      };
    } else {
      if (!options.characterData) return;
      record = {
        type: 'characterData', target: domNodeFor(mutation.target), addedNodes: [], removedNodes: [], previousSibling: null, nextSibling: null,
        attributeName: null, attributeNamespace: null, oldValue: options.characterDataOldValue ? mutation.old : null,
      };
    }
    this.queue.push(record);
  }
  /** Delivers what was recorded since the last delivery; true when the callback ran. */
  deliver(): boolean {
    const records = this.takeRecords();
    if (records.length === 0) return false;
    this.callback(records, this);
    return true;
  }
}

/** The root an element belongs to: the one whose tree holds it. */
function readbackOf(element: DomElement): Readback | null {
  for (const readback of readbackRoots()) if (readback.isConnected(element.host)) return readback;
  return null;
}

/**
 * Delivers resize and intersection observations for the current layout, as the browser does after layout. Returns
 * true when a callback ran (it may have set state: the root renders again, then calls this again). The caller stops
 * after `MAX_OBSERVER_DEPTH` rounds.
 */
export function deliverObservations(): boolean {
  let any = false;
  for (const observer of [...resizeObservers]) any = observer.deliver(readbackOf) || any;
  for (const observer of [...intersectionObservers]) any = observer.deliver(readbackOf) || any;
  for (const observer of [...mutationObservers]) any = observer.deliver() || any;
  return any;
}

/** Whether any observer is waiting on something (so a root can skip the delivery when none exists). */
export function hasObservers(): boolean {
  return resizeObservers.size > 0 || intersectionObservers.size > 0 || mutationObservers.size > 0;
}

/** Drops every observer (tests; a new composition). */
export function resetObservers(): void {
  resizeObservers.clear();
  intersectionObservers.clear();
  mutationObservers.clear();
  setMutationSink(null);
}

export { domElementFor };
