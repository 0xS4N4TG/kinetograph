// Changing the host tree from a script (packages/cli/skills/kinetograph/references/ENGINE.md §1, "Readback"): `appendChild`, `prepend`, `insertBefore`,
// `removeChild`, `replaceChildren` and the rest of the DOM's tree methods, on the same tree the reconciler keeps and
// `emit` draws from, so a library that mounts its own nodes (a canvas, a `<style>`) is drawn with the rest. There is no
// second tree: a node is a `DomNode` (data) whose place is its raw parent link (`host.ts`), set by whoever puts it there.
//
// React's own insertions and a script's meet in the same `children` lists. React places a child by `insertBefore` one
// of its own siblings, or appends it; a node a script put between or after them stays where it is, as in a browser.

import { isDomElement } from '../request/tags.js';
import {
  bodyChildren,
  bodyHost,
  currentBodyRoot,
  effectiveParentOf,
  headHost,
  htmlHost,
  overlayOf,
  pageViewport,
  propsWithOverlay,
  rawParentOf,
  readbackRoots,
  setRawParent,
  type HostElement,
  type Readback,
} from './host.js';
import type { DomNode } from '../types.js';

export type HostText = Extract<DomNode, { kind: 'text' }>;

/** What a mutation observer is told. `target` is the element whose children or attributes changed. */
export type HostMutation =
  | { type: 'childList'; target: HostElement; added: DomNode[]; removed: DomNode[]; previous: DomNode | null; next: DomNode | null }
  | { type: 'attributes'; target: HostElement; name: string; old: string | null }
  | { type: 'characterData'; target: HostText; old: string };

let sink: ((mutation: HostMutation) => void) | null = null;

/** The mutation observers hand over where changes are reported (`observers.ts`). */
export function setMutationSink(fn: ((mutation: HostMutation) => void) | null): void {
  sink = fn;
}

/** Reports a change to the observers: also the reconciler's own (a child it placed), so one root of changes is seen. */
export function recordMutation(mutation: HostMutation): void {
  sink?.(mutation);
}

/** Whether anything listens for mutations (the reconciler skips the work when nothing does). */
export function isRecordingMutations(): boolean {
  return sink !== null;
}

// ---- the readback of a node ----

const flatten = (nodes: DomNode[], out: DomNode[] = []): DomNode[] => {
  for (const node of nodes) {
    if (node.kind === 'element' && node.type === 'kg-sequence') flatten(node.children, out);
    else out.push(node);
  }
  return out;
};

/** A property's value from the element's own style, when nothing laid it out. */
function inlineValue(host: HostElement, property: string): string | null {
  const style = propsWithOverlay(host).style;
  if (typeof style !== 'object' || style === null) return null;
  const camel = property.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  const value = (style as Record<string, unknown>)[camel] ?? (style as Record<string, unknown>)[property];
  return value === undefined || value === null || value === '' ? null : String(value);
}

/** The top of a node's parent chain. */
function topOf(node: DomNode): DomNode {
  let top = node;
  for (let p = rawParentOf(top); p !== null; p = rawParentOf(top)) top = p;
  return top;
}

/** Whether `node` hangs from `document.head` or `document.documentElement` (it is part of the document, laid out or not). */
function inDocumentShell(node: DomNode): boolean {
  const top = topOf(node);
  return top === htmlHost || top === headHost || top === bodyHost;
}

/** What a node that no root holds (made by a script, or in `document.head`) answers: no boxes, its own style. */
export const detachedReadback: Readback = {
  generation: () => 0,
  box: () => null,
  computed: inlineValue,
  parent(host) {
    const parent = effectiveParentOf(host);
    return parent !== null && isDomElement(parent.type) ? parent : null;
  },
  childNodes: (host) => flatten(host.children).filter((n) => n.kind === 'text' || isDomElement(n.type)),
  isConnected: inDocumentShell,
  viewport: () => currentBodyRoot()?.viewport() ?? pageViewport(),
  touch: () => currentBodyRoot()?.touch(),
  roots: () => [],
  descendants: () => [],
  rootChildren: () => [],
};

/** The root whose tree holds `host`, else the detached one. */
export function readbackOfHost(host: HostElement): Readback {
  for (const readback of readbackRoots()) if (readback.isConnected(host)) return readback;
  return detachedReadback;
}

/** `html`, `head` and `body` of `document`. */
export function isShellHost(host: HostElement): boolean {
  return host === htmlHost || host === headHost || host === bodyHost;
}

/** Whether a node is in the document: in a root's tree, or in `head`/`body`. */
export function isConnectedHost(node: DomNode): boolean {
  if (inDocumentShell(node)) return true;
  // What a script put on `document.body` before a root held it (at module load) waits in the body's list.
  if (bodyChildren().includes(topOf(node))) return true;
  for (const readback of readbackRoots()) if (node.kind === 'element' ? readback.isConnected(node) : textIsConnected(readback, node)) return true;
  return false;
}

function textIsConnected(readback: Readback, node: HostText): boolean {
  const parent = rawParentOf(node);
  return parent !== null ? readback.isConnected(parent) : readback.rootChildren().includes(node);
}

// ---- making nodes ----

/** Elements a script makes: the tag as a DOM host element (a name the engine has no element for is a `div`). */
export function createHostElement(tag: string, svg = false): HostElement {
  const name = String(tag);
  const lower = name.toLowerCase();
  const type = svg ? name : isDomElement(lower) ? lower : isDomElement(name) ? name : 'div';
  return { kind: 'element', type, props: {}, children: [] };
}

export function createHostText(text: string): HostText {
  return { kind: 'text', text: String(text) };
}

