// `document.createRange()` (packages/cli/skills/kinetograph/references/ENGINE.md §1, "Readback"): a range over the host tree whose `getBoundingClientRect()` is
// the union of the boxes of the text and elements it covers, as the DOM engine lays them out. A piece of a text node is
// measured by the root (`Readback.textRangeBox`); an element is its own box.

import { DOMRectShim, DomElement, DomText, domNodeFor, hostNodeOf } from './element.js';
import { bodyHost, effectiveParentOf, htmlHost, type Readback } from './host.js';
import { isConnectedHost, readbackOfHost, type HostText } from './tree.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode } from '../types.js';

type Boundary = { node: DomNode; offset: number };

const lengthOf = (node: DomNode): number => (node.kind === 'text' ? node.text.length : readbackOfHost(node).childNodes(node).length);

/** The children of a node as a script sees them (text and DOM elements, `<Sequence>`s transparent). */
function childrenOf(node: DomNode): DomNode[] {
  return node.kind === 'text' ? [] : readbackOfHost(node).childNodes(node);
}

/** A node and everything under it, in document order. */
function walk(node: DomNode, out: DomNode[] = []): DomNode[] {
  out.push(node);
  for (const child of childrenOf(node)) walk(child, out);
  return out;
}

const parentOfNode = (node: DomNode): DomNode | null => {
  if (node === htmlHost) return null;
  const parent = effectiveParentOf(node);
  if (parent !== null) return parent;
  return isConnectedHost(node) ? bodyHost : null;
};

function indexIn(parent: DomNode, node: DomNode): number {
  return childrenOf(parent).indexOf(node);
}

function union(rects: { x: number; y: number; width: number; height: number }[]): DOMRectShim {
  if (rects.length === 0) return new DOMRectShim();
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return new DOMRectShim(left, top, right - left, bottom - top);
}

export class RangeShim {
  private startNode: DomNode = bodyHost;
  private startOffset_ = 0;
  private endNode: DomNode = bodyHost;
  private endOffset_ = 0;

  get startContainer(): DomElement | DomText {
    return domNodeFor(this.startNode);
  }
  get endContainer(): DomElement | DomText {
    return domNodeFor(this.endNode);
  }
  get startOffset(): number {
    return this.startOffset_;
  }
  get endOffset(): number {
    return this.endOffset_;
  }
  get collapsed(): boolean {
    return this.startNode === this.endNode && this.startOffset_ === this.endOffset_;
  }
  get commonAncestorContainer(): DomElement | DomText {
    const chain = (n: DomNode): DomNode[] => {
      const out: DomNode[] = [];
      for (let c: DomNode | null = n; c !== null; c = parentOfNode(c)) out.push(c);
      return out;
    };
    const ends = chain(this.endNode);
    return domNodeFor(chain(this.startNode).find((n) => ends.includes(n)) ?? this.startNode);
  }

  private bound(node: unknown, offset: number, method: string): Boundary {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError(`Failed to execute '${method}' on 'Range': parameter 1 is not of type 'Node'.`);
    const size = lengthOf(host);
    if (!(offset >= 0 && offset <= size)) {
      throw Object.assign(new Error(`Failed to execute '${method}' on 'Range': There is no child at offset ${offset}.`), { name: 'IndexSizeError', code: 1 });
    }
    return { node: host, offset: Math.floor(offset) };
  }
  setStart(node: unknown, offset: number): void {
    const b = this.bound(node, offset, 'setStart');
    this.startNode = b.node;
    this.startOffset_ = b.offset;
    if (this.isBackwards()) this.collapse(true);
  }
  setEnd(node: unknown, offset: number): void {
    const b = this.bound(node, offset, 'setEnd');
    this.endNode = b.node;
    this.endOffset_ = b.offset;
    if (this.isBackwards()) this.collapse(false);
  }
  setStartBefore(node: unknown): void {
    const [parent, at] = this.placeOf(node);
    this.setStart(domNodeFor(parent), at);
  }
  setStartAfter(node: unknown): void {
    const [parent, at] = this.placeOf(node);
    this.setStart(domNodeFor(parent), at + 1);
  }
  setEndBefore(node: unknown): void {
    const [parent, at] = this.placeOf(node);
    this.setEnd(domNodeFor(parent), at);
  }
  setEndAfter(node: unknown): void {
    const [parent, at] = this.placeOf(node);
    this.setEnd(domNodeFor(parent), at + 1);
  }
  private placeOf(node: unknown): [DomNode, number] {
    const host = hostNodeOf(node);
    const parent = host === null ? null : parentOfNode(host);
    if (host === null || parent === null) throw Object.assign(new Error('The node has no parent.'), { name: 'InvalidNodeTypeError', code: 24 });
    return [parent, indexIn(parent, host)];
  }
  selectNode(node: unknown): void {
    const [parent, at] = this.placeOf(node);
    this.startNode = this.endNode = parent;
    this.startOffset_ = at;
    this.endOffset_ = at + 1;
  }
  selectNodeContents(node: unknown): void {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError("Failed to execute 'selectNodeContents' on 'Range': parameter 1 is not of type 'Node'.");
    this.startNode = this.endNode = host;
    this.startOffset_ = 0;
    this.endOffset_ = lengthOf(host);
  }
  collapse(toStart = false): void {
    if (toStart) {
      this.endNode = this.startNode;
      this.endOffset_ = this.startOffset_;
    } else {
      this.startNode = this.endNode;
      this.startOffset_ = this.endOffset_;
    }
  }
  cloneRange(): RangeShim {
    const copy = new RangeShim();
    copy.startNode = this.startNode;
    copy.startOffset_ = this.startOffset_;
    copy.endNode = this.endNode;
    copy.endOffset_ = this.endOffset_;
    return copy;
  }
  detach(): void {}

