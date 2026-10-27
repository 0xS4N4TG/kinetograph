// What a React ref to a DOM host element is in compat mode (packages/cli/skills/kinetograph/references/ENGINE.md §1, "Readback"): an object that answers like
// a DOM element for measurement. Its boxes and computed styles come from the addon, for the island's current host tree
// (`Readback`, cached by tree generation). Script changes to `style` and attributes are laid over the props; nothing
// is ever drawn from this object, only read.

import { attributesOf } from '../request/attrs.js';
import { cssPropertyName, styleToCss } from '../request/style.js';
import { srcsetCandidate } from '../request/build.js';
import { isDomElement, isSvgTag } from '../request/tags.js';
import type { DomNode } from '../types.js';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { CANVAS_SOURCE, VIDEO_FRAME, fontKey, type CanvasContext2D, type CanvasPicture, type VideoFrameSource, type WebGLContext } from '@kinetographdev/scene';
import type { GlRecorder } from './canvas.js';
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
import { isKnownCssProperty } from './css-names.js';
import { collectionOf, nodeListOf, type HTMLCollection, type NodeList } from './lists.js';
import { GEOMETRY_TAGS, pathMeasure, shapePath } from './geometry.js';
import { parseHtmlFragment } from '../request/html.js';
import { attributeMapOf, AttrShim, type NamedNodeMapShim } from './attributes.js';
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

/** An `<AbsoluteFill>` (or the wrapper of a `<Sequence>`): the `div` it is in Remotion, which a script sees as one. */
const isFillLayer = (host: HostElement): boolean => host.type === 'kg-layer' && host.props.domFill !== undefined;

const kebab = (name: string): string => cssPropertyName(name);

/**
 * What a script's write is stored as: the individual transform properties' initial value, `none` (GSAP writes it to
 * `translate`, `rotate` and `scale` beside its `transform`), is the same as nothing written.
 */
const written = (property: string, value: string): string => (/^(translate|rotate|scale)$/.test(property) && value.trim() === 'none' ? '' : value);

/**
 * Properties whose value is a length (or a list of them): CSSOM gives a bare `0` back as `0px` (`<div style="width:0">`
 * reads `style.width === '0px'`), and a library that animates the property (anime.js) takes its unit from that read.
 */
const LENGTH_PROPERTY =
  /^(?:(?:min-|max-)?(?:width|height)|top|right|bottom|left|inset(?:-(?:block|inline)(?:-start|-end)?)?|margin(?:-[a-z]+)*|padding(?:-[a-z]+)*|border(?:-(?:top|right|bottom|left))?-width|border(?:-(?:top|bottom)-(?:left|right))?-radius|gap|row-gap|column-gap|font-size|letter-spacing|word-spacing|text-indent|flex-basis|outline-(?:width|offset))$/;

function serialized(property: string, value: string): string {
  if (!LENGTH_PROPERTY.test(property) || value.includes('(')) return value;
  return value
    .split(/\s+/)
    .map((token) => (/^[-+]?0+(?:\.0*)?$/.test(token) ? '0px' : token))
    .join(' ');
}

/** `element.style`: the inline style as React gave it, with what a script wrote on top. Properties read as camelCase. */
function inlineStyle(host: HostElement, readbackOf: () => Readback): CSSStyleDeclarationShim {
  const read = (property: string): string => {
    const overlay = overlayOf(host, false)?.style.get(property);
    if (overlay !== undefined) return serialized(property, overlay);
    const style = host.props.style;
    if (typeof style !== 'object' || style === null) return '';
    for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
      if (cssPropertyName(key) === property) return serialized(property, styleToCss({ [key]: value }).replace(/^[^:]*:\s*/, ''));
    }
    return '';
  };
  const target = {
    getPropertyValue: read,
    setProperty(property: string, value: string | null): void {
      const old = oldAttribute(host, 'style');
      overlayOf(host, true)!.style.set(kebab(property), value === null ? '' : written(kebab(property), String(value)));
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
        if (colon > 0) {
          const name = part.slice(0, colon).trim().toLowerCase();
          overlay.style.set(name, written(name, part.slice(colon + 1).trim()));
        }
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
    has: (t, prop) => prop in t || (typeof prop === 'string' && isKnownCssProperty(prop)),
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
/** The text properties an SVG element inherits, with what the page says when nothing does. */
const SVG_TEXT_DEFAULTS: Record<string, string> = { 'font-size': '16px', 'font-weight': '400', 'font-style': 'normal', 'font-family': 'serif', 'text-anchor': 'start' };

/** An inherited text property of an SVG element from its own attribute or style, or an ancestor's, when the layout has no answer for it. */
function svgTextProperty(host: HostElement, property: string, readback: Readback): string {
  for (let h: HostElement | null = host; h !== null; h = readback.parent(h)) {
    const props = propsWithOverlay(h);
    const style = typeof props.style === 'object' && props.style !== null ? (props.style as Record<string, unknown>) : {};
    const camel = property.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const value = style[camel] ?? style[property] ?? props[camel] ?? props[property];
    if (value !== undefined && value !== null && value !== '') {
      return property === 'font-size' && /^[\d.]+$/.test(String(value)) ? `${value}px` : String(value);
    }
  }
  return SVG_TEXT_DEFAULTS[property] ?? '';
}

export function computedStyleOf(host: HostElement, readback: Readback): CSSStyleDeclarationShim {
  const read = (property: string): string => {
    const answer = readback.computed(host, kebab(property)) ?? '';
    if (answer !== '' || !(kebab(property) in SVG_TEXT_DEFAULTS) || !(isSvgTag(host.type) || readback.parent(host)?.type === 'svg')) return answer;
    return svgTextProperty(host, kebab(property), readback);
  };
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
    has: (t, prop) => prop in t || (typeof prop === 'string' && isKnownCssProperty(prop)),
  }) as unknown as CSSStyleDeclarationShim;
}

