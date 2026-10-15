// What a React ref to a DOM host element is in compat mode (docs/ENGINE.md §1, "Readback"): an object that answers like
// a DOM element for measurement. Its boxes and computed styles come from the addon, for the island's current host tree
// (`Readback`, cached by tree generation). Script changes to `style` and attributes are laid over the props; nothing
// is ever drawn from this object, only read.

import { attributesOf } from '../request/attrs.js';
import { cssPropertyName, styleToCss } from '../request/style.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode } from '../types.js';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { CANVAS_SOURCE, type CanvasContext2D, type CanvasPicture, type WebGLContext } from '@kinetograph/scene';
import {
  bitmapSide,
  canvasCommandsOf,
  canvasPictureOf,
  canvasToBlob,
  canvasToDataUrl,
  contextOfHost,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  resetCanvasOf,
} from './canvas.js';
import { GEOMETRY_TAGS, pathMeasure, shapePath } from './geometry.js';
import { overlayOf, propsWithOverlay, type BoxInfo, type HostElement, type Readback } from './host.js';
import { matches, queryAll, type SelectorContext } from './selector.js';

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
function inlineStyle(host: HostElement, readback: Readback): CSSStyleDeclarationShim {
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
      overlayOf(host, true)!.style.set(kebab(property), value === null ? '' : String(value));
      readback.touch();
    },
    removeProperty(property: string): string {
      const old = read(kebab(property));
      overlayOf(host, true)!.style.set(kebab(property), '');
      readback.touch();
      return old;
    },
    get cssText(): string {
      return styleToCss({ ...(typeof host.props.style === 'object' ? host.props.style : {}), ...Object.fromEntries(overlayOf(host, false)?.style ?? []) });
    },
    set cssText(text: string) {
      const overlay = overlayOf(host, true)!;
      for (const part of text.split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) overlay.style.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
      }
      readback.touch();
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
export function domElementFor(host: HostElement, readback: Readback): DomElement {
  let element = elements.get(host);
  if (element === undefined) {
    element = new DomElement(host, readback);
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

  constructor(
    readonly host: HostElement,
    private readonly readback: Readback,
  ) {}

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
    overlayOf(this.host, true)!.attrs.set(name, String(value));
    this.readback.touch();
  }
  removeAttribute(name: string): void {
    overlayOf(this.host, true)!.attrs.set(name, null);
    this.readback.touch();
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
    return (this.styleObject ??= inlineStyle(this.host, this.readback));
  }

  // ---- the tree ----

  private wrap(node: HostElement | null): DomElement | null {
    return node === null ? null : domElementFor(node, this.readback);
  }
  get parentElement(): DomElement | null {
    return this.wrap(this.readback.parent(this.host));
  }
  get parentNode(): DomElement | null {
    return this.parentElement;
  }
  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document;
  }
  get isConnected(): boolean {
    return this.readback.isConnected(this.host);
  }
  get childNodes(): (DomElement | { nodeType: 3; nodeName: '#text'; textContent: string; data: string; nodeValue: string })[] {
    return this.readback.childNodes(this.host).map((n) =>
      n.kind === 'element'
        ? domElementFor(n, this.readback)
        : { nodeType: 3 as const, nodeName: '#text' as const, textContent: n.text, data: n.text, nodeValue: n.text },
    );
  }
  get children(): DomElement[] {
    return this.childNodes.filter((n): n is DomElement => n instanceof DomElement);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get firstElementChild(): DomElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): DomElement | null {
    return this.children.at(-1) ?? null;
  }
  private siblingElements(): HostElement[] {
    const parent = this.readback.parent(this.host);
    const list = parent === null ? this.readback.roots() : this.readback.childNodes(parent);
    return list.filter((n): n is HostElement => n.kind === 'element' && isDomElement(n.type));
  }
  get nextElementSibling(): DomElement | null {
    const sibs = this.siblingElements();
    return this.wrap(sibs[sibs.indexOf(this.host) + 1] ?? null);
  }
  get previousElementSibling(): DomElement | null {
    const sibs = this.siblingElements();
    return this.wrap(sibs[sibs.indexOf(this.host) - 1] ?? null);
  }
  get nextSibling(): DomElement | null {
    return this.nextElementSibling;
  }
  get previousSibling(): DomElement | null {
    return this.previousElementSibling;
  }
  get textContent(): string {
    const text = (nodes: DomNode[]): string =>
      nodes.map((n) => (n.kind === 'text' ? n.text : n.type === 'style' || n.type === 'script' ? '' : text(this.readback.childNodes(n)))).join('');
    return text(this.readback.childNodes(this.host));
  }
  get innerText(): string {
    return this.textContent;
  }
  contains(other: unknown): boolean {
    if (!(other instanceof DomElement)) return false;
    for (let h: HostElement | null = other.host; h !== null; h = this.readback.parent(h)) if (h === this.host) return true;
    return false;
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
    return canvasToDataUrl(canvasCommandsOf(this.host) ?? [], { width: this.width, height: this.height });
  }
  toBlob(callback: (blob: Blob | null) => void): void {
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
