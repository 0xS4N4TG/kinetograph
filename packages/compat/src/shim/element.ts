// What a React ref to a DOM host element is in compat mode (docs/ENGINE.md §1, "Readback"): an object that answers like
// a DOM element for measurement. Its boxes and computed styles come from the addon, for the island's current host tree
// (`Readback`, cached by tree generation). Script changes to `style` and attributes are laid over the props; nothing
// is ever drawn from this object, only read.

import { attributesOf } from '../request/attrs.js';
import { cssPropertyName, styleToCss } from '../request/style.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode } from '../types.js';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { CANVAS_SOURCE, fontKey, type CanvasContext2D, type CanvasPicture, type WebGLContext } from '@kinetograph/scene';
import {
  bitmapSide,
  canvasCommandsOf,
  canvasPictureOf,
  canvasToBlob,
  canvasToDataUrl,
  contextOfHost,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  refuseGlPicture,
  registeredFonts,
  resetCanvasOf,
} from './canvas.js';
import { GEOMETRY_TAGS, pathMeasure, shapePath } from './geometry.js';
import { parseHtmlFragment } from '../request/html.js';
import { bodyHost, pageViewport, effectiveParentOf, headHost, htmlHost, overlayOf, propsWithOverlay, rawParentOf, setRawParent, type BoxInfo, type HostElement, type Readback } from './host.js';
import { matches, queryAll, type SelectorContext } from './selector.js';
import {
  clearChildren,
  cloneHost,
  createHostElement,
  createHostText,
  insertChild,
  isConnectedHost,
  isShellHost,
  oldAttribute,
  readbackOfHost,
  recordAttribute,
  removeChild,
  setText,
  type HostText,
} from './tree.js';

export class DOMRectShim {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly width = 0,
    readonly height = 0,
  ) {}
  get top(): number {
    return Math.min(this.y, this.y + this.height);
  }
  get left(): number {
    return Math.min(this.x, this.x + this.width);
  }
  get right(): number {
    return Math.max(this.x, this.x + this.width);
  }
  get bottom(): number {
    return Math.max(this.y, this.y + this.height);
  }
  toJSON(): Record<string, number> {
    return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left };
  }
  static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}): DOMRectShim {
    return new DOMRectShim(rect.x, rect.y, rect.width, rect.height);
  }
}

const kebab = (name: string): string => cssPropertyName(name);

/** `element.style`: the inline style as React gave it, with what a script wrote on top. Properties read as camelCase. */
function inlineStyle(host: HostElement, readbackOf: () => Readback): CSSStyleDeclarationShim {
  const read = (property: string): string => {
    const overlay = overlayOf(host, false)?.style.get(property);
    if (overlay !== undefined) return overlay;
    const style = host.props.style;
    if (typeof style !== 'object' || style === null) return '';
    for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
      if (cssPropertyName(key) === property) return styleToCss({ [key]: value }).replace(/^[^:]*:\s*/, '');
    }
    return '';
  };
  const target = {
    getPropertyValue: read,
    setProperty(property: string, value: string | null): void {
      const old = oldAttribute(host, 'style');
      overlayOf(host, true)!.style.set(kebab(property), value === null ? '' : String(value));
      readbackOf().touch();
      recordAttribute(host, 'style', old);
    },
    removeProperty(property: string): string {
      const old = read(kebab(property));
      const was = oldAttribute(host, 'style');
      overlayOf(host, true)!.style.set(kebab(property), '');
      readbackOf().touch();
      recordAttribute(host, 'style', was);
      return old;
    },
    get cssText(): string {
      return styleToCss({ ...(typeof host.props.style === 'object' ? host.props.style : {}), ...Object.fromEntries(overlayOf(host, false)?.style ?? []) });
    },
    set cssText(text: string) {
      const was = oldAttribute(host, 'style');
      const overlay = overlayOf(host, true)!;
      for (const part of text.split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) overlay.style.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
      }
      readbackOf().touch();
      recordAttribute(host, 'style', was);
    },
    item: () => '',
    length: 0,
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      return t.getPropertyValue(kebab(prop));
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'symbol' || prop === 'cssText') return Reflect.set(t, prop, value, receiver);
      t.setProperty(kebab(prop), value == null ? '' : String(value));
      return true;
    },
  }) as unknown as CSSStyleDeclarationShim;
}

export interface CSSStyleDeclarationShim {
  [property: string]: any;
  getPropertyValue(property: string): string;
  setProperty(property: string, value: string | null): void;
  removeProperty(property: string): string;
  cssText: string;
}

/** `getComputedStyle(el)`: values come from the engine's computed style for the island, read when asked for. */
export function computedStyleOf(host: HostElement, readback: Readback): CSSStyleDeclarationShim {
  const read = (property: string): string => readback.computed(host, kebab(property)) ?? '';
  const target = {
    getPropertyValue: read,
    getPropertyPriority: () => '',
    setProperty(): void {
      throw new TypeError('getComputedStyle() returns a read-only style');
    },
    removeProperty(): string {
      throw new TypeError('getComputedStyle() returns a read-only style');
    },
    item: () => '',
    length: 0,
    cssText: '',
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      return read(prop);
    },
  }) as unknown as CSSStyleDeclarationShim;
}

