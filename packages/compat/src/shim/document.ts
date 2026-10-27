// Documents beyond the page's own, and the traversal API a sanitizer or a walker over the DOM needs: `DOMParser`,
// `document.implementation.createHTMLDocument`, `NodeIterator`, `TreeWalker`, `NodeFilter`, `HTMLTemplateElement`
// and `HTMLFormElement` (DOMPurify finds its document through them, so Mermaid, which sanitizes every label, needs all of
// these). A parsed document is a host tree like any other, `html > head, body`, owned by a `DocumentShim`: its nodes are the
// same `DomElement`s and `DomText`s, parsed by the same fragment parser `innerHTML` uses.

import { parseHtmlFragment } from '../request/html.js';
import type { DomNode } from '../types.js';
import {
  DomElement,
  DomFragment,
  DomNodeBase,
  DomText,
  domElementFor,
  domNodeFor,
  domTextFor,
  hostNodeOf,
  parsedNodes,
  setDocumentRoot,
  setInertDocumentFactory,
  setOwnerDocument,
} from './element.js';
import type { HostElement } from './host.js';
import { setRawParent } from './host.js';
import { collectionOf, nodeListOf, type HTMLCollection, type NodeList } from './lists.js';
import { cloneHost, createHostElement, createHostText, removeChild, setRemovalHook } from './tree.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- NodeFilter ----

export const NodeFilterShim = {
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_ATTRIBUTE: 0x2,
  SHOW_TEXT: 0x4,
  SHOW_CDATA_SECTION: 0x8,
  SHOW_ENTITY_REFERENCE: 0x10,
  SHOW_ENTITY: 0x20,
  SHOW_PROCESSING_INSTRUCTION: 0x40,
  SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100,
  SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
  SHOW_NOTATION: 0x800,
} as const;

type Filter = ((node: any) => number) | { acceptNode(node: any): number } | null;

/** A node as the walkers see it: elements, text, fragments and documents. */
type Walked = DomElement | DomText | DocumentShim;

const kidsOf = (node: Walked): Walked[] => {
  if (node instanceof DocumentShim) return node.documentElement === null ? [] : [node.documentElement];
  if (node instanceof DomText) return [];
  return Array.from(node.childNodes);
};
const firstChildOf = (node: Walked): Walked | null => kidsOf(node)[0] ?? null;
const lastChildOf = (node: Walked): Walked | null => kidsOf(node).at(-1) ?? null;
const nextSiblingOf = (node: Walked): Walked | null => (node instanceof DocumentShim ? null : node.nextSibling);
const previousSiblingOf = (node: Walked): Walked | null => (node instanceof DocumentShim ? null : node.previousSibling);
const parentOf = (node: Walked): Walked | null => (node instanceof DocumentShim ? null : (node.parentNode as Walked | null));

function lastInclusiveDescendant(node: Walked): Walked {
  for (let last = lastChildOf(node); last !== null; last = lastChildOf(node)) node = last;
  return node;
}

/** The node after `node` in tree order inside `root` (null at the end). */
function following(node: Walked, root: Walked): Walked | null {
  const child = firstChildOf(node);
  if (child !== null) return child;
  for (let n: Walked | null = node; n !== null && n !== root; n = parentOf(n)) {
    const sibling = nextSiblingOf(n);
    if (sibling !== null) return sibling;
  }
  return null;
}

/** The node before `node` in tree order inside `root`. */
function preceding(node: Walked, root: Walked): Walked | null {
  if (node === root) return null;
  const sibling = previousSiblingOf(node);
  return sibling !== null ? lastInclusiveDescendant(sibling) : parentOf(node);
}

function acceptNode(whatToShow: number, filter: Filter, node: Walked): number {
  const type = node instanceof DocumentShim ? 9 : node.nodeType;
  if ((whatToShow & (1 << (type - 1))) === 0) return NodeFilterShim.FILTER_SKIP;
  if (filter === null) return NodeFilterShim.FILTER_ACCEPT;
  return typeof filter === 'function' ? filter(node) : filter.acceptNode(node);
}

// ---- NodeIterator ----

const iterators = new Set<WeakRef<NodeIteratorShim>>();