/** A copy of a node (and, when `deep`, everything in it): props and what a script wrote on top of them. */
export function cloneHost(node: DomNode, deep: boolean): DomNode {
  if (node.kind === 'text') return createHostText(node.text);
  const copy: HostElement = { kind: 'element', type: node.type, props: { ...propsWithOverlay(node) }, children: [] };
  if (deep) {
    for (const child of node.children) {
      const made = cloneHost(child, true);
      setRawParent(made, copy);
      copy.children.push(made);
    }
  }
  return copy;
}

// ---- placing and removing ----

/** The list `parent` keeps its children in (the top level of the current root for `document.body`). */
function listOf(parent: HostElement): DomNode[] {
  return parent === bodyHost ? bodyChildren() : parent.children;
}

/** `node` is `ancestor`, or inside it. */
function isInclusiveDescendant(node: DomNode, ancestor: DomNode): boolean {
  for (let n: DomNode | null = node; n !== null; n = rawParentOf(n)) if (n === ancestor) return true;
  return false;
}

class TreeError extends Error {
  constructor(message: string, readonly code: number, name: string) {
    super(message);
    this.name = name;
  }
}

const hierarchy = (message: string): TreeError => new TreeError(message, 3, 'HierarchyRequestError');
const notFound = (message: string): TreeError => new TreeError(message, 8, 'NotFoundError');

/** The list a top-level node is in: the current root's, or any root that holds it. */
function topLevelListHolding(node: DomNode): DomNode[] | null {
  const body = bodyChildren();
  if (body.includes(node)) return body;
  for (const readback of readbackRoots()) {
    const top = readback.rootChildren();
    if (top.includes(node)) return top;
  }
  return null;
}

/** The element a node's list belongs to for observers: its DOM parent, `body` at the top. */
function observedParentOf(node: DomNode): HostElement | null {
  const parent = effectiveParentOf(node);
  if (parent !== null) return parent;
  return topLevelListHolding(node) !== null ? bodyHost : null;
}

/** Takes `node` out of the tree it is in (nothing when it is in none). */
export function removeChild(node: DomNode): void {
  const raw = rawParentOf(node);
  const list = raw !== null ? raw.children : topLevelListHolding(node);
  if (list === null) return;
  const at = list.indexOf(node);
  if (at === -1) return;
  const target = raw !== null ? (effectiveParentOf(node) ?? raw) : bodyHost;
  const readback = readbackOfHost(target);
  const previous = flatten(list.slice(0, at)).pop() ?? null;
  const next = flatten(list.slice(at + 1))[0] ?? null;
  list.splice(at, 1);
  setRawParent(node, null);
  readback.touch();
  recordMutation({ type: 'childList', target, added: [], removed: [node], previous, next });
}

/**
 * Puts `child` into `parent`'s children before `before` (at the end when null), taking it out of wherever it was. Throws
 * what the DOM throws for a node that cannot go there: itself or an ancestor, and a `before` that is not a child.
 */
export function insertChild(parent: HostElement, child: DomNode, before: DomNode | null): void {
  if (child.kind === 'element' && isInclusiveDescendant(parent, child)) {
    throw hierarchy("Failed to execute 'insertBefore' on 'Node': The new child element contains the parent.");
  }
  if (before === child) {
    return;
  }
  let holder: HostElement | null;
  let list: DomNode[];
  if (before !== null) {
    const seenParent = observedParentOf(before);
    if (seenParent !== parent) {
      throw notFound("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
    }
    const raw = rawParentOf(before);
    holder = raw;
    list = raw !== null ? raw.children : (topLevelListHolding(before) ?? bodyChildren());
  } else {
    holder = parent === bodyHost ? null : parent;
    list = listOf(parent);
  }
  removeChild(child);
  const at = before === null ? list.length : list.indexOf(before);
  list.splice(at === -1 ? list.length : at, 0, child);
  setRawParent(child, holder);
  const previous = flatten(list.slice(0, list.indexOf(child))).pop() ?? null;
  const next = flatten(list.slice(list.indexOf(child) + 1))[0] ?? null;
  readbackOfHost(parent).touch();
  recordMutation({ type: 'childList', target: parent, added: [child], removed: [], previous, next });
}

/** Puts `child` at the end of the top level of the current root (`document.body.appendChild`). */
export function appendToBody(child: DomNode): void {
  insertChild(bodyHost, child, null);
}

/** A script's change to what a text node says. */
export function setText(node: HostText, text: string): void {
  if (node.text === text) return;
  const old = node.text;
  node.text = text;
  const parent = effectiveParentOf(node);
  (parent === null ? currentBodyRoot() : readbackOfHost(parent))?.touch();
  recordMutation({ type: 'characterData', target: node, old });
}

/** A script's change to an attribute (including a style written through `element.style`), for the observers. */
export function recordAttribute(host: HostElement, name: string, old: string | null): void {
  recordMutation({ type: 'attributes', target: host, name, old });
}

/** Everything in `host`, removed (and the observers told once, as one change). */
export function clearChildren(host: HostElement): DomNode[] {
  const list = listOf(host);
  const removed = list.slice();
  if (removed.length === 0) return removed;
  for (const node of removed) setRawParent(node, null);
  list.length = 0;
  readbackOfHost(host).touch();
  recordMutation({ type: 'childList', target: host, added: [], removed, previous: null, next: null });
  return removed;
}

/** The attribute a script last set, for `attributeOldValue`. */
export function oldAttribute(host: HostElement, name: string): string | null {
  const overlay = overlayOf(host, false);
  if (overlay?.attrs.has(name)) return overlay.attrs.get(name) ?? null;
  const props = host.props;
  const raw = name === 'class' ? props.className : props[name];
  return raw === undefined || raw === null ? null : String(raw);
}