type Listener = ((event: any) => void) | { handleEvent(event: any): void };

const elements = new WeakMap<HostElement, DomElement>();
const texts = new WeakMap<HostText, DomText>();

/** The DOM-like object for a text node of the host tree (one per node). */
export function domTextFor(host: HostText): DomText {
  let text = texts.get(host);
  if (text === undefined) {
    text = new DomText(host);
    texts.set(host, text);
  }
  return text;
}

/** The object for a host node, whichever kind it is. */
export function domNodeFor(host: DomNode): DomElement | DomText {
  return host.kind === 'element' ? domElementFor(host) : domTextFor(host);
}

/** The host node behind a shim node. */
export function hostNodeOf(value: unknown): DomNode | null {
  return value instanceof DomElement ? value.host : value instanceof DomText ? value.host : null;
}

/** How selectors read the host tree of a root. */
export function selectorContextOf(readback: Readback, scope?: HostElement): SelectorContext {
  return {
    parent: (h) => readback.parent(h),
    children: (h) => readback.childNodes(h).filter((n): n is HostElement => n.kind === 'element' && isDomElement(n.type)),
    attribute: (h, name) => domElementFor(h, readback).getAttribute(name),
    ...(scope ? { scope } : {}),
  };
}

/** The DOM-like object for a host element (one per host element). */
export function domElementFor(host: HostElement, _readback?: Readback): DomElement {
  let element = elements.get(host);
  if (element === undefined) {
    element = new DomElement(host);
    elements.set(host, element);
  }
  return element;
}

/** The host element behind a shim object, or null. */
export function hostOf(value: unknown): HostElement | null {
  return value instanceof DomElement ? value.host : null;
}