export class NodeIteratorShim {
  referenceNode: Walked;
  pointerBeforeReferenceNode = true;
  readonly whatToShow: number;
  constructor(readonly root: Walked, whatToShow: number, readonly filter: Filter) {
    this.whatToShow = whatToShow >>> 0;
    this.referenceNode = root;
    iterators.add(new WeakRef(this));
  }
  private traverse(next: boolean): Walked | null {
    let node = this.referenceNode;
    let before = this.pointerBeforeReferenceNode;
    for (;;) {
      if (next) {
        if (!before) {
          const found = following(node, this.root);
          if (found === null) return null;
          node = found;
        } else {
          before = false;
        }
      } else if (before) {
        const found = preceding(node, this.root);
        if (found === null) return null;
        node = found;
      } else {
        before = true;
      }
      if (acceptNode(this.whatToShow, this.filter, node) === NodeFilterShim.FILTER_ACCEPT) break;
    }
    this.referenceNode = node;
    this.pointerBeforeReferenceNode = before;
    return node;
  }
  nextNode(): Walked | null {
    return this.traverse(true);
  }
  previousNode(): Walked | null {
    return this.traverse(false);
  }
  detach(): void {}
  /** A node is about to leave the tree: when the iterator stands in it, it moves to where the walk goes on after it. */
  removing(removed: Walked, previous: Walked | null, parent: Walked): void {
    if (removed === this.root) return;
    const reference = this.referenceNode;
    let inside = false;
    for (let n: Walked | null = reference; n !== null; n = parentOf(n)) {
      if (n === removed) {
        inside = true;
        break;
      }
    }
    if (!inside) return;
    if (this.pointerBeforeReferenceNode) {
      for (let n: Walked | null = removed; n !== null && n !== this.root; n = parentOf(n)) {
        const sibling = nextSiblingOf(n);
        if (sibling !== null) {
          this.referenceNode = sibling;
          return;
        }
      }
      this.pointerBeforeReferenceNode = false;
    }
    this.referenceNode = previous !== null ? lastInclusiveDescendant(previous) : parent;
  }
}

setRemovalHook((node: DomNode, parent: HostElement, previous: DomNode | null) => {
  if (iterators.size === 0) return;
  let removed: Walked | null = null;
  for (const ref of iterators) {
    const iterator = ref.deref();
    if (iterator === undefined) {
      iterators.delete(ref);
      continue;
    }
    removed ??= domNodeFor(node);
    iterator.removing(removed, previous === null ? null : domNodeFor(previous), domElementFor(parent));
  }
});

// ---- TreeWalker ----

