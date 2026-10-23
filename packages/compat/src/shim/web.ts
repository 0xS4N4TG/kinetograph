// The browser globals a Remotion project commonly touches, as far as rendering is a pure function of (project, frame)
// (packages/cli/skills/kinetograph/references/ENGINE.md §10): `window` sizes, `matchMedia`, `new Image()`, `fetch` of project files, `document` queries over
// the host tree, `getComputedStyle`, the observers. There is no network and no clock: remote URLs fail with a message
// that says so. `<canvas>` is the native 2D canvas (`./canvas.ts`). Installed in Node only where the globals are missing.

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS_SOURCE, CanvasContext2D, CanvasGradient, CanvasPattern, ImageData, Path2D, WebGLContext, type CanvasPicture } from '@kinetographdev/scene';
import { resolveProjectFile } from '../environment.js';
import { OffscreenCanvasShim } from './canvas.js';
import { DomElement, DomText, domElementFor, domTextFor, isDomElementShim, selectorContextOf, setImagePictureReader, setImageSizeReader, setProjectFileResolver } from './element.js';
import { bodyHost, headHost, htmlHost, setPageViewport } from './host.js';
import { RangeShim } from './range.js';
import { createHostElement, createHostText } from './tree.js';
import { imageSizeOfBytes } from './image-size.js';
import { IntersectionObserverShim, MutationObserverShim, readbackRoots, ResizeObserverShim } from './observers.js';
import { matches, queryAll } from './selector.js';

// ---- the window ----

let viewport = { width: 1920, height: 1080 };

/** The composition's size, which `window.innerWidth`, `matchMedia` and `document.documentElement` report. */
export function setWebViewport(size: { width: number; height: number }): void {
  viewport = { width: size.width, height: size.height };
  setPageViewport(size);
}

const REMOTE = /^(https?|wss?|ftp):\/\//i;

export function remoteMessage(what: string, url: string): string {
  return (
    `${what}("${url}"): remote URLs are not available: Kinetograph renders offline, so a frame is a pure function of the ` +
    'project. Download the file into the project (public/) and use staticFile(), or bundle it with an import.'
  );
}

// ---- matchMedia ----

/** Evaluates a media query against the composition: a `screen` of its size at 1x, no preferences. */
export function evaluateMedia(query: string): boolean {
  const list = query.split(',').map((q) => q.trim());
  return list.some((q) => evaluateOne(q));
}

function evaluateOne(query: string): boolean {
  let q = query.toLowerCase().trim();
  let negate = false;
  if (q.startsWith('not ')) {
    negate = true;
    q = q.slice(4).trim();
  }
  q = q.replace(/^only\s+/, '');
  const parts = q.split(/\s+and\s+/).map((p) => p.trim()).filter(Boolean);
  const result = parts.every((part) => {
    if (part === 'all' || part === 'screen') return true;
    if (part === 'print' || part === 'speech' || part === 'tv') return false;
    const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]*?))?\s*\)$/.exec(part);
    if (!m) return false;
    return feature(m[1]!, m[2]?.trim());
  });
  return negate ? !result : result;
}

const lengthPx = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const m = /^(-?[\d.]+)(px|em|rem)?$/.exec(value);
  if (!m) return null;
  return m[2] === 'em' || m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
};

function feature(name: string, value: string | undefined): boolean {
  const { width, height } = viewport;
  switch (name) {
    case 'width': return value === undefined ? width > 0 : width === lengthPx(value);
    case 'min-width': return width >= (lengthPx(value) ?? Infinity);
    case 'max-width': return width <= (lengthPx(value) ?? -Infinity);
    case 'height': return value === undefined ? height > 0 : height === lengthPx(value);
    case 'min-height': return height >= (lengthPx(value) ?? Infinity);
    case 'max-height': return height <= (lengthPx(value) ?? -Infinity);
    case 'orientation': return value === (height >= width ? 'portrait' : 'landscape');
    case 'aspect-ratio': {
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(value ?? '');
      return m ? Math.abs(width / height - Number(m[1]) / Number(m[2])) < 1e-3 : false;
    }
    case 'prefers-reduced-motion': return value === 'no-preference';
    case 'prefers-color-scheme': return value === 'light';
    case 'prefers-contrast': return value === 'no-preference';
    case 'prefers-reduced-transparency': return value === 'no-preference';
    case 'hover': case 'any-hover': return value === 'none';
    case 'pointer': case 'any-pointer': return value === 'none';
    case 'resolution': case 'min-resolution': return value !== undefined && /^1(dppx|x)$/.test(value) ? true : name === 'min-resolution' && parseFloat(value ?? '') <= 1;
    case 'max-resolution': return parseFloat(value ?? '') >= 1;
    case '-webkit-device-pixel-ratio': return value === '1';
    case '-webkit-min-device-pixel-ratio': return parseFloat(value ?? '') <= 1;
    case '-webkit-max-device-pixel-ratio': return parseFloat(value ?? '') >= 1;
    case 'color': return true;
    case 'display-mode': return value === 'browser';
    case 'scripting': return value === 'enabled';
    case 'update': return value === 'none';
    default: return false;
  }
}