export function isDomElementShim(value: unknown): value is DomElement {
  return value instanceof DomElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

export class DomElement {
  readonly nodeType = 1;
  private listeners = new Map<string, Set<Listener>>();
  private styleObject: CSSStyleDeclarationShim | null = null;

  constructor(readonly host: HostElement) {}

  /** The root whose tree holds this element (it can change: a script moves nodes), else the detached one. */
  private get readback(): Readback {
    return readbackOfHost(this.host);
  }

  // ---- identity ----

  private get inSvg(): boolean {
    for (let h: HostElement | null = this.host; h !== null; h = this.readback.parent(h)) if (h.type === 'svg') return true;
    return false;
  }
  get tagName(): string {
    return this.inSvg ? this.host.type : this.host.type.toUpperCase();
  }
  get nodeName(): string {
    return this.tagName;
  }
  get localName(): string {
    return this.host.type.toLowerCase();
  }
  get namespaceURI(): string {
    return this.inSvg ? SVG_NS : HTML_NS;
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(value: string) {
    this.setAttribute('id', value);
  }
  get className(): string | { baseVal: string } {
    const value = this.getAttribute('class') ?? '';
    return this.inSvg ? { baseVal: value } : value;
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  get classList() {
    const list = (): string[] => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (names: string[]): void => this.setAttribute('class', names.join(' '));
    return {
      contains: (name: string) => list().includes(name),
      add: (...names: string[]) => write([...new Set([...list(), ...names])]),
      remove: (...names: string[]) => write(list().filter((n) => !names.includes(n))),
      toggle: (name: string, force?: boolean) => {
        const has = list().includes(name);
        const want = force ?? !has;
        if (want && !has) write([...list(), name]);
        if (!want && has) write(list().filter((n) => n !== name));
        return want;
      },
      get length() {
        return list().length;
      },
      item: (i: number) => list()[i] ?? null,
      toString: () => list().join(' '),
      [Symbol.iterator]: () => list()[Symbol.iterator](),
    };
  }

  // ---- attributes ----

  private attrs(): Record<string, string> {
    return attributesOf(propsWithOverlay(this.host), this.inSvg);
  }
  getAttribute(name: string): string | null {
    return this.attrs()[name] ?? this.attrs()[name.toLowerCase()] ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  getAttributeNames(): string[] {
    return Object.keys(this.attrs());
  }
  setAttribute(name: string, value: unknown): void {
    const old = oldAttribute(this.host, name);
    overlayOf(this.host, true)!.attrs.set(name, String(value));
    this.readback.touch();
    recordAttribute(this.host, name, old);
  }
  removeAttribute(name: string): void {
    const old = oldAttribute(this.host, name);
    if (old === null) return;
    overlayOf(this.host, true)!.attrs.set(name, null);
    this.readback.touch();
    recordAttribute(this.host, name, old);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const want = force ?? !this.hasAttribute(name);
    if (want) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return want;
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.attrs())) {
      if (name.startsWith('data-')) out[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
    }
    return out;
  }
  get style(): CSSStyleDeclarationShim {
    return (this.styleObject ??= inlineStyle(this.host, () => this.readback));
  }

  // ---- the tree ----

  private wrap(node: HostElement | null): DomElement | null {
    return node === null ? null : domElementFor(node);
  }
  /** The element this one hangs from: a DOM element, `body` at the top of a root, `html` above `body` and `head`. */
  private domParent(): HostElement | null {
    if (this.host === htmlHost) return null;
    if (this.host === bodyHost || this.host === headHost) return htmlHost;
    const parent = effectiveParentOf(this.host);
    if (parent !== null) return isDomElement(parent.type) ? parent : null;
    // At the top of a root's tree (or of a script's detached one).
    return isConnectedHost(this.host) ? bodyHost : null;
  }
  get parentElement(): DomElement | null {
    return this.wrap(this.domParent());
  }
  get parentNode(): DomElement | Document | null {
    if (this.host === htmlHost) return (globalThis as { document?: Document }).document ?? null;
    return this.parentElement;
  }
  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document;
  }
  get isConnected(): boolean {
    return isConnectedHost(this.host);
  }
  /** The nodes in this element's own list, `<Sequence>`s replaced by what is inside them. */
  private childHosts(): DomNode[] {
    return this.readback.childNodes(this.host);
  }
  get childNodes(): (DomElement | DomText)[] {
    return this.childHosts().map(domNodeFor);
  }
  get children(): DomElement[] {
    return this.childNodes.filter((n): n is DomElement => n instanceof DomElement);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstChild(): DomElement | DomText | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): DomElement | DomText | null {
    return this.childNodes.at(-1) ?? null;
  }
  get firstElementChild(): DomElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): DomElement | null {
    return this.children.at(-1) ?? null;
  }
  hasChildNodes(): boolean {
    return this.childHosts().length > 0;
  }
  /** The nodes next to this one (its parent's children), text included. */
  private siblingHosts(): DomNode[] {
    const parent = effectiveParentOf(this.host);
    if (parent !== null) return this.readback.childNodes(parent);
    if (this.host === headHost || this.host === bodyHost) return [headHost, bodyHost];
    return this.readback.roots().filter((n) => n.kind === 'text' || isDomElement(n.type));
  }
  get nextSibling(): DomElement | DomText | null {
    const list = this.siblingHosts();
    const next = list[list.indexOf(this.host) + 1];
    return next === undefined ? null : domNodeFor(next);
  }
  get previousSibling(): DomElement | DomText | null {
    const list = this.siblingHosts();
    const at = list.indexOf(this.host);
    return at <= 0 ? null : domNodeFor(list[at - 1]!);
  }
  get nextElementSibling(): DomElement | null {
    const list = this.siblingHosts();
    for (let i = list.indexOf(this.host) + 1; i > 0 && i < list.length; i++) {
      const node = list[i]!;
      if (node.kind === 'element') return domElementFor(node);
    }
    return null;
  }
  get previousElementSibling(): DomElement | null {
    const list = this.siblingHosts();
    for (let i = list.indexOf(this.host) - 1; i >= 0; i--) {
      const node = list[i]!;
      if (node.kind === 'element') return domElementFor(node);
    }
    return null;
  }
  get textContent(): string {
    const text = (nodes: DomNode[]): string =>
      nodes.map((n) => (n.kind === 'text' ? n.text : n.type === 'style' || n.type === 'script' ? '' : text(this.readback.childNodes(n)))).join('');
    return text(this.childHosts());
  }
  set textContent(value: string | null) {
    clearChildren(this.host);
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') insertChild(this.host, createHostText(text), null);
  }
  get innerText(): string {
    return this.textContent;
  }
  set innerText(value: string) {
    this.textContent = value;
  }
  contains(other: unknown): boolean {
    const node = hostNodeOf(other);
    if (node === null) return false;
    for (let h: DomNode | null = node; h !== null; h = effectiveParentOf(h)) if (h === this.host) return true;
    return false;
  }
  getRootNode(): DomElement | Document | null {
    let node: DomElement = this;
    for (let parent = node.parentElement; parent !== null; parent = node.parentElement) node = parent;
    return node.host === htmlHost ? ((globalThis as { document?: Document }).document ?? node) : node;
  }
  isSameNode(other: unknown): boolean {
    return other === this;
  }

  // ---- changing the tree (tree.ts) ----

  /** The nodes a script passes (nodes or strings) as host nodes; a string is a text node. A node already in a tree is moved. */
  private static hostsOf(nodes: unknown[]): DomNode[] {
    return nodes.map((n) => {
      const host = hostNodeOf(n);
      return host ?? createHostText(String(n));
    });
  }
  private static required(node: unknown, method: string): DomNode {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError(`Failed to execute '${method}' on 'Node': parameter 1 is not of type 'Node'.`);
    return host;
  }
  appendChild<T>(child: T): T {
    insertChild(this.host, DomElement.required(child, 'appendChild'), null);
    return child;
  }
  insertBefore<T>(child: T, before: unknown): T {
    const host = DomElement.required(child, 'insertBefore');
    insertChild(this.host, host, before === null || before === undefined ? null : DomElement.required(before, 'insertBefore'));
    return child;
  }
  removeChild<T>(child: T): T {
    const host = DomElement.required(child, 'removeChild');
    if (effectiveParentOf(host) !== this.host && !(this.host === bodyHost && effectiveParentOf(host) === null && isConnectedHost(host))) {
      throw new DOMExceptionShim("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.", 'NotFoundError', 8);
    }
    removeChild(host);
    return child;
  }
  replaceChild<T>(child: unknown, old: T): T {
    const host = DomElement.required(child, 'replaceChild');
    const oldHost = DomElement.required(old, 'replaceChild');
    if (effectiveParentOf(oldHost) !== this.host && !(this.host === bodyHost && effectiveParentOf(oldHost) === null)) {
      throw new DOMExceptionShim("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.", 'NotFoundError', 8);
    }
    const after = this.nextHostAfter(oldHost);
    removeChild(oldHost);
    insertChild(this.host, host, after);
    return old;
  }
  /** The node after `host` among this element's children, null at the end. */
  private nextHostAfter(host: DomNode): DomNode | null {
    const list = this.childHosts();
    return list[list.indexOf(host) + 1] ?? null;
  }
  append(...nodes: unknown[]): void {
    for (const host of DomElement.hostsOf(nodes)) insertChild(this.host, host, null);
  }
  prepend(...nodes: unknown[]): void {
    const first = this.childHosts()[0] ?? null;
    for (const host of DomElement.hostsOf(nodes)) insertChild(this.host, host, first);
  }
  replaceChildren(...nodes: unknown[]): void {
    const hosts = DomElement.hostsOf(nodes);
    clearChildren(this.host);
    for (const host of hosts) insertChild(this.host, host, null);
  }
  /** Puts `nodes` in this node's parent, before it. */
  before(...nodes: unknown[]): void {
    const parent = this.domParent();
    if (parent === null) return;
    for (const host of DomElement.hostsOf(nodes)) insertChild(parent, host, this.host);
  }
  after(...nodes: unknown[]): void {
    const parent = this.domParent();
    if (parent === null) return;
    const next = this.nextSibling === null ? null : hostNodeOf(this.nextSibling);
    for (const host of DomElement.hostsOf(nodes)) insertChild(parent, host, next);
  }
  replaceWith(...nodes: unknown[]): void {
    const parent = this.domParent();
    if (parent === null) return;
    const next = this.nextSibling === null ? null : hostNodeOf(this.nextSibling);
    const hosts = DomElement.hostsOf(nodes).filter((h) => h !== this.host);
    removeChild(this.host);
    for (const host of hosts) insertChild(parent, host, next);
  }
  remove(): void {
    removeChild(this.host);
  }
  cloneNode(deep = false): DomElement {
    return domElementFor(cloneHost(this.host, Boolean(deep)) as HostElement);
  }
  insertAdjacentElement(where: string, element: unknown): unknown {
    const host = DomElement.required(element, 'insertAdjacentElement');
    this.insertAdjacent(where, [host]);
    return element;
  }
  insertAdjacentText(where: string, text: string): void {
    this.insertAdjacent(where, [createHostText(text)]);
  }
  insertAdjacentHTML(where: string, html: string): void {
    this.insertAdjacent(where, parseHtmlFragment(String(html), this.inSvg));
  }
  private insertAdjacent(where: string, hosts: DomNode[]): void {
    switch (String(where).toLowerCase()) {
      case 'beforebegin': {
        const parent = this.domParent();
        if (parent !== null) for (const h of hosts) insertChild(parent, h, this.host);
        return;
      }
      case 'afterbegin': {
        const first = this.childHosts()[0] ?? null;
        for (const h of hosts) insertChild(this.host, h, first);
        return;
      }
      case 'beforeend':
        for (const h of hosts) insertChild(this.host, h, null);
        return;
      case 'afterend': {
        const parent = this.domParent();
        const next = this.nextSibling === null ? null : hostNodeOf(this.nextSibling);
        if (parent !== null) for (const h of hosts) insertChild(parent, h, next);
        return;
      }
      default:
        throw new DOMExceptionShim(`Failed to execute 'insertAdjacentElement' on 'Element': The value provided ('${where}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`, 'SyntaxError', 12);
    }
  }
  /** The markup of this element's children (what the DOM calls `innerHTML`). */
  get innerHTML(): string {
    return this.childHosts().map((n) => serializeHost(n)).join('');
  }
  set innerHTML(html: string) {
    clearChildren(this.host);
    for (const node of parseHtmlFragment(String(html), this.inSvg)) insertChild(this.host, node, null);
  }
  get outerHTML(): string {
    return serializeHost(this.host);
  }

  /** Selector matching over the host tree. */
  selectorContext(scope?: HostElement): SelectorContext {
    return selectorContextOf(this.readback, scope);
  }
  /** `getComputedStyle(this)`. */
  computedStyle(): CSSStyleDeclarationShim {
    return computedStyleOf(this.host, this.readback);
  }
  private descendants(): HostElement[] {
    const out: HostElement[] = [];
    const visit = (h: HostElement): void => {
      for (const n of this.readback.childNodes(h)) {
        if (n.kind === 'element' && isDomElement(n.type)) {
          out.push(n);
          visit(n);
        }
      }
    };
    visit(this.host);
    return out;
  }
  matches(selector: string): boolean {
    return matches(this.host, selector, this.selectorContext(this.host));
  }
  closest(selector: string): DomElement | null {
    const cx = this.selectorContext(this.host);
    for (let h: HostElement | null = this.host; h !== null; h = this.readback.parent(h)) if (matches(h, selector, cx)) return this.wrap(h);
    return null;
  }
  querySelector(selector: string): DomElement | null {
    return this.wrap(queryAll(this.descendants(), selector, this.selectorContext(this.host), true)[0] ?? null);
  }
  querySelectorAll(selector: string): DomElement[] {
    return queryAll(this.descendants(), selector, this.selectorContext(this.host)).map((h) => domElementFor(h, this.readback));
  }
  getElementsByTagName(tag: string): DomElement[] {
    return this.descendants()
      .filter((h) => tag === '*' || h.type.toLowerCase() === tag.toLowerCase())
      .map((h) => domElementFor(h, this.readback));
  }
  getElementsByClassName(names: string): DomElement[] {
    const wanted = names.split(/\s+/).filter(Boolean);
    return this.descendants()
      .filter((h) => {
        const have = (domElementFor(h, this.readback).getAttribute('class') ?? '').split(/\s+/);
        return wanted.every((w) => have.includes(w));
      })
      .map((h) => domElementFor(h, this.readback));
  }

  // ---- layout ----

  private box(): BoxInfo | null {
    // The page: `html` and `body` are as big as the composition.
    if (this.host === htmlHost || this.host === bodyHost) {
      const { width, height } = pageViewport();
      const rect = { x: 0, y: 0, width, height };
      return { ...rect, rect, client: { width, height }, scroll: { width, height } };
    }
    if (this.host === headHost) return null;
    return this.readback.box(this.host);
  }
  getBoundingClientRect(): DOMRectShim {
    const box = this.box();
    return box === null ? new DOMRectShim() : new DOMRectShim(box.rect.x, box.rect.y, box.rect.width, box.rect.height);
  }
  getClientRects(): DOMRectShim[] {
    return this.box() === null ? [] : [this.getBoundingClientRect()];
  }
  get offsetWidth(): number {
    return Math.round(this.box()?.width ?? 0);
  }
  get offsetHeight(): number {
    return Math.round(this.box()?.height ?? 0);
  }
  /** The nearest ancestor that is not `position: static`, else null (the island's origin, as `body` is). */
  get offsetParent(): DomElement | null {
    if (this.box() === null) return null;
    for (let h = this.readback.parent(this.host); h !== null; h = this.readback.parent(h)) {
      const position = this.readback.computed(h, 'position');
      if (position !== null && position !== 'static') return this.wrap(h);
    }
    return null;
  }
  get offsetLeft(): number {
    const box = this.box();
    if (box === null) return 0;
    const parent = this.offsetParent?.host;
    const origin = parent ? this.readback.box(parent) : null;
    return Math.round(box.x - (origin?.x ?? 0));
  }
  get offsetTop(): number {
    const box = this.box();
    if (box === null) return 0;
    const parent = this.offsetParent?.host;
    const origin = parent ? this.readback.box(parent) : null;
    return Math.round(box.y - (origin?.y ?? 0));
  }
  get clientWidth(): number {
    return Math.round(this.box()?.client.width ?? 0);
  }
  get clientHeight(): number {
    return Math.round(this.box()?.client.height ?? 0);
  }
  get clientLeft(): number {
    return Math.round(parseFloat(this.readback.computed(this.host, 'border-left-width') ?? '0') || 0);
  }
  get clientTop(): number {
    return Math.round(parseFloat(this.readback.computed(this.host, 'border-top-width') ?? '0') || 0);
  }
  get scrollWidth(): number {
    return Math.round(this.box()?.scroll.width ?? 0);
  }
  get scrollHeight(): number {
    return Math.round(this.box()?.scroll.height ?? 0);
  }
  scrollLeft = 0;
  scrollTop = 0;
  scrollIntoView(): void {}
  scrollTo(): void {}
  scroll(): void {}

  // ---- images, canvas ----

  get width(): number {
    if (this.host.type === 'canvas') return bitmapSide(this.getAttribute('width'), DEFAULT_WIDTH);
    const attr = this.getAttribute('width');
    return attr !== null && Number.isFinite(parseFloat(attr)) ? parseFloat(attr) : this.offsetWidth;
  }
  set width(value: number) {
    this.setAttribute('width', String(Math.max(0, Math.floor(Number(value)) || 0)));
    if (this.host.type === 'canvas') resetCanvasOf(this.host);
  }
  get height(): number {
    if (this.host.type === 'canvas') return bitmapSide(this.getAttribute('height'), DEFAULT_HEIGHT);
    const attr = this.getAttribute('height');
    return attr !== null && Number.isFinite(parseFloat(attr)) ? parseFloat(attr) : this.offsetHeight;
  }
  set height(value: number) {
    this.setAttribute('height', String(Math.max(0, Math.floor(Number(value)) || 0)));
    if (this.host.type === 'canvas') resetCanvasOf(this.host);
  }
  get src(): string {
    return this.getAttribute('src') ?? '';
  }
  get naturalWidth(): number {
    return this.host.type === 'img' ? imageSize(this.src)?.width ?? 0 : 0;
  }
  get naturalHeight(): number {
    return this.host.type === 'img' ? imageSize(this.src)?.height ?? 0 : 0;
  }
  get complete(): boolean {
    return true;
  }
  // `<video>` and `<audio>`: what the file's header says, and a player that is always ready and never plays.
  private media(): { width: number; height: number; durationInSeconds: number } | null {
    if (this.host.type !== 'video' && this.host.type !== 'audio') return null;
    const file = projectFileOf(this.src);
    if (file === null || !hasAddonFunction('probeMedia')) return null;
    try {
      return addonFunction('probeMedia')(file);
    } catch {
      return null;
    }
  }
  get duration(): number {
    return this.media()?.durationInSeconds ?? NaN;
  }
  get videoWidth(): number {
    return this.media()?.width ?? 0;
  }
  get videoHeight(): number {
    return this.media()?.height ?? 0;
  }
  get readyState(): number {
    return 4;
  }
  get paused(): boolean {
    return true;
  }
  currentTime = 0;
  async play(): Promise<void> {}
  pause(): void {}
  load(): void {}
  async decode(): Promise<void> {}
  // `<canvas>`: the 2D context records what is drawn, and the painter draws it (docs/SCENE.md, "canvas").
  getContext(type: string, attributes?: unknown): CanvasContext2D | WebGLContext | null {
    if (this.host.type !== 'canvas') throw new TypeError(`getContext is not a function: <${this.host.type}> is not a canvas`);
    return contextOfHost(this.host, String(type), () => ({ width: this.width, height: this.height }), this, attributes);
  }
  toDataURL(): string {
    refuseGlPicture(this.host);
    return canvasToDataUrl(canvasCommandsOf(this.host) ?? [], { width: this.width, height: this.height });
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    refuseGlPicture(this.host);
    callback(canvasToBlob(canvasCommandsOf(this.host) ?? [], { width: this.width, height: this.height }));
  }
  /** What `drawImage` reads of this element: a canvas's commands, an image's file. */
  [CANVAS_SOURCE](): CanvasPicture | null {
    if (this.host.type === 'canvas') return canvasPictureOf(this.host, { width: this.width, height: this.height });
    if (this.host.type === 'img') return pictureOfImage(this.src);
    return null;
  }

  // ---- SVG ----

  private geometryPath(): string | null {
    const props = propsWithOverlay(this.host);
    return shapePath(this.host.type, (name) => props[name] ?? props[name.toLowerCase()]);
  }
  private requireGeometry(method: string): string {
    if (!GEOMETRY_TAGS.has(this.host.type)) {
      throw new TypeError(`${method} is not a function: <${this.host.type}> is not an SVG geometry element`);
    }
    return this.geometryPath() ?? 'M0 0';
  }
  getTotalLength(): number {
    return pathMeasure().getLength(this.requireGeometry('getTotalLength'));
  }
  getPointAtLength(length: number): { x: number; y: number } {
    const d = this.requireGeometry('getPointAtLength');
    const total = pathMeasure().getLength(d);
    const clamped = Math.min(Math.max(Number(length) || 0, 0), total);
    return pathMeasure().getPointAtLength(d, clamped) ?? { x: 0, y: 0 };
  }
  /** The element's box in its own user space, before its transform: geometry, or the union of its children's. */
  getBBox(): DOMRectShim {
    const d = this.geometryPath();
    if (d !== null) {
      const b = pathMeasure().getBoundingBox(d);
      return new DOMRectShim(b.x1, b.y1, b.width, b.height);
    }
    // A group, an svg: the union of what is inside, each child's own transform applied to its box.
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const child of this.children) {
      if (!this.inSvg && child.host.type !== 'svg') continue;
      const b = child.getBBox();
      if (b.width === 0 && b.height === 0 && !GEOMETRY_TAGS.has(child.host.type) && child.children.length === 0) continue;
      const t = affineOf(child.getAttribute('transform'));
      for (const [px, py] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]] as const) {
        const x = t[0] * px + t[2] * py + t[4];
        const y = t[1] * px + t[3] * py + t[5];
        x1 = Math.min(x1, x);
        y1 = Math.min(y1, y);
        x2 = Math.max(x2, x);
        y2 = Math.max(y2, y);
      }
    }
    if (x1 === Infinity) {
      // Text and other elements the geometry cannot say: the laid-out box, relative to the nearest svg.
      const box = this.box();
      return box === null ? new DOMRectShim() : new DOMRectShim(0, 0, box.width, box.height);
    }
    return new DOMRectShim(x1, y1, x2 - x1, y2 - y1);
  }
  getComputedTextLength(): number {
    return this.box()?.width ?? 0;
  }

  // The characters of an SVG `<text>`: what it says with white space collapsed (SVG's default), and where each starts.
  private svgText(): string {
    return this.textContent.replace(/\s+/g, ' ').trim();
  }
  /** The width of `text` in this element's font, as the text engine lays it out. */
  private advanceOf(text: string): number {
    if (text === '') return 0;
    const computed = (property: string): string => this.readback.computed(this.host, property) ?? '';
    const size = parseFloat(computed('font-size')) || 16;
    const spacing = parseFloat(computed('letter-spacing')) || 0;
    const family = computed('font-family').split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
    const weight = computed('font-weight');
    const style = computed('font-style');
    const key = fontKey(family, weight === '' ? undefined : weight, style === 'italic' || style === 'oblique' ? 'italic' : undefined);
    let width: number | null = null;
    if (hasAddonFunction('layoutText')) {
      try {
        // Spaces at the ends count: measure between two bars and take their width off.
        const padded = /^\s|\s$/.test(text);
        const layout = (t: string): number => addonFunction('layoutText')({ text: t, font: key, size, fonts: registeredFonts() }).width;
        width = padded ? layout(`|${text}|`) - layout('||') : layout(text);
      } catch {
        width = null;
      }
    }
    if (width === null) {
      // No text engine: the laid-out width shared out by characters.
      const whole = this.svgText().length;
      width = whole === 0 ? 0 : ((this.box()?.width ?? 0) * text.length) / whole;
    }
    return width + spacing * Array.from(text).length;
  }
  /** The numbers of an attribute such as `x="10 20 30"`. */
  private numberList(name: string): number[] {
    return (this.getAttribute(name) ?? '').split(/[\s,]+/).filter(Boolean).map((v) => parseFloat(v)).filter(Number.isFinite);
  }
  getNumberOfChars(): number {
    if (this.host.type !== 'text' && this.host.type !== 'tspan' && this.host.type !== 'textPath') {
      throw new TypeError(`getNumberOfChars is not a function: <${this.host.type}> is not an SVG text content element`);
    }
    return this.svgText().length;
  }
  /** Where character `index` starts, in the text element's user space (its `x`, `y`, `dx` and `dy` and `text-anchor` apply). */
  getStartPositionOfChar(index: number): { x: number; y: number } {
    const count = this.getNumberOfChars();
    const at = Math.floor(Number(index));
    if (!(at >= 0 && at < count)) {
      throw new DOMExceptionShim(`Failed to execute 'getStartPositionOfChar' on 'SVGTextContentElement': The index provided (${index}) is greater than or equal to the maximum index (${count - 1}).`, 'IndexSizeError', 1);
    }
    const text = this.svgText();
    const xs = this.numberList('x');
    const ys = this.numberList('y');
    const dxs = this.numberList('dx');
    const dys = this.numberList('dy');
    // Walk the characters: an `x` or `y` for a character restarts the run there; the others follow the previous advance.
    let runStart = 0;
    let runX = xs[0] ?? 0;
    let y = ys[0] ?? 0;
    let shiftX = 0;
    for (let i = 0; i <= at; i++) {
      if (i > 0 && xs[i] !== undefined) {
        runStart = i;
        runX = xs[i]!;
        shiftX = 0;
      }
      if (ys[i] !== undefined) y = ys[i]!;
      shiftX += dxs[i] ?? 0;
      y += dys[i] ?? 0;
    }
    const anchor = this.readback.computed(this.host, 'text-anchor') ?? this.getAttribute('text-anchor') ?? 'start';
    // The anchor moves the whole run: by its width, all of it up to the next absolute `x`.
    let runEnd = text.length;
    for (let i = runStart + 1; i < text.length; i++) {
      if (xs[i] !== undefined) {
        runEnd = i;
        break;
      }
    }
    const whole = this.advanceOf(text.slice(runStart, runEnd));
    const anchorShift = anchor === 'middle' ? -whole / 2 : anchor === 'end' ? -whole : 0;
    return { x: runX + anchorShift + shiftX + this.advanceOf(text.slice(runStart, at)), y };
  }
  getEndPositionOfChar(index: number): { x: number; y: number } {
    const start = this.getStartPositionOfChar(index);
    const at = Math.floor(Number(index));
    return { x: start.x + this.advanceOf(this.svgText().slice(at, at + 1)), y: start.y };
  }
  getSubStringLength(start: number, length: number): number {
    return this.advanceOf(this.svgText().slice(Math.max(0, start), Math.max(0, start) + Math.max(0, length)));
  }

  // ---- events and actions that mean nothing offline ----

  addEventListener(type: string, listener: Listener | null): void {
    if (listener === null) return;
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener | null): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: { type: string }): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
    return true;
  }
  focus(): void {}
  blur(): void {}
  click(): void {}
  animate(): never {
    throw new Error('element.animate() is not supported: animate with the frame number, or with CSS keyframes, which follow the frame clock');
  }
  getAnimations(): [] {
    return [];
  }
}

