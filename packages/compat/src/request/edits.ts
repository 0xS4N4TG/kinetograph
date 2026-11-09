// An island request changed by what a script wrote since it was sent, and the changes as `IslandEdits` of
// crates/dom/src/request.rs (packages/cli/skills/kinetograph/references/ENGINE.md §2): the addon edits the state it
// holds instead of reading the whole tree again. Pure: no addon, no clock.

import type { DomNode } from '../types.js';
import { elementFields, fileResolver, type IslandRequestJson, type RequestNode } from './build.js';
import { isDomElement } from './tags.js';

type ElementNode = Extract<DomNode, { kind: 'element' }>;
type RequestElement = Extract<RequestNode, { kind: 'element' }>;

/** `NodeEdit` of crates/dom/src/request.rs. */
export interface NodeEditJson {
  path: string;
  attrs?: Record<string, string>;
  style?: string;
  /** `[index in children, text]`. */
  texts?: [number, string][];
}

/** A request kept to be changed in place, with its elements by path and whether each is inside an `<svg>`. */
export interface EditableRequest {
  request: IslandRequestJson;
  elements: Map<string, { node: RequestElement; svg: boolean }>;
}

/** What an element a script changed is now. */
export interface ChangedElement {
  path: string;
  /** The element with a script's writes laid over its props (`propsWithOverlay`). */
  node: ElementNode;
  /** Its children as the island has them (each `<Sequence>` replaced by what is inside it): a text's text, else null. */
  children: (string | null)[];
}

/** Elements whose request does not follow from their own props: a sheet, a file of CSS, a canvas's drawing. */
const NOT_EDITABLE = new Set(['style', 'link', 'script', 'canvas']);

/**
 * `request` kept for edits, or null when edits cannot follow it: it holds an element whose request changes without a
 * script's write (a canvas, which carries what was drawn on it).
 */
export function editableRequest(request: IslandRequestJson): EditableRequest | null {
  const elements = new Map<string, { node: RequestElement; svg: boolean }>();
  const visit = (node: RequestNode, insideSvg: boolean): boolean => {
    if (node.kind !== 'element') return true;
    if (node.tag === 'canvas') return false;
    const svg = insideSvg || node.tag === 'svg';
    elements.set(node.path, { node, svg });
    return node.children.every((child) => visit(child, svg));
  };
  return visit(request.root, false) ? { request, elements } : null;
}

/**
 * The edits that make `kept` the request of the island as it is now, with `changed` the elements a script changed
 * since and `time` the clock: `kept` is changed to that request in place. Null when edits cannot say it (an element
 * the request does not have, one whose request does not follow from its own props, children that are not the ones
 * the request has); the request is then built again.
 */
export function islandEdits(kept: EditableRequest, changed: readonly ChangedElement[], time: number): NodeEditJson[] | null {
  const local = fileResolver();
  const found: { node: RequestElement; edit: NodeEditJson; attrs: Record<string, string>; style: string }[] = [];
  for (const { path, node, children } of changed) {
    const entry = kept.elements.get(path);
    if (entry === undefined || entry.node.tag !== node.type || !isDomElement(node.type) || NOT_EDITABLE.has(node.type)) return null;
    if (node.props.dangerouslySetInnerHTML !== undefined) return null;
    const was = entry.node;
    const { attrs, style } = elementFields(node, entry.svg, kept.request.viewport, local);
    const edit: NodeEditJson = { path };
    if (!sameRecord(attrs, was.attrs)) edit.attrs = attrs;
    if (style !== was.style) edit.style = style;
    if (children.length !== was.children.length) return null;
    const texts: [number, string][] = [];
    for (let i = 0; i < children.length; i++) {
      const now = children[i]!;
      const child = was.children[i]!;
      if ((now === null) !== (child.kind !== 'text')) return null;
      if (now !== null && child.kind === 'text' && child.text !== now) texts.push([i, now]);
    }
    if (texts.length > 0) edit.texts = texts;
    found.push({ node: was, edit, attrs, style });
  }
  // Nothing is changed until every element could be said.
  const set: NodeEditJson[] = [];
  for (const { node, edit, attrs, style } of found) {
    node.attrs = attrs;
    node.style = style;
    for (const [i, text] of edit.texts ?? []) node.children[i] = { kind: 'text', text };
    if (edit.attrs !== undefined || edit.style !== undefined || edit.texts !== undefined) set.push(edit);
  }
  kept.request.time = time;
  return set;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}