type Listener = ((event: any) => void) | { handleEvent(event: any): void };

const elements = new WeakMap<HostElement, DomElement>();
const childLists = new WeakMap<HostElement, NodeList<DomElement | DomText>>();
/** A `<template>`'s content: a fragment of its own. */
const templateContents = new WeakMap<HostElement, HostElement>();
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
  return value instanceof DomElement || value instanceof DomText ? value.host : null;
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
    element = host.type === FRAGMENT ? new DomFragment(host) : new DomElement(host);
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

type Positioned = DomElement | DomText;

const POSITION = { DISCONNECTED: 1, PRECEDING: 2, FOLLOWING: 4, CONTAINS: 8, CONTAINED_BY: 16, IMPLEMENTATION_SPECIFIC: 32 } as const;
const detachedOrder = new WeakMap<object, number>();
let detachedCount = 0;

/** `a.compareDocumentPosition(b)`: where `b` is relative to `a`, as the DOM's bitmask. */
function documentPosition(a: Positioned, b: unknown): number {
  const document = (globalThis as { document?: unknown }).document;
  if (b === document && b !== undefined) return POSITION.CONTAINS | POSITION.PRECEDING;
  if (!(b instanceof DomElement) && !(b instanceof DomText)) throw new TypeError("Failed to execute 'compareDocumentPosition': parameter 1 is not of type 'Node'.");
  if (a === b) return 0;
  const chain = (n: Positioned): Positioned[] => {
    const out: Positioned[] = [n];
    for (let p = n.parentElement; p !== null; p = p.parentElement) out.push(p);
    return out;
  };
  const up = chain(a);
  const other = chain(b);
  if (up.at(-1) !== other.at(-1)) {
    // Two trees: which comes first is arbitrary but the same each time, and opposite when asked the other way round.
    const order = (n: Positioned): number => {
      const root = n.host as object;
      if (!detachedOrder.has(root)) detachedOrder.set(root, detachedCount++);
      return detachedOrder.get(root)!;
    };
    return POSITION.DISCONNECTED | POSITION.IMPLEMENTATION_SPECIFIC | (order(up.at(-1)!) < order(other.at(-1)!) ? POSITION.FOLLOWING : POSITION.PRECEDING);
  }
  if (up.includes(b)) return POSITION.CONTAINS | POSITION.PRECEDING;
  if (other.includes(a)) return POSITION.CONTAINED_BY | POSITION.FOLLOWING;
  // The two branches below their closest common ancestor: whichever sits first in that ancestor's children comes first.
  let i = up.length - 1;
  let j = other.length - 1;
  while (i > 0 && j > 0 && up[i - 1] === other[j - 1]) {
    i--;
    j--;
  }
  const ancestor = up[i] as DomElement;
  const kids = ancestor.childNodes;
  return kids.indexOf(other[j - 1]!) < kids.indexOf(up[i - 1]!) ? POSITION.PRECEDING : POSITION.FOLLOWING;
}

const TEXT_TAGS = new Set(['text', 'tspan']);
/** The HTML elements whose IDL attribute of each name reflects the content attribute (HTML, "reflect"). */
const REFLECTED: Record<string, Set<string>> = {
  src: new Set(['img', 'video', 'audio', 'source', 'track', 'script', 'iframe', 'embed', 'input']),
  srcset: new Set(['img', 'source']),
  sizes: new Set(['img', 'source']),
  alt: new Set(['img', 'area', 'input']),
  poster: new Set(['video']),
  href: new Set(['a', 'area', 'link', 'base']),
};
/** The SVG elements whose `href` is an SVGAnimatedString. */
const SVG_HREF_TAGS = new Set(['a', 'image', 'use', 'linearGradient', 'radialGradient', 'pattern', 'textPath', 'feImage', 'filter', 'mpath', 'script']);

/**
 * The registered font that measures text asking for `key`: that one, else the built-in fallback, else whichever is
 * registered, as the painter draws text whose family is not loaded. With no font registered the key goes to the text engine as it is.
 */