  /** Whether the start is after the end: the boundary points in document order. */
  private isBackwards(): boolean {
    return this.position(this.startNode, this.startOffset_) > this.position(this.endNode, this.endOffset_);
  }

  /** A boundary point as a number that grows in document order: the index of the node in the walk, plus the offset as a fraction. */
  private position(node: DomNode, offset: number): number {
    const root = this.topOf(node);
    const order = walk(root);
    if (node.kind === 'text') return order.indexOf(node) + Math.min(offset / (node.text.length + 1), 0.999);
    // An element: before its `offset`th child, which is where that child's own walk position begins.
    const kids = childrenOf(node);
    if (offset < kids.length) return order.indexOf(kids[offset]!) - 0.5;
    const last = walk(node).at(-1)!;
    return order.indexOf(last) + 0.9999;
  }
  private topOf(node: DomNode): DomNode {
    let top = node;
    for (let p = parentOfNode(top); p !== null; p = parentOfNode(top)) top = p;
    return top === bodyHost ? htmlHost : top;
  }

  /** The text covered: each text node in the range, cut at the boundaries. */
  private covered(): { text: HostText; from: number; to: number }[] {
    const out: { text: HostText; from: number; to: number }[] = [];
    const start = this.position(this.startNode, this.startOffset_);
    const end = this.position(this.endNode, this.endOffset_);
    walk(this.topOf(this.startNode)).forEach((node, index) => {
      if (node.kind !== 'text') return;
      const isStart = this.startNode === node;
      const isEnd = this.endNode === node;
      if (!isStart && !isEnd && !(index > start && index < end)) return;
      if (isStart && !isEnd && index > end) return;
      if (isEnd && !isStart && index < start) return;
      const from = isStart ? this.startOffset_ : 0;
      const to = isEnd ? this.endOffset_ : node.text.length;
      if (to > from) out.push({ text: node, from, to });
    });
    return out;
  }

  /** The element boxes of the children covered when the range is over whole children of one element (`selectNode`). */
  private coveredElements(): DomElement[] {
    if (this.startNode !== this.endNode || this.startNode.kind !== 'element') return [];
    return childrenOf(this.startNode)
      .slice(this.startOffset_, this.endOffset_)
      .filter((n): n is Extract<DomNode, { kind: 'element' }> => n.kind === 'element' && isDomElement(n.type))
      .map((n) => domNodeFor(n) as DomElement);
  }

  getClientRects(): DOMRectShim[] {
    const rects: DOMRectShim[] = [];
    const seen = new Set<DomNode>();
    for (const element of this.coveredElements()) {
      seen.add(element.host);
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) rects.push(rect);
    }
    for (const { text, from, to } of this.covered()) {
      // Text inside an element already measured whole is part of its box.
      let inside = false;
      for (let p = effectiveParentOf(text); p !== null; p = effectiveParentOf(p)) if (seen.has(p)) inside = true;
      if (inside) continue;
      const parent = effectiveParentOf(text);
      const readback: Readback | null = parent === null ? null : readbackOfHost(parent);
      const box = readback?.textRangeBox?.(text, from, to) ?? null;
      if (box !== null) rects.push(new DOMRectShim(box.x, box.y, box.width, box.height));
    }
    return rects;
  }
  getBoundingClientRect(): DOMRectShim {
    return union(this.getClientRects());
  }
  toString(): string {
    return this.covered().map(({ text, from, to }) => text.text.slice(from, to)).join('');
  }
}