export class TreeWalkerShim {
  currentNode: Walked;
  readonly whatToShow: number;
  constructor(readonly root: Walked, whatToShow: number, readonly filter: Filter) {
    this.whatToShow = whatToShow >>> 0;
    this.currentNode = root;
  }
  private accept(node: Walked): number {
    return acceptNode(this.whatToShow, this.filter, node);
  }
  parentNode(): Walked | null {
    let node: Walked | null = this.currentNode;
    while (node !== null && node !== this.root) {
      node = parentOf(node);
      if (node !== null && this.accept(node) === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
    }
    return null;
  }
  private children(first: boolean): Walked | null {
    const step = first ? firstChildOf : lastChildOf;
    let node = step(this.currentNode);
    while (node !== null) {
      const result = this.accept(node);
      if (result === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
      if (result === NodeFilterShim.FILTER_SKIP) {
        const child = step(node);
        if (child !== null) {
          node = child;
          continue;
        }
      }
      for (;;) {
        const sibling: Walked | null = first ? nextSiblingOf(node) : previousSiblingOf(node);
        if (sibling !== null) {
          node = sibling;
          break;
        }
        const parent = parentOf(node);
        if (parent === null || parent === this.root || parent === this.currentNode) return null;
        node = parent;
      }
    }
    return null;
  }
  firstChild(): Walked | null {
    return this.children(true);
  }
  lastChild(): Walked | null {
    return this.children(false);
  }
  private siblings(next: boolean): Walked | null {
    let node = this.currentNode;
    if (node === this.root) return null;
    for (;;) {
      let sibling = next ? nextSiblingOf(node) : previousSiblingOf(node);
      while (sibling !== null) {
        node = sibling;
        const result = this.accept(node);
        if (result === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
        sibling = next ? firstChildOf(node) : lastChildOf(node);
        if (result === NodeFilterShim.FILTER_REJECT || sibling === null) sibling = next ? nextSiblingOf(node) : previousSiblingOf(node);
      }
      const parent = parentOf(node);
      if (parent === null || parent === this.root) return null;
      if (this.accept(parent) === NodeFilterShim.FILTER_ACCEPT) return null;
      node = parent;
    }
  }
  nextSibling(): Walked | null {
    return this.siblings(true);
  }
  previousSibling(): Walked | null {
    return this.siblings(false);
  }
  nextNode(): Walked | null {
    let node = this.currentNode;
    let result: number = NodeFilterShim.FILTER_ACCEPT;
    for (;;) {
      for (let child = firstChildOf(node); result !== NodeFilterShim.FILTER_REJECT && child !== null; child = firstChildOf(node)) {
        node = child;
        result = this.accept(node);
        if (result === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
      }
      let sibling: Walked | null = null;
      for (let temp: Walked | null = node; temp !== null; temp = parentOf(temp)) {
        if (temp === this.root) return null;
        sibling = nextSiblingOf(temp);
        if (sibling !== null) break;
      }
      if (sibling === null) return null;
      node = sibling;
      result = this.accept(node);
      if (result === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
    }
  }
  previousNode(): Walked | null {
    let node = this.currentNode;
    while (node !== this.root) {
      let sibling = previousSiblingOf(node);
      while (sibling !== null) {
        node = sibling;
        let result = this.accept(node);
        for (let child = lastChildOf(node); result !== NodeFilterShim.FILTER_REJECT && child !== null; child = lastChildOf(node)) {
          node = child;
          result = this.accept(node);
        }
        if (result === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
        sibling = previousSiblingOf(node);
      }
      if (node === this.root) return null;
      const parent = parentOf(node);
      if (parent === null) return null;
      node = parent;
      if (this.accept(node) === NodeFilterShim.FILTER_ACCEPT) return (this.currentNode = node);
    }
    return null;
  }
}

/** `document.createNodeIterator` and `createTreeWalker` need no document state: they walk the node they are given. */
export function createNodeIterator(root: Walked, whatToShow: number = 0xffffffff, filter: Filter = null): NodeIteratorShim {
  return new NodeIteratorShim(root, whatToShow, filter);
}
export function createTreeWalker(root: Walked, whatToShow: number = 0xffffffff, filter: Filter = null): TreeWalkerShim {
  return new TreeWalkerShim(root, whatToShow, filter);
}

// ---- documents ----

const HEAD_ONLY = new Set(['base', 'link', 'meta', 'script', 'style', 'title', 'template', 'noscript']);

const adopt = (parent: HostElement, child: DomNode): void => {
  parent.children.push(child);
  setRawParent(child, parent);
};

/** A document that is not the page: `html > head, body` for HTML, whatever root the markup had for XML. */
export class DocumentShim extends DomNodeBase {
  doctype: { name: string; publicId: string; systemId: string; nodeType: number } | null = null;
  readonly defaultView = null;
  readonly characterSet = 'UTF-8';
  readonly compatMode = 'CSS1Compat';
  private root: HostElement | null = null;

  constructor(readonly contentType: string = 'text/html') {
    super();
  }
  // `Node` getters read `host`; a document has none.
  override get nodeType(): number {
    return 9;
  }
  override get nodeName(): string {
    return '#document';
  }
  override get nodeValue(): null {
    return null;
  }
  override get ownerDocument(): null {
    return null;
  }
  get parentNode(): null {
    return null;
  }
  get nextSibling(): null {
    return null;
  }
  get previousSibling(): null {
    return null;
  }
  get isConnected(): boolean {
    return true;
  }

  /** Makes `host` the document element (and its `head` and `body` the document's). */
  setRoot(host: HostElement): void {
    this.root = host;
    setDocumentRoot(host, this);
  }
  get documentElement(): DomElement | null {
    return this.root === null ? null : domElementFor(this.root);
  }
  private child(type: string): DomElement | null {
    const found = this.root?.children.find((c) => c.kind === 'element' && c.type === type);
    return found === undefined || found.kind !== 'element' ? null : domElementFor(found);
  }
  get head(): DomElement | null {
    return this.contentType === 'text/html' ? this.child('head') : null;
  }
  get body(): DomElement | null {
    return this.contentType === 'text/html' ? this.child('body') : null;
  }
  get title(): string {
    return this.documentElement?.getElementsByTagName('title')[0]?.textContent ?? '';
  }
  get implementation(): DOMImplementationShim {
    return implementation;
  }
  get childNodes(): NodeList<DomElement> {
    return nodeListOf(this.documentElement === null ? [] : [this.documentElement]);
  }
  get children(): HTMLCollection<DomElement> {
    return collectionOf(this.documentElement === null ? [] : [this.documentElement]);
  }
  get firstChild(): DomElement | null {
    return this.documentElement;
  }
  get lastChild(): DomElement | null {
    return this.documentElement;
  }
  get firstElementChild(): DomElement | null {
    return this.documentElement;
  }
  get lastElementChild(): DomElement | null {
    return this.documentElement;
  }
  hasChildNodes(): boolean {
    return this.root !== null;
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    const root = this.documentElement;
    return root !== null && root.contains(other);
  }
  getRootNode(): this {
    return this;
  }

  createElement(tag: string): DomElement {
    const element = domElementFor(createHostElement(String(tag)));
    setOwnerDocument(element.host, this);
    return element;
  }
  createElementNS(ns: string | null, tag: string): DomElement {
    const element = domElementFor(createHostElement(String(tag), ns === SVG_NS));
    setOwnerDocument(element.host, this);
    return element;
  }
  createTextNode(text: string): DomText {
    const node = domTextFor(createHostText(String(text)));
    setOwnerDocument(node.host, this);
    return node;
  }
  createDocumentFragment(): DomFragment {
    const fragment = new DomFragment();
    setOwnerDocument(fragment.host, this);
    return fragment;
  }
  createNodeIterator = createNodeIterator;
  createTreeWalker = createTreeWalker;
  /** A copy of `node` that belongs to this document. */
  importNode<T>(node: T, deep = false): T {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError("Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.");
    const copy = cloneHost(host, Boolean(deep));
    setOwnerDocument(copy, this);
    return domNodeFor(copy) as T;
  }
  /** Takes `node` out of its tree and makes it this document's. */
  adoptNode<T>(node: T): T {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError("Failed to execute 'adoptNode' on 'Document': parameter 1 is not of type 'Node'.");
    removeChild(host);
    setOwnerDocument(host, this);
    return node;
  }

  querySelectorAll(selector: string): NodeList<DomElement> {
    const root = this.documentElement;
    if (root === null) return nodeListOf([]);
    const found: DomElement[] = root.matches(selector) ? [root] : [];
    found.push(...root.querySelectorAll(selector));
    return nodeListOf(found);
  }
  querySelector(selector: string): DomElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getElementById(id: string): DomElement | null {
    return this.querySelector(`#${String(id).replace(/[^\w-]/g, (c) => `\\${c}`)}`);
  }
  getElementsByTagName(tag: string): HTMLCollection<DomElement> {
    const root = this.documentElement;
    if (root === null) return collectionOf([]);
    const wanted = String(tag).toLowerCase();
    const found: DomElement[] = [];
    if (wanted === '*' || root.localName.toLowerCase() === wanted) found.push(root);
    found.push(...root.getElementsByTagName(tag));
    return collectionOf(found);
  }
  getElementsByClassName(names: string): HTMLCollection<DomElement> {
    return this.documentElement === null ? collectionOf([]) : this.documentElement.getElementsByClassName(names);
  }
}

class DOMImplementationShim {
  /** An empty HTML document: `html > head, body` (and a `title` when one is given). */
  createHTMLDocument(title?: string): DocumentShim {
    const doc = new DocumentShim('text/html');
    const html = createHostElement('html');
    const head = createHostElement('head');
    adopt(html, head);
    if (title !== undefined) {
      const element = createHostElement('title');
      adopt(element, createHostText(String(title)));
      adopt(head, element);
    }
    adopt(html, createHostElement('body'));
    doc.setRoot(html);
    doc.doctype = { name: 'html', publicId: '', systemId: '', nodeType: 10 };
    return doc;
  }
  createDocument(ns: string | null, qualifiedName: string | null): DocumentShim {
    const doc = new DocumentShim(ns === SVG_NS ? 'image/svg+xml' : 'application/xml');
    if (qualifiedName !== null && qualifiedName !== '') {
      const root = createHostElement(String(qualifiedName), ns === SVG_NS);
      doc.setRoot(root);
    }
    return doc;
  }
  createDocumentType(name: string, publicId: string, systemId: string): object {
    return { name, publicId, systemId, nodeType: 10 };
  }
  hasFeature(): true {
    return true;
  }
}

const implementation = new DOMImplementationShim();

let inert: DocumentShim | null = null;
/** The document that owns the content of every `<template>`: one, with nothing running in it. */
setInertDocumentFactory(() => (inert ??= implementation.createHTMLDocument()));

// ---- DOMParser ----

/** The `html > head, body` an HTML document has for markup: head-only elements before any content go in the head, the rest in the body. */
function parseHtmlDocument(markup: string): DocumentShim {
  const doc = implementation.createHTMLDocument();
  const html = doc.documentElement!.host;
  const head = doc.head!.host;
  const body = doc.body!.host;
  const doctype = /^\s*<!doctype\s+([^\s>]+)/i.exec(markup);
  doc.doctype = doctype === null ? null : { name: doctype[1]!.toLowerCase(), publicId: '', systemId: '', nodeType: 10 };
  const nodes = parsedNodes(parseHtmlFragment(markup));
  let inBody = false;
  const place = (node: DomNode): void => {
    if (!inBody) {
      if (node.kind === 'text' && node.text.trim() === '') return;
      if (node.kind === 'element' && HEAD_ONLY.has(node.type)) return adopt(head, node);
      inBody = true;
    }
    adopt(body, node);
  };
  const merge = (from: HostElement, into: HostElement): void => {
    Object.assign(into.props, from.props);
  };
  for (const node of nodes) {
    if (node.kind === 'element' && node.type === 'html') {
      merge(node, html);
      for (const child of node.children) {
        if (child.kind === 'element' && child.type === 'head') for (const grand of [...child.children]) adopt(head, grand);
        else if (child.kind === 'element' && child.type === 'body') {
          merge(child, body);
          inBody = true;
          for (const grand of [...child.children]) adopt(body, grand);
        } else place(child);
      }
    } else if (node.kind === 'element' && node.type === 'head') {
      for (const child of [...node.children]) adopt(head, child);
    } else if (node.kind === 'element' && node.type === 'body') {
      merge(node, body);
      inBody = true;
      for (const child of [...node.children]) adopt(body, child);
    } else {
      place(node);
    }
  }
  return doc;
}

const PARSER_TYPES = new Set(['text/html', 'text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml']);

export class DOMParserShim {
  parseFromString(markup: string, type: string): DocumentShim {
    if (!PARSER_TYPES.has(String(type))) {
      throw new TypeError(`Failed to execute 'parseFromString' on 'DOMParser': The provided value '${type}' is not a valid enum value of type DOMParserSupportedType.`);
    }
    const text = String(markup);
    if (type === 'text/html') return parseHtmlDocument(text);
    const doc = new DocumentShim(type);
    const nodes = parsedNodes(parseHtmlFragment(text.replace(/^\s*<\?xml[^>]*\?>/, ''), type === 'image/svg+xml' || /^\s*<svg[\s>]/i.test(text)));
    const root = nodes.find((n): n is HostElement => n.kind === 'element');
    if (root === undefined) {
      const error = createHostElement('parsererror');
      adopt(error, createHostText('This page contains the following errors: no root element'));
      doc.setRoot(error);
    } else {
      doc.setRoot(root);
    }
    return doc;
  }
}

/** `instanceof HTMLTemplateElement` and `HTMLFormElement` hold for an element of that tag. */
const tagClass = (tag: string): typeof DomElement =>
  class extends DomElement {
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof DomElement && value.host.type === tag;
    }
  };
export const HTMLTemplateElementShim = tagClass('template');
export const HTMLFormElementShim = tagClass('form');

/** Gives the page's own `document` what a document has beyond queries: its type, an implementation and the walkers. */
export function installDocumentMembers(doc: Record<string, unknown>, define: (target: Record<string, unknown>, name: string, value: unknown) => void): void {
  define(doc, 'nodeType', 9);
  define(doc, 'nodeName', '#document');
  define(doc, 'doctype', null);
  define(doc, 'currentScript', null);
  define(doc, 'implementation', implementation);
  define(doc, 'createNodeIterator', createNodeIterator);
  define(doc, 'createTreeWalker', createTreeWalker);
  define(doc, 'createDocumentFragment', function (this: unknown) {
    const fragment = new DomFragment();
    if (this instanceof DocumentShim) setOwnerDocument(fragment.host, this);
    return fragment;
  });
  define(doc, 'importNode', (node: unknown, deep = false) => {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError("Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.");
    return domNodeFor(cloneHost(host, Boolean(deep)));
  });
  define(doc, 'adoptNode', (node: unknown) => {
    const host = hostNodeOf(node);
    if (host !== null) removeChild(host);
    return node;
  });
}