function measuringFont(key: string, fonts: Record<string, string>): string {
  if (key in fonts) return key;
  if ('Kinetograph Fallback' in fonts) return 'Kinetograph Fallback';
  return Object.keys(fonts)[0] ?? key;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** The host type of a `DocumentFragment`: a list of children that belongs to no tree and is never drawn. */
export const FRAGMENT = 'kg-fragment';

/** The document a node belongs to when it was not made by the page's own `document`: a parsed document, or the inert one a `<template>`'s content has. */
const ownerDocuments = new WeakMap<object, unknown>();
/** The document whose `documentElement` a host is. */
const documentOfRoot = new WeakMap<object, unknown>();

export function setOwnerDocument(host: DomNode, doc: unknown): void {
  ownerDocuments.set(host, doc);
}
export function setDocumentRoot(host: HostElement, doc: unknown): void {
  documentOfRoot.set(host, doc);
  ownerDocuments.set(host, doc);
}

/** The document a node belongs to: the one that made it, else the one its tree hangs from, else the page's. */
export function ownerDocumentOf(host: DomNode): unknown {
  const own = ownerDocuments.get(host);
  if (own !== undefined) return own;
  let top: DomNode = host;
  for (let p = rawParentOf(top); p !== null; p = rawParentOf(top)) top = p;
  return ownerDocuments.get(top) ?? (globalThis as { document?: unknown }).document;
}

/**
 * `Node`: what `instanceof Node` asks, and where `nodeType`, `nodeName` and `ownerDocument` live. They are getters on the
 * prototype (as in a browser) because DOMPurify reads them through `Node.prototype` so a page cannot shadow them.
 */
export class DomNodeBase {
  static readonly ELEMENT_NODE = 1;
  static readonly ATTRIBUTE_NODE = 2;
  static readonly TEXT_NODE = 3;
  static readonly CDATA_SECTION_NODE = 4;
  static readonly PROCESSING_INSTRUCTION_NODE = 7;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;
  static readonly DOCUMENT_TYPE_NODE = 10;
  static readonly DOCUMENT_FRAGMENT_NODE = 11;
  static readonly DOCUMENT_POSITION_DISCONNECTED = 1;
  static readonly DOCUMENT_POSITION_PRECEDING = 2;
  static readonly DOCUMENT_POSITION_FOLLOWING = 4;
  static readonly DOCUMENT_POSITION_CONTAINS = 8;
  static readonly DOCUMENT_POSITION_CONTAINED_BY = 16;
  static readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;
  get nodeType(): number {
    const host = (this as unknown as { host: DomNode }).host;
    return host.kind === 'text' ? 3 : host.type === FRAGMENT ? 11 : 1;
  }
  get nodeName(): string {
    const host = (this as unknown as { host: DomNode }).host;
    return host.kind === 'text' ? '#text' : host.type === FRAGMENT ? '#document-fragment' : (this as unknown as DomElement).tagName;
  }
  get nodeValue(): string | null {
    const host = (this as unknown as { host: DomNode }).host;
    return host.kind === 'text' ? host.text : null;
  }
  get ownerDocument(): unknown {
    return ownerDocumentOf((this as unknown as { host: DomNode }).host);
  }
}

export class DomElement extends DomNodeBase {
  private listeners = new Map<string, Set<Listener>>();
  private styleObject: CSSStyleDeclarationShim | null = null;

  constructor(readonly host: HostElement) {
    super();
  }

  /** The root whose tree holds this element (it can change: a script moves nodes), else the detached one. */
  private get readback(): Readback {
    return readbackOfHost(this.host);
  }

  // ---- identity ----

  get inSvg(): boolean {
    if (isSvgTag(this.host.type)) return true;
    // `foreignObject` holds HTML: what is inside it is not in the SVG namespace.
    for (let h: HostElement | null = this.host; h !== null; h = this.readback.parent(h)) {
      if (h.type === 'svg') return true;
      if (h.type === 'foreignObject' && h !== this.host) return false;
    }
    return false;
  }
  get tagName(): string {
    if (isFillLayer(this.host)) return 'DIV';
    return this.inSvg ? this.host.type : this.host.type.toUpperCase();
  }
  get localName(): string {
    return isFillLayer(this.host) ? 'div' : this.host.type.toLowerCase();
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
    // An SVGAnimatedString: `el.className.baseVal = 'on'` writes the class like `el.className = 'on'` does.
    const element = this;
    return this.inSvg
      ? {
          get baseVal(): string {
            return element.getAttribute('class') ?? '';
          },
          set baseVal(next: string) {
            element.setAttribute('class', next);
          },
        }
      : value;
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
      replace: (from: string, to: string) => {
        const names = list();
        if (!names.includes(from)) return false;
        write([...new Set(names.map((n) => (n === from ? to : n)))]);
        return true;
      },
      get value() {
        return list().join(' ');
      },
      set value(next: string) {
        write(next.split(/\s+/).filter(Boolean));
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
    const props = propsWithOverlay(this.host);
    const attributes = attributesOf(props, this.inSvg);
    // `style` is its own field in the props; as an attribute it is the declarations' text.
    const style = styleToCss(props.style);
    if (style !== '') attributes.style = style;
    return attributes;
  }
  get attributes(): NamedNodeMapShim {
    return attributeMapOf(this.host, this);
  }
  hasAttributes(): boolean {
    return this.getAttributeNames().length > 0;
  }
  getAttributeNode(name: string): AttrShim | null {
    const value = this.getAttribute(String(name));
    return value === null ? null : new AttrShim(this, this.getAttributeNames().find((n) => n === name || n === String(name).toLowerCase()) ?? String(name), value);
  }
  setAttributeNode(attr: AttrShim): AttrShim | null {
    const old = this.getAttributeNode(attr.name);
    this.setAttribute(attr.name, attr.value);
    return old;
  }
  removeAttributeNode(attr: AttrShim): AttrShim {
    if (!this.hasAttribute(attr.name)) throw new DOMExceptionShim("Failed to execute 'removeAttributeNode' on 'Element': The node provided is not an attribute of this element.", 'NotFoundError', 8);
    this.removeAttribute(attr.name);
    return attr;
  }
  get shadowRoot(): null {
    return null;
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
  // The namespaced forms keep the qualified name as the attribute's name; `xlink:href` also answers as `href` (what <use> and <image> read).
  setAttributeNS(_ns: string | null, qualifiedName: string, value: unknown): void {
    this.setAttribute(qualifiedName, value);
    if (qualifiedName === 'xlink:href' && this.getAttribute('href') === null) this.setAttribute('href', value);
  }
  getAttributeNS(ns: string | null, localName: string): string | null {
    return this.getAttribute(ns === XLINK_NS ? `xlink:${localName}` : ns === XML_NS ? `xml:${localName}` : localName);
  }
  hasAttributeNS(ns: string | null, localName: string): boolean {
    return this.getAttributeNS(ns, localName) !== null;
  }
  removeAttributeNS(ns: string | null, localName: string): void {
    const name = ns === XLINK_NS ? `xlink:${localName}` : ns === XML_NS ? `xml:${localName}` : localName;
    this.removeAttribute(name);
    if (name === 'xlink:href') this.removeAttribute('href');
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const want = force ?? !this.hasAttribute(name);
    if (want) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return want;
  }
  get dataset(): Record<string, string> {
    // Reads and writes go to the `data-*` attributes: `el.dataset.state = 'on'` sets `data-state`.
    const attribute = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const names = (): string[] =>
      Object.keys(this.attrs())
        .filter((name) => name.startsWith('data-'))
        .map((name) => name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));
    return new Proxy({} as Record<string, string>, {
      get: (_t, key) => (typeof key === 'string' ? (this.getAttribute(attribute(key)) ?? undefined) : undefined),
      set: (_t, key, value) => {
        if (typeof key === 'string') this.setAttribute(attribute(key), value);
        return true;
      },
      deleteProperty: (_t, key) => {
        if (typeof key === 'string') this.removeAttribute(attribute(key));
        return true;
      },
      has: (_t, key) => typeof key === 'string' && this.getAttribute(attribute(key)) !== null,
      ownKeys: () => names(),
      getOwnPropertyDescriptor: (_t, key) =>
        typeof key === 'string' && this.getAttribute(attribute(key)) !== null
          ? { value: this.getAttribute(attribute(key)) as string, enumerable: true, configurable: true, writable: true }
          : undefined,
    });
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
    if (parent !== null) return isDomElement(parent.type) || isFillLayer(parent) ? parent : null;
    // At the top of a root's tree (or of a script's detached one).
    return isConnectedHost(this.host) ? bodyHost : null;
  }
  get parentElement(): DomElement | null {
    return this.wrap(this.domParent());
  }
  get parentNode(): DomElement | Document | null {
    if (this.host === htmlHost) return (globalThis as { document?: Document }).document ?? null;
    const root = documentOfRoot.get(this.host);
    if (root !== undefined) return root as Document;
    const parent = effectiveParentOf(this.host);
    if (parent !== null && parent.type === FRAGMENT) return domElementFor(parent) as unknown as DomElement;
    return this.parentElement;
  }
  get isConnected(): boolean {
    return isConnectedHost(this.host);
  }
  /** The nodes in this element's own list, `<Sequence>`s replaced by what is inside them. */
  private childHosts(): DomNode[] {
    return this.readback.childNodes(this.host);
  }
  get childNodes(): NodeList<DomElement | DomText> {
    // One list per element, refilled each time it is asked for (a form's `childNodes` is compared with itself to find clobbering).
    let list = childLists.get(this.host);
    const nodes = this.childHosts().map(domNodeFor);
    if (list === undefined) {
      list = nodeListOf(nodes);
      childLists.set(this.host, list);
    } else {
      list.length = 0;
      list.push(...nodes);
    }
    return list as NodeList<DomElement | DomText>;
  }
  get children(): HTMLCollection<DomElement> {
    return collectionOf(this.childNodes.filter((n): n is DomElement => n instanceof DomElement));
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
  compareDocumentPosition(other: unknown): number {
    return documentPosition(this, other);
  }
  contains(other: unknown): boolean {
    const node = hostNodeOf(other);
    if (node === null) return false;
    if (node === this.host) return true;
    if (this.host === bodyHost) {
      // Anything in the document except `html`, `head` and what hangs from `head`.
      let top: DomNode = node;
      for (let p = effectiveParentOf(top); p !== null; p = effectiveParentOf(top)) top = p;
      return top !== htmlHost && top !== headHost && top !== bodyHost && isConnectedHost(node);
    }
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
    return expandFragments(
      nodes.map((n) => {
        const host = hostNodeOf(n);
        return host ?? createHostText(String(n));
      }),
    );
  }
  private static required(node: unknown, method: string): DomNode {
    const host = hostNodeOf(node);
    if (host === null) throw new TypeError(`Failed to execute '${method}' on 'Node': parameter 1 is not of type 'Node'.`);
    return host;
  }
  /** Merges adjacent text nodes into one and drops empty ones, in this element and everything inside it. */
  normalize(): void {
    const visit = (host: HostElement): void => {
      let previous: HostText | null = null;
      for (const child of [...host.children]) {
        if (child.kind === 'element') {
          previous = null;
          visit(child);
        } else if (child.text === '') {
          removeChild(child);
        } else if (previous !== null) {
          setText(previous, previous.text + child.text);
          removeChild(child);
        } else {
          previous = child;
        }
      }
    };
    visit(this.host);
  }
  appendChild<T>(child: T): T {
    for (const host of expandFragments([DomElement.required(child, 'appendChild')])) insertChild(this.host, host, null);
    return child;
  }
  insertBefore<T>(child: T, before: unknown): T {
    const hosts = expandFragments([DomElement.required(child, 'insertBefore')]);
    const anchor = before === null || before === undefined ? null : DomElement.required(before, 'insertBefore');
    for (const host of hosts) insertChild(this.host, host, anchor);
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
    const hosts = expandFragments([DomElement.required(child, 'replaceChild')]);
    const oldHost = DomElement.required(old, 'replaceChild');
    if (effectiveParentOf(oldHost) !== this.host && !(this.host === bodyHost && effectiveParentOf(oldHost) === null)) {
      throw new DOMExceptionShim("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.", 'NotFoundError', 8);
    }
    const after = this.nextHostAfter(oldHost);
    removeChild(oldHost);
    for (const host of hosts) insertChild(this.host, host, after);
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
    const copy = cloneHost(this.host, Boolean(deep)) as HostElement;
    // A template's content is not among its children: a deep copy takes it along.
    const content = templateContents.get(this.host);
    if (deep && content !== undefined) for (const child of content.children) insertChild(contentOf(copy), cloneHost(child, true), null);
    return domElementFor(copy);
  }
  /** A `<template>`'s content (a fragment); other elements have none. */
  get content(): DomFragment | undefined {
    return this.host.type === 'template' ? (domElementFor(contentOf(this.host)) as DomFragment) : undefined;
  }
  insertAdjacentElement(where: string, element: unknown): unknown {
    const host = DomElement.required(element, 'insertAdjacentElement');
    this.insertAdjacent(where, expandFragments([host]));
    return element;
  }
  insertAdjacentText(where: string, text: string): void {
    this.insertAdjacent(where, [createHostText(text)]);
  }
  insertAdjacentHTML(where: string, html: string): void {
    this.insertAdjacent(where, parsedNodes(parseHtmlFragment(String(html), this.inSvg)));
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
    const content = templateContents.get(this.host);
    return (content !== undefined ? content.children : this.childHosts()).map((n) => serializeHost(n, this.inSvg && this.host.type !== 'foreignObject')).join('');
  }
  set innerHTML(html: string) {
    if (this.host.type === 'template') {
      const content = contentOf(this.host);
      clearChildren(content);
      for (const node of parsedNodes(parseHtmlFragment(String(html), false))) insertChild(content, node, null);
      return;
    }
    clearChildren(this.host);
    for (const node of parsedNodes(parseHtmlFragment(String(html), this.inSvg))) insertChild(this.host, node, null);
  }
  get outerHTML(): string {
    return serializeHost(this.host, this.inSvg);
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
  querySelectorAll(selector: string): NodeList<DomElement> {
    return nodeListOf(queryAll(this.descendants(), selector, this.selectorContext(this.host)).map((h) => domElementFor(h, this.readback)));
  }
  getElementsByTagName(tag: string): HTMLCollection<DomElement> {
    return collectionOf(
      this.descendants()
        .filter((h) => tag === '*' || h.type.toLowerCase() === tag.toLowerCase())
        .map((h) => domElementFor(h, this.readback)),
    );
  }
  getElementsByClassName(names: string): HTMLCollection<DomElement> {
    const wanted = names.split(/\s+/).filter(Boolean);
    return collectionOf(
      this.descendants()
        .filter((h) => {
          const have = (domElementFor(h, this.readback).getAttribute('class') ?? '').split(/\s+/);
          return wanted.every((w) => have.includes(w));
        })
        .map((h) => domElementFor(h, this.readback)),
    );
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
    const shape = this.svgClientRect();
    if (shape !== null) return shape;
    const box = this.box();
    return box === null ? new DOMRectShim() : new DOMRectShim(box.rect.x, box.rect.y, box.rect.width, box.rect.height);
  }
  getClientRects(): DOMRectShim[] {
    return this.box() === null && this.svgClientRect() === null ? [] : [this.getBoundingClientRect()];
  }
  /**
   * The rect of an SVG shape inside an `<svg>` (the layout has no boxes for them): its `getBBox` through its transforms and its
   * `<svg>`'s `viewBox`, placed at the `<svg>`'s box. Null for anything else.
   */
  private svgClientRect(): DOMRectShim | null {
    const owner = this.ownerSVGElement;
    if (owner === null) return null;
    const svg = owner.box();
    const ctm = this.getCTM();
    if (ctm === null) return null;
    const b = this.getBBox();
    // An `<svg>` no layout reaches (one a script made to measure text in, and has not shown) is measured in its own
    // user units: where a browser, which lays every element out, would say the same for an `<svg>` with no size.
    let scale = 1;
    let ox = 0;
    let oy = 0;
    if (svg !== null) {
      const view = (owner.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
      const [vx, vy, vw, vh] = view.length === 4 && view.every(Number.isFinite) && view[2]! > 0 && view[3]! > 0 ? view : [0, 0, svg.width, svg.height];
      scale = Math.min(svg.width / vw!, svg.height / vh!);
      ox = svg.rect.x + (svg.width - vw! * scale) / 2 - vx! * scale;
      oy = svg.rect.y + (svg.height - vh! * scale) / 2 - vy! * scale;
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]] as const) {
      const x = ox + (ctm.a * px + ctm.c * py + ctm.e) * scale;
      const y = oy + (ctm.b * px + ctm.d * py + ctm.f) * scale;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
    return new DOMRectShim(x1, y1, x2 - x1, y2 - y1);
  }
  get offsetWidth(): number {
    return Math.round(this.box()?.width ?? 0);
  }
  get offsetHeight(): number {
    return Math.round(this.box()?.height ?? 0);
  }
  /**
   * The nearest ancestor that is not `position: static`, else `body` (the island's origin). As in a browser it is null
   * only for an element with no box, a fixed one, `body` and `html`: a library tells attached from detached by it
   * (GSAP re-parents an element whose `offsetParent` is null, to measure it).
   */
  get offsetParent(): DomElement | null {
    if (this.host === htmlHost || this.host === bodyHost || this.box() === null) return null;
    if (this.readback.computed(this.host, 'position') === 'fixed') return null;
    for (let h = this.readback.parent(this.host); h !== null; h = this.readback.parent(h)) {
      const position = this.readback.computed(h, 'position');
      if (position !== null && position !== 'static') return this.wrap(h);
    }
    return this.wrap(bodyHost);
  }
  get offsetLeft(): number {
    const box = this.box();
    if (box === null) return 0;
    const parent = this.offsetParent?.host;
    const origin = parent && parent !== bodyHost ? this.readback.box(parent) : null;
    return Math.round(box.x - (origin?.x ?? 0));
  }
  get offsetTop(): number {
    const box = this.box();
    if (box === null) return 0;
    const parent = this.offsetParent?.host;
    const origin = parent && parent !== bodyHost ? this.readback.box(parent) : null;
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
  // The IDL attributes a script commonly assigns (`img.src = url`) reflect their content attribute, as in a browser: the
  // property reads and writes the attribute, so what a script sets is drawn like markup. On an element that has no such
  // attribute the name is an ordinary property of the object (`div.src = x` is an expando, not an attribute).
  get src(): string {
    return this.reflected('src');
  }
  set src(value: string) {
    this.reflect('src', value);
  }
  get srcset(): string {
    return this.reflected('srcset');
  }
  set srcset(value: string) {
    this.reflect('srcset', value);
  }
  get sizes(): string {
    return this.reflected('sizes');
  }
  set sizes(value: string) {
    this.reflect('sizes', value);
  }
  get alt(): string {
    return this.reflected('alt');
  }
  set alt(value: string) {
    this.reflect('alt', value);
  }
  get poster(): string {
    return this.reflected('poster');
  }
  set poster(value: string) {
    this.reflect('poster', value);
  }
  /** The URL that is drawn: the `srcset` candidate a browser at device pixel ratio 1 takes, else `src`. */
  get currentSrc(): string {
    if (!REFLECTED.src!.has(this.host.type)) return undefined as never;
    const src = this.getAttribute('src') ?? undefined;
    const srcset = this.getAttribute('srcset');
    return (srcset !== null ? srcsetCandidate(srcset, src) : null) ?? src ?? '';
  }
  /**
   * `href`: a string on an HTML `<a>`, `<area>`, `<link>`, `<base>`; an SVGAnimatedString on the SVG elements that link
   * (`image.href.baseVal = url`), whose `baseVal` reads `href`, else the older `xlink:href`.
   */
  get href(): string | { baseVal: string; animVal: string } {
    if (this.inSvg && SVG_HREF_TAGS.has(this.host.type)) {
      const element = this;
      const read = (): string => element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '';
      return {
        get baseVal(): string {
          return read();
        },
        set baseVal(next: string) {
          element.setAttribute('href', next);
        },
        get animVal(): string {
          return read();
        },
      };
    }
    return this.reflected('href');
  }
  set href(value: string) {
    // An SVGAnimatedString is read-only: only its `baseVal` writes.
    if (this.inSvg && SVG_HREF_TAGS.has(this.host.type)) return;
    this.reflect('href', value);
  }
  // Unset on an element without the attribute it is `undefined`; once set, the own property shadows this accessor.
  private reflected(name: string): string {
    if (!REFLECTED[name]!.has(this.host.type)) return undefined as never;
    return this.getAttribute(name) ?? '';
  }
  private reflect(name: string, value: unknown): void {
    if (REFLECTED[name]!.has(this.host.type)) this.setAttribute(name, value);
    else Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
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
  // `<canvas>`: the 2D context records what is drawn, and the painter draws it (packages/cli/skills/kinetograph/references/SCENE.md, "canvas").
  getContext(type: string, attributes?: unknown): CanvasContext2D | GlRecorder | null {
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
  /**
   * What `queue.copyExternalImageToTexture` reads of a `<video>`: its file and the instant `currentTime` names, so that the
   * frame is the one for the time the page set (the renderer reads the picture at that time, not at a clock).
   */
  [VIDEO_FRAME](): VideoFrameSource | null {
    if (this.host.type !== 'video') return null;
    const file = projectFileOf(this.src);
    const size = this.media();
    if (file === null || size === null) return null;
    return { src: file, time: Number.isFinite(this.currentTime) && this.currentTime > 0 ? this.currentTime : 0, width: size.width, height: size.height };
  }
  /** What `drawImage` reads of this element: a canvas's commands, an image's file, a video's frame. */
  [CANVAS_SOURCE](): CanvasPicture | null {
    if (this.host.type === 'canvas') return canvasPictureOf(this.host, { width: this.width, height: this.height });
    if (this.host.type === 'img') return pictureOfImage(this.src);
    if (this.host.type === 'video') {
      // The frame at `currentTime`, as the renderer's decoder gives it.
      const frame = this[VIDEO_FRAME]();
      return frame === null ? null : { source: { kind: 'video', src: frame.src, time: frame.time }, width: frame.width, height: frame.height };
    }
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
    if (TEXT_TAGS.has(this.host.type)) {
      const box = this.textBBox();
      if (box !== null) return box;
    }
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
  /** The nearest `<svg>` this SVG element is inside (null for the `<svg>` itself and for anything outside SVG). */
  get ownerSVGElement(): DomElement | null {
    if (!this.inSvg) return null;
    for (let h = this.readback.parent(this.host); h !== null; h = this.readback.parent(h)) if (h.type === 'svg') return this.wrap(h);
    return null;
  }
  get viewportElement(): DomElement | null {
    return this.ownerSVGElement;
  }
  /** The element's transform to its `<svg>`'s user space: its own `transform` attribute and its ancestors', up to the `<svg>`. */
  getCTM(): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
    if (!this.inSvg) return null;
    let m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
    for (let h: HostElement | null = this.host; h !== null && h.type !== 'svg'; h = this.readback.parent(h)) {
      const t = affineOf(domElementFor(h).getAttribute('transform'));
      m = [
        t[0] * m[0] + t[2] * m[1], t[1] * m[0] + t[3] * m[1],
        t[0] * m[2] + t[2] * m[3], t[1] * m[2] + t[3] * m[3],
        t[0] * m[4] + t[2] * m[5] + t[4], t[1] * m[4] + t[3] * m[5] + t[5],
      ];
    }
    return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
  }
  getScreenCTM(): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
    return this.getCTM();
  }
  /** `element.transform.baseVal`: the `transform` attribute as one matrix (`consolidate()`), for libraries that read it. */
  get transform(): { baseVal: { numberOfItems: number; consolidate(): { matrix: Record<string, number> } | null; getItem(index: number): { matrix: Record<string, number> } } } | undefined {
    if (!this.inSvg) return undefined;
    const t = affineOf(this.getAttribute('transform'));
    const matrix = { a: t[0], b: t[1], c: t[2], d: t[3], e: t[4], f: t[5] };
    return { baseVal: { numberOfItems: this.getAttribute('transform') === null ? 0 : 1, consolidate: () => ({ matrix }), getItem: () => ({ matrix }) } };
  }
  getComputedTextLength(): number {
    if (TEXT_TAGS.has(this.host.type)) {
      const advance = this.advanceOf(this.svgText());
      if (advance > 0) return advance;
    }
    return this.box()?.width ?? 0;
  }
  /** The box of an SVG `<text>`/`<tspan>` from the text engine: its advance wide, a line high, at `x`/`y` moved by `text-anchor`. */
  private textBBox(): DOMRectShim | null {
    const text = this.svgText();
    if (text === '') return null;
    const width = this.advanceOf(text);
    if (width <= 0) return null;
    const computed = (property: string): string => this.readback.computed(this.host, property) ?? '';
    const size = parseFloat(computed('font-size')) || parseFloat(svgTextProperty(this.host, 'font-size', this.readback)) || 16;
    let ascent = size * 0.8;
    let height = size * 1.2;
    if (hasAddonFunction('layoutText')) {
      try {
        const family = (computed('font-family') || svgTextProperty(this.host, 'font-family', this.readback)).split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
        const weight = computed('font-weight') || svgTextProperty(this.host, 'font-weight', this.readback);
        const style = computed('font-style') || svgTextProperty(this.host, 'font-style', this.readback);
        const key = fontKey(family, weight === '' ? undefined : weight, style === 'italic' || style === 'oblique' ? 'italic' : undefined);
        const fonts = registeredFonts();
        const font = measuringFont(key, fonts);
        const line = addonFunction('layoutText')({ text, font, size, fonts }).lines?.[0];
        if (line) {
          ascent = line.baseline - line.top;
          height = line.bottom - line.top;
        }
      } catch {
        // The estimate above stands.
      }
    }
    const x = this.numberList('x')[0] ?? 0;
    const y = this.numberList('y')[0] ?? 0;
    const anchor = svgTextProperty(this.host, 'text-anchor', this.readback);
    const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    return new DOMRectShim(left, y - ascent, width, height);
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
        const fonts = registeredFonts();
        const font = measuringFont(key, fonts);
        const layout = (t: string): number => addonFunction('layoutText')({ text: t, font, size, fonts }).width;
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

// ---- fragments and templates ----

/** The children of each fragment among `hosts` in its place (a fragment is emptied into the node it is inserted into). */
function expandFragments(hosts: DomNode[]): DomNode[] {
  const out: DomNode[] = [];
  for (const host of hosts) {
    if (host.kind === 'element' && host.type === FRAGMENT) out.push(...host.children);
    else out.push(host);
  }
  return out;
}

let inertDocument: (() => unknown) | null = null;
/** Document code hands over how the inert document that owns every `<template>`'s content is made. */
export function setInertDocumentFactory(fn: () => unknown): void {
  inertDocument = fn;
}

/** A `<template>`'s content: made on first use. */
function contentOf(template: HostElement): HostElement {
  let content = templateContents.get(template);
  if (content === undefined) {
    content = { kind: 'element', type: FRAGMENT, props: {}, children: [] };
    templateContents.set(template, content);
    if (inertDocument !== null) ownerDocuments.set(content, inertDocument());
  }
  return content;
}

/**
 * Nodes the HTML parser made, ready to be put in a tree: each node knows its parent, and what is written inside a
 * `<template>` is its content instead of its children.
 */
export function parsedNodes(nodes: DomNode[]): DomNode[] {
  const visit = (node: DomNode, parent: HostElement | null): void => {
    if (parent !== null) setRawParent(node, parent);
    if (node.kind !== 'element') return;
    if (node.type === 'template' && node.children.length > 0) {
      const content = contentOf(node);
      for (const child of node.children) content.children.push(child);
      node.children.length = 0;
      for (const child of content.children) visit(child, content);
      return;
    }
    for (const child of node.children) visit(child, node);
  };
  for (const node of nodes) visit(node, null);
  return nodes;
}

/** `new DocumentFragment()` and what `createDocumentFragment` makes: children that hang from no tree. */
export class DomFragment extends DomElement {
  constructor(host: HostElement = { kind: 'element', type: FRAGMENT, props: {}, children: [] }) {
    super(host);
    if (!elements.has(host)) elements.set(host, this);
  }
  getElementById(id: string): DomElement | null {
    return this.querySelector(`#${String(id).replace(/[^\w-]/g, (c) => `\\${c}`)}`);
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
export function serializeHost(node: DomNode, inSvg = false): string {
  if (node.kind === 'text') return escapeText(node.text);
  if (node.type === 'kg-sequence' || node.type === FRAGMENT) return node.children.map((c) => serializeHost(c, inSvg)).join('');
  if (!isDomElement(node.type)) return '';
  // SVG attribute names keep their case (`viewBox`); inside `foreignObject` it is HTML again.
  const svg = inSvg || isSvgTag(node.type);
  const below = svg && node.type !== 'foreignObject';
  const props = propsWithOverlay(node);
  const attributes = attributesOf(props, svg);
  const style = styleToCss(props.style);
  const written = Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  const styleText = style === '' ? '' : ` style="${escapeAttribute(style)}"`;
  const open = `<${node.type}${written}${attributes.style === undefined ? styleText : ''}`;
  if (VOID_TAGS.has(node.type)) return `${open}>`;
  const content = templateContents.get(node);
  const inner = node.type === 'style' || node.type === 'script' ? node.children.map((c) => (c.kind === 'text' ? c.text : '')).join('') : (content !== undefined ? content.children : node.children).map((c) => serializeHost(c, below)).join('');
  return `${open}>${inner}</${node.type}>`;
}

/** A text node of the host tree, as a script sees it. */
export class DomText extends DomNodeBase {
  constructor(readonly host: HostText) {
    super();
  }
  hasChildNodes(): boolean {
    return false;
  }
  get childNodes(): NodeList<DomElement | DomText> {
    return nodeListOf([]);
  }
  get firstChild(): null {
    return null;
  }
  get lastChild(): null {
    return null;
  }
  normalize(): void {}
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
    const parent = effectiveParentOf(this.host);
    if (parent !== null && parent.type === FRAGMENT) return domElementFor(parent);
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
  compareDocumentPosition(other: unknown): number {
    return documentPosition(this, other);
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

// `Node.DOCUMENT_POSITION_*`, on the constructors and on the instances.
for (const cls of [DomElement, DomText]) {
  for (const [name, bit] of Object.entries(POSITION)) {
    Object.defineProperty(cls, `DOCUMENT_POSITION_${name}`, { value: bit });
    Object.defineProperty(cls.prototype, `DOCUMENT_POSITION_${name}`, { value: bit });
  }
}