class MediaQueryListShim extends EventTarget {
  onchange: ((event: unknown) => void) | null = null;
  constructor(readonly media: string) {
    super();
  }
  get matches(): boolean {
    return evaluateMedia(this.media);
  }
  addListener(listener: (event: unknown) => void): void {
    this.addEventListener('change', listener as EventListener);
  }
  removeListener(listener: (event: unknown) => void): void {
    this.removeEventListener('change', listener as EventListener);
  }
}

// ---- project files ----

const MIME: Record<string, string> = {
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/** The file a URL or path names in the project, or null (a `data:` or `blob:` URL, or no such file). */
export function projectFileOf(url: string): string | null {
  if (url.startsWith('file:')) return fileURLToPath(url);
  if (/^(data|blob):/i.test(url)) return null;
  return resolveProjectFile(decodeURIComponent(url.split(/[?#]/)[0]!));
}

/** The pixel size of an image at `src`: a project file, a `data:` URL or an in-memory blob. */
function imageSizeAt(src: string): { width: number; height: number } | null {
  try {
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      const header = src.slice(5, comma);
      const body = src.slice(comma + 1);
      const bytes = header.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
      return imageSizeOfBytes(bytes);
    }
    const file = projectFileOf(src);
    if (file === null || !existsSync(file)) return null;
    return imageSizeOfBytes(readFileSync(file));
  } catch {
    return null;
  }
}

/** What `drawImage` reads of an image at `src`: a project file (by its path) or a `data:` URL, with its size. */
function imagePicture(src: string): CanvasPicture | null {
  const size = imageSizeAt(src);
  if (size === null) return null;
  if (src.startsWith('data:')) return { source: { kind: 'src', src }, ...size };
  const file = projectFileOf(src);
  return file === null ? null : { source: { kind: 'src', src: file }, ...size };
}

// ---- Image ----

class ImageShim extends EventTarget {
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  crossOrigin: string | null = null;
  decoding = 'auto';
  loading = 'eager';
  alt = '';
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  private source = '';
  private widthValue: number | null = null;
  private heightValue: number | null = null;
  private failure: Error | null = null;

  constructor(width?: number, height?: number) {
    super();
    if (width !== undefined) this.widthValue = width;
    if (height !== undefined) this.heightValue = height;
  }
  get width(): number {
    return this.widthValue ?? this.naturalWidth;
  }
  set width(value: number) {
    this.widthValue = value;
  }
  get height(): number {
    return this.heightValue ?? this.naturalHeight;
  }
  set height(value: number) {
    this.heightValue = value;
  }
  get currentSrc(): string {
    return this.complete && !this.failure ? this.source : '';
  }
  get src(): string {
    return this.source;
  }
  set src(value: string) {
    this.source = String(value);
    this.complete = false;
    this.failure = null;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    // The file is read now; the event comes after the current task, as a load does.
    let size: { width: number; height: number } | null = null;
    if (REMOTE.test(this.source)) this.failure = new Error(remoteMessage('new Image().src', this.source));
    else if (this.source.startsWith('blob:')) {
      const blob = resolveObjectURL(this.source);
      if (blob === undefined) this.failure = new Error(`new Image().src = "${this.source}": that blob URL is not known (it was revoked, or made in another process)`);
      else {
        // `Blob.arrayBuffer()` is asynchronous: the size is known after it.
        void blob.arrayBuffer().then((buffer) => {
          const found = imageSizeOfBytes(new Uint8Array(buffer));
          if (found === null) this.fail(new Error(`new Image(): the blob is not an image Kinetograph can read`));
          else this.succeed(found);
        });
        return;
      }
    } else {
      size = imageSizeAt(this.source);
      if (size === null) {
        const file = this.source.startsWith('data:') ? null : projectFileOf(this.source);
        this.failure = new Error(
          file === null && !this.source.startsWith('data:')
            ? `new Image().src = "${this.source}": no such file in the project (looked beside the entry and in public/)`
            : `new Image().src = "${this.source}": not an image Kinetograph can read (PNG, JPEG, GIF, WebP, BMP and SVG are)`,
        );
      }
    }
    if (this.failure) {
      const error = this.failure;
      queueMicrotask(() => this.fail(error));
    } else if (size) {
      const found = size;
      queueMicrotask(() => this.succeed(found));
    }
  }
  private succeed(size: { width: number; height: number }): void {
    this.naturalWidth = size.width;
    this.naturalHeight = size.height;
    this.complete = true;
    this.onload?.call(this, { type: 'load', target: this });
    this.dispatchEvent(new Event('load'));
  }
  private fail(error: Error): void {
    this.failure = error;
    this.complete = true;
    this.onerror?.call(this, { type: 'error', target: this, message: error.message, error });
    this.dispatchEvent(new Event('error'));
  }
  /** The file is read when `src` is set, so it can be drawn before its `load` event, as a decoded one can. */
  [CANVAS_SOURCE](): CanvasPicture | null {
    return this.source !== '' && !this.failure ? imagePicture(this.source) : null;
  }
  async decode(): Promise<void> {
    if (this.failure) throw new DOMExceptionLike(this.failure.message);
    if (this.complete) return;
    await new Promise<void>((resolve, reject) => {
      this.addEventListener('load', () => resolve(), { once: true });
      this.addEventListener('error', () => reject(new DOMExceptionLike(this.failure?.message ?? 'The image failed to load')), { once: true });
    });
  }
}

class DOMExceptionLike extends Error {
  override name = 'EncodingError';
}

// ---- fetch ----

const REAL_FETCH = Symbol.for('kinetograph.realFetch');

function makeFetch(real: typeof fetch): typeof fetch {
  return async function kinetographFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (/^(data|blob):/i.test(url)) return real(input, init);
    if (REMOTE.test(url)) throw new TypeError(remoteMessage('fetch', url));
    const file = projectFileOf(url);
    if (file === null || !existsSync(file)) {
      throw new TypeError(`fetch("${url}") failed: no such file in the project (looked beside the entry and in public/)`);
    }
    const body = await readFile(file);
    return new Response(body, { status: 200, headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  } as typeof fetch;
}

// ---- document queries over the host trees ----

function documentQuery(selector: string, first: boolean): DomElement[] {
  const out: DomElement[] = [];
  // `head` first (a script's `<style>` and `<link>` go there), then each root's tree.
  const head = domElementFor(headHost);
  for (const found of first ? [head.querySelector(selector)].filter((e) => e !== null) : head.querySelectorAll(selector)) {
    out.push(found as DomElement);
    if (first) return out;
  }
  for (const readback of readbackRoots()) {
    const cx = selectorContextOf(readback);
    for (const host of queryAll(readback.descendants(), selector, cx, first)) {
      out.push(domElementFor(host, readback));
      if (first) return out;
    }
  }
  return out;
}

// ---- installing ----

class LocalStorage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(String(key)) ?? null; }
  setItem(key: string, value: unknown): void { this.map.set(String(key), String(value)); }
  removeItem(key: string): void { this.map.delete(String(key)); }
  clear(): void { this.map.clear(); }
}

/** Defines `name` unless the object has it already (`force` replaces it: storage must not outlive a render). */
function define(target: Record<string, unknown>, name: string, value: unknown, force = false): void {
  if (force || !(name in target)) {
    Object.defineProperty(target, name, { value, configurable: true, writable: true, enumerable: false });
  }
}

function defineGetter(target: Record<string, unknown>, name: string, get: () => unknown): void {
  if (!(name in target)) Object.defineProperty(target, name, { get, configurable: true, enumerable: false });
}

/** Puts `window`, `document`, `Image`, `matchMedia`, the observers and a project-files-only `fetch` on the global object. */
export function installDomGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  setImageSizeReader(imageSizeAt);
  setImagePictureReader(imagePicture);
  setProjectFileResolver(projectFileOf);

  if (!('window' in g)) Object.defineProperty(g, 'window', { value: globalThis, configurable: true, writable: true, enumerable: false });
  if (!('self' in g)) Object.defineProperty(g, 'self', { value: globalThis, configurable: true, writable: true, enumerable: false });
  if (!('top' in g)) Object.defineProperty(g, 'top', { value: globalThis, configurable: true, writable: true, enumerable: false });
  if (!('parent' in g)) Object.defineProperty(g, 'parent', { value: globalThis, configurable: true, writable: true, enumerable: false });

  defineGetter(g, 'innerWidth', () => viewport.width);
  defineGetter(g, 'innerHeight', () => viewport.height);
  defineGetter(g, 'outerWidth', () => viewport.width);
  defineGetter(g, 'outerHeight', () => viewport.height);
  defineGetter(g, 'devicePixelRatio', () => 1);
  defineGetter(g, 'scrollX', () => 0);
  defineGetter(g, 'scrollY', () => 0);
  defineGetter(g, 'pageXOffset', () => 0);
  defineGetter(g, 'pageYOffset', () => 0);
  defineGetter(g, 'screen', () => ({
    width: viewport.width, height: viewport.height, availWidth: viewport.width, availHeight: viewport.height,
    colorDepth: 24, pixelDepth: 24, orientation: { type: viewport.height >= viewport.width ? 'portrait-primary' : 'landscape-primary', angle: 0 },
  }));
  define(g, 'matchMedia', (query: string) => new MediaQueryListShim(String(query)));
  define(g, 'getComputedStyle', (element: unknown) => {
    if (isDomElementShim(element)) return element.computedStyle();
    return new Proxy({ getPropertyValue: () => '', length: 0 } as Record<string, unknown>, { get: (t, p) => (typeof p === 'string' && p in t ? t[p] : '') });
  });
  define(g, 'scrollTo', () => {});
  define(g, 'scroll', () => {});
  define(g, 'focus', () => {});
  define(g, 'blur', () => {});
  define(g, 'open', () => null);
  define(g, 'alert', () => {});
  define(g, 'requestIdleCallback', (callback: (deadline: object) => void) =>
    (g.setTimeout as typeof setTimeout)(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 1) as unknown as number);
  define(g, 'cancelIdleCallback', (id: number) => (g.clearTimeout as typeof clearTimeout)(id));
  define(g, 'location', {
    href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost',
    port: '', pathname: '/', search: '', hash: '', assign() {}, replace() {}, reload() {},
    toString() { return 'http://localhost/'; },
  });
  // In memory and empty at every start: Node's own (when it has one) is a file, which would make a frame depend on a previous run.
  define(g, 'localStorage', new LocalStorage(), true);
  define(g, 'sessionStorage', new LocalStorage(), true);
  define(g, 'history', { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} });

  define(g, 'Image', ImageShim);
  define(g, 'HTMLImageElement', ImageShim);
  define(g, 'HTMLCanvasElement', DomElement);
  define(g, 'OffscreenCanvas', OffscreenCanvasShim);
  define(g, 'CanvasRenderingContext2D', CanvasContext2D);
  define(g, 'WebGLRenderingContext', WebGLContext);
  define(g, 'WebGL2RenderingContext', WebGLContext);
  define(g, 'CanvasGradient', CanvasGradient);
  define(g, 'CanvasPattern', CanvasPattern);
  define(g, 'Path2D', Path2D);
  define(g, 'ImageData', ImageData);
  define(g, 'Element', DomElement);
  define(g, 'HTMLElement', DomElement);
  define(g, 'SVGElement', DomElement);
  define(g, 'Node', DomElement);
  define(g, 'DOMRect', class DOMRectGlobal { constructor(readonly x = 0, readonly y = 0, readonly width = 0, readonly height = 0) {} });
  define(g, 'ResizeObserver', ResizeObserverShim);
  define(g, 'IntersectionObserver', IntersectionObserverShim);
  define(g, 'MutationObserver', MutationObserverShim);

  // `fetch` of project files only. The real one stays reachable for the font downloads, which are explicit and cached.
  if (typeof g.fetch === 'function' && (g.fetch as { kinetograph?: boolean }).kinetograph !== true) {
    const real = g.fetch as typeof fetch;
    const wrapped = makeFetch(real);
    (wrapped as unknown as { kinetograph: boolean }).kinetograph = true;
    Object.defineProperty(g, REAL_FETCH, { value: real, configurable: true, enumerable: false });
    g.fetch = wrapped;
  }

  // `document`: `fonts` was put there by installFontFace; the rest is queries over the host trees and scratch nodes.
  const doc = (g.document ??= {}) as Record<string, unknown>;
  define(doc, 'readyState', 'complete');
  define(doc, 'hidden', false);
  define(doc, 'visibilityState', 'visible');
  define(doc, 'title', '');
  define(doc, 'cookie', '');
  define(doc, 'compatMode', 'CSS1Compat');
  define(doc, 'characterSet', 'UTF-8');
  // The document's own elements are real ones: a script's `document.head.prepend(style)` and `document.body.append(canvas)`
  // put nodes into the tree that is drawn (`head`'s `<style>`s are stylesheets; `body` is the top level of the root).
  const html = domElementFor(htmlHost);
  define(doc, 'documentElement', html);
  define(doc, 'body', domElementFor(bodyHost));
  define(doc, 'head', domElementFor(headHost));
  define(doc, 'scrollingElement', html);
  // A node a script makes belongs to no tree until it is put in one (a canvas drawn on before then keeps what it drew).
  define(doc, 'createElement', (tag: string) => domElementFor(createHostElement(String(tag))));
  define(doc, 'createElementNS', (ns: string, tag: string) => domElementFor(createHostElement(String(tag), String(ns) === 'http://www.w3.org/2000/svg')));
  define(doc, 'createTextNode', (text: string) => domTextFor(createHostText(String(text))));
  define(doc, 'createRange', () => new RangeShim());
  define(g, 'Range', RangeShim);
  define(g, 'Text', DomText);
  define(doc, 'getElementById', (id: string) => documentQuery(`#${CSS_ESCAPE(String(id))}`, true)[0] ?? null);
  define(doc, 'querySelector', (selector: string) => documentQuery(selector, true)[0] ?? null);
  define(doc, 'querySelectorAll', (selector: string) => documentQuery(selector, false));
  define(doc, 'getElementsByTagName', (tag: string) => documentQuery(tag, false));
  define(doc, 'getElementsByClassName', (names: string) => documentQuery(String(names).split(/\s+/).filter(Boolean).map((n) => `.${n}`).join(''), false));
  define(doc, 'elementFromPoint', () => null);
  define(doc, 'hasFocus', () => true);
  const listeners = new EventTarget();
  define(doc, 'addEventListener', listeners.addEventListener.bind(listeners));
  define(doc, 'removeEventListener', listeners.removeEventListener.bind(listeners));
  define(doc, 'dispatchEvent', listeners.dispatchEvent.bind(listeners));
  define(g, 'CSS', { supports: () => false, escape: (s: string) => CSS_ESCAPE(String(s)) });

  // `window.addEventListener('resize' | 'load' | …)`: accepted, never fired (the window never changes size).
  if (typeof g.addEventListener !== 'function') {
    const events = new EventTarget();
    define(g, 'addEventListener', events.addEventListener.bind(events));
    define(g, 'removeEventListener', events.removeEventListener.bind(events));
    define(g, 'dispatchEvent', events.dispatchEvent.bind(events));
  }
}

const CSS_ESCAPE = (s: string): string => s.replace(/[^\w-]/g, (c) => `\\${c}`);

/** The `fetch` that was global before `installDomGlobals` replaced it (the font downloads use it). */
export function realFetch(): typeof fetch {
  return ((globalThis as Record<symbol, unknown>)[REAL_FETCH] as typeof fetch | undefined) ?? fetch;
}

// A `matches` and a `queryAll` for the document are in `DomElement`; these are for code that holds a host directly.
export { matches, queryAll };