/** The error a DOM method throws for a node that cannot go there (`name` and the legacy `code`). */
export class DOMExceptionShim extends Error {
  constructor(message: string, override readonly name: string, readonly code: number) {
    super(message);
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** A host node as markup. */
export function serializeHost(node: DomNode): string {
  if (node.kind === 'text') return escapeText(node.text);
  if (node.type === 'kg-sequence') return node.children.map(serializeHost).join('');
  if (!isDomElement(node.type)) return '';
  const props = propsWithOverlay(node);
  const attributes = attributesOf(props, node.type === 'svg');
  const style = styleToCss(typeof props.style === 'object' && props.style !== null ? props.style : {});
  const written = Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  const styleText = style === '' ? '' : ` style="${escapeAttribute(style)}"`;
  const open = `<${node.type}${written}${attributes.style === undefined ? styleText : ''}`;
  if (VOID_TAGS.has(node.type)) return `${open}>`;
  const inner = node.type === 'style' || node.type === 'script' ? node.children.map((c) => (c.kind === 'text' ? c.text : '')).join('') : node.children.map(serializeHost).join('');
  return `${open}>${inner}</${node.type}>`;
}

/** A text node of the host tree, as a script sees it. */
export class DomText {
  readonly nodeType = 3;
  readonly nodeName = '#text';
  constructor(readonly host: HostText) {}
  get data(): string {
    return this.host.text;
  }
  set data(value: string) {
    setText(this.host, String(value));
  }
  get nodeValue(): string {
    return this.host.text;
  }
  set nodeValue(value: string) {
    setText(this.host, String(value));
  }
  get textContent(): string {
    return this.host.text;
  }
  set textContent(value: string) {
    setText(this.host, String(value));
  }
  get length(): number {
    return this.host.text.length;
  }
  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document;
  }
  private parentHost(): HostElement | null {
    const parent = effectiveParentOf(this.host);
    if (parent !== null) return parent;
    return isConnectedHost(this.host) ? bodyHost : null;
  }
  get parentElement(): DomElement | null {
    const parent = this.parentHost();
    return parent !== null && isDomElement(parent.type) ? domElementFor(parent) : null;
  }
  get parentNode(): DomElement | null {
    return this.parentElement;
  }
  get isConnected(): boolean {
    return isConnectedHost(this.host);
  }
  private siblings(): DomNode[] {
    const parent = this.parentHost();
    return parent === null ? [] : readbackOfHost(parent).childNodes(parent);
  }
  get nextSibling(): DomElement | DomText | null {
    const list = this.siblings();
    const next = list[list.indexOf(this.host) + 1];
    return next === undefined ? null : domNodeFor(next);
  }
  get previousSibling(): DomElement | DomText | null {
    const list = this.siblings();
    const at = list.indexOf(this.host);
    return at <= 0 ? null : domNodeFor(list[at - 1]!);
  }
  remove(): void {
    removeChild(this.host);
  }
  cloneNode(): DomText {
    return domTextFor(createHostText(this.host.text));
  }
  contains(other: unknown): boolean {
    return other === this;
  }
}

/** `matrix(…)`, `translate(…)`, `scale(…)`, `rotate(…)` of an SVG `transform` attribute as `[a b c d e f]`. */
export function affineOf(transform: string | null): [number, number, number, number, number, number] {
  let m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  if (transform === null) return m;
  const mul = (a: typeof m, b: typeof m): typeof m => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  for (const [, name, args] of transform.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = args!.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: typeof m | null = null;
    switch (name) {
      case 'matrix': if (n.length === 6) t = n as typeof m; break;
      case 'translate': t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]; break;
      case 'scale': t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((n[0] ?? 0) * Math.PI) / 180;
        const r: typeof m = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t = n.length === 3 ? mul(mul([1, 0, 0, 1, n[1]!, n[2]!], r), [1, 0, 0, 1, -n[1]!, -n[2]!]) : r;
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    if (t) m = mul(m, t);
  }
  return m;
}

// ---- image sizes (for `img.naturalWidth` and `new Image()`) ----

let imageSizeOf: (src: string) => { width: number; height: number } | null = () => null;
let pictureOfImage: (src: string) => CanvasPicture | null = () => null;
let fileOf: (src: string) => string | null = () => null;

/** The web-API module hands over how a `src` names a project file. */
export function setProjectFileResolver(fn: (src: string) => string | null): void {
  fileOf = fn;
}
function projectFileOf(src: string): string | null {
  return fileOf(src);
}

/** The web-API module hands over how to read an image file's size (it knows the project's directories). */
export function setImageSizeReader(fn: (src: string) => { width: number; height: number } | null): void {
  imageSizeOf = fn;
}
/** The web-API module hands over how `drawImage` reads an image: its file and size. */
export function setImagePictureReader(fn: (src: string) => CanvasPicture | null): void {
  pictureOfImage = fn;
}
function imageSize(src: string): { width: number; height: number } | null {
  return imageSizeOf(src);
}
