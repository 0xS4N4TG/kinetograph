// `Worker` and `MessageChannel` for a page that hands work to a worker (a map library parsing tiles, a decoder). The
// worker runs on this thread, in a global scope of its own (`self`, `postMessage`, `onmessage`, `importScripts`, `close`,
// `location`, `navigator`), and every message, between a worker and the page or between two ports, is cloned as a browser
// clones it and delivered by one queue: first in, first out, one batch each turn of the event loop, so the order of what
// a page sees does not depend on timing. While anything is queued or a worker's own fetch is out, the frame is held
// (`setWorkerHold`, which core joins to `delayRender`), so a frame is never read with a message in flight. The class is
// the whole surface a page sees; a backend on `worker_threads` can stand behind it later (the queue is the only part
// that assumes one thread).

import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { resolveDocumentUrl } from '../environment.js';
import { HARDWARE_CONCURRENCY, projectFileOf } from './web.js';

// ---- the queue ----

type Task = () => void | Promise<void>;

const queue: Task[] = [];
/** Work a worker started that the queue does not hold: its fetches and image decodes. */
let outstanding = 0;
let pumping = false;
let quiet = 0;
let release: (() => void) | null = null;
let idleWaiters: (() => void)[] = [];
let hold: (() => () => void) | null = null;

/** Called when messages are first queued; returns what to call when none is left. Core holds the frame with it. */
export function setWorkerHold(next: (() => () => void) | null): void {
  hold = next;
}

function enqueue(task: Task): void {
  queue.push(task);
  if (pumping) return;
  pumping = true;
  quiet = 0;
  release = hold?.() ?? null;
  setImmediate(turn);
}

async function turn(): Promise<void> {
  const batch = queue.splice(0);
  for (const task of batch) {
    try {
      const done = task();
      if (done !== undefined) await done;
    } catch (error) {
      reportUncaught(error);
    }
  }
  // Quiet for two turns in a row: what a task started (a fetch whose reply posts a message) has had its chance.
  quiet = queue.length === 0 && outstanding === 0 ? quiet + 1 : 0;
  if (quiet < 2) {
    setImmediate(turn);
    return;
  }
  pumping = false;
  release?.();
  release = null;
  const waiting = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiting) resolve();
}

/** Resolves when no message is queued and no worker fetch is out (immediately when none is). */
export function whenWorkersIdle(): Promise<void> {
  return pumping ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Worker-side async work (fetch, image decode), counted so the frame waits for it, and resolved in the order it was
 * started: two replies that arrive in either order are seen in one, so what a worker posts does not follow the disk.
 */
function ordered<T>(work: () => Promise<T>): Promise<T> {
  outstanding++;
  const started = work();
  const result = tail.then(() => started);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    outstanding--;
  });
}

// ---- events ----

type Listener = EventListenerOrEventListenerObject;

/** Own event target: a listener that throws is reported to `onError` and the rest still run (Node's reports it as a crash). */
class Target {
  private readonly listeners = new Map<string, { listener: Listener; once: boolean }[]>();
  private readonly slots = new Map<string, Listener | null>();
  onError: (error: unknown) => void = reportUncaught;

  addEventListener(type: string, listener: Listener | null, options?: AddEventListenerOptions | boolean): void {
    if (listener === null || listener === undefined) return;
    const list = this.listeners.get(type) ?? [];
    if (list.some((entry) => entry.listener === listener)) return;
    list.push({ listener, once: typeof options === 'object' && options.once === true });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener | null): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }
  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    Object.defineProperty(event, 'currentTarget', { value: this, configurable: true });
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      try {
        if (typeof entry.listener === 'function') entry.listener.call(this, event);
        else entry.listener.handleEvent(event);
      } catch (error) {
        this.onError(error);
      }
    }
    return !event.defaultPrevented;
  }
  /** `onmessage = fn`: the one listener of its kind, replaced when assigned again. */
  protected slot(type: string, value: Listener | null): void {
    const previous = this.slots.get(type) ?? null;
    const next = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
    this.slots.set(type, next);
    if (previous !== null) this.removeEventListener(type, previous);
    if (next !== null) this.addEventListener(type, next);
  }
  protected slotOf(type: string): Listener | null {
    return this.slots.get(type) ?? null;
  }
}

function reportUncaught(error: unknown): void {
  console.error(`Uncaught ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
}

class MessageEventShim extends MessageEvent<unknown> {
  constructor(data: unknown, ports: readonly MessagePortShim[] = []) {
    super('message', { data });
    Object.defineProperty(this, 'ports', { value: Object.freeze([...ports]), configurable: true });
  }
}

// ---- structured clone ----

const CLONE = Symbol.for('kinetograph.structuredClone');

/** Implemented by the shim's own cloneable objects (an `ImageBitmap`): the copy, and the source closed when `transferred`. */
export interface Cloneable {
  [CLONE](transferred: boolean): unknown;
}

const isCloneable = (value: unknown): value is Cloneable => typeof value === 'object' && value !== null && typeof (value as Partial<Cloneable>)[CLONE] === 'function';

/** `ArrayBuffer.prototype.detached` and `transfer` (Node 21+); the project's `lib` is older. */
type Transferable = ArrayBuffer & { detached: boolean; transfer(): ArrayBuffer };

const dataCloneError = (message: string): DOMException => new DOMException(message, 'DataCloneError');

const ERROR_TYPES: Record<string, ErrorConstructor> = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };

/**
 * `value` as `postMessage` delivers it: a copy that shares nothing with the sender. An `ArrayBuffer` in `transfer` is
 * detached on the sender's side, a `MessagePort` in it moves to the receiver; a function, a symbol, or a port that is not
 * transferred throws a `DataCloneError`, as in a browser.
 */
export function cloneMessage(value: unknown, transfer: readonly unknown[] = []): { value: unknown; ports: MessagePortShim[] } {
  const buffers = new Set<Transferable>();
  const moves = new Set<object>();
  for (const item of transfer) {
    if (item instanceof ArrayBuffer && !(item as Transferable).detached) buffers.add(item as Transferable);
    else if (item instanceof MessagePortShim || isCloneable(item)) moves.add(item);
    else throw dataCloneError('Value not transferable.');
  }
  const seen = new Map<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (typeof input === 'function' || typeof input === 'symbol') throw dataCloneError(`${typeof input === 'function' ? String(input).slice(0, 40) : String(input)} could not be cloned.`);
    if (typeof input !== 'object' || input === null) return input;
    if (seen.has(input)) return seen.get(input);
    const remember = <T>(made: T): T => {
      seen.set(input, made);
      return made;
    };
    if (input instanceof ArrayBuffer) return remember(input.slice(0));
    if (ArrayBuffer.isView(input)) {
      const buffer = copy(input.buffer) as ArrayBuffer;
      if (input instanceof DataView) return remember(new DataView(buffer, input.byteOffset, input.byteLength));
      const Ctor = input.constructor as new (b: ArrayBuffer, o: number, l: number) => unknown;
      return remember(new Ctor(buffer, input.byteOffset, (input as unknown as { length: number }).length));
    }
    if (input instanceof MessagePortShim) {
      if (!moves.has(input)) throw dataCloneError('A MessagePort could not be cloned because it was not transferred.');
      return remember(input[CLONE](true));
    }
    if (isCloneable(input)) return remember(input[CLONE](moves.has(input)));
    if (input instanceof Date) return remember(new Date(input.getTime()));
    if (input instanceof RegExp) return remember(new RegExp(input.source, input.flags));
    if (input instanceof Blob) return remember(input);
    if (input instanceof Boolean || input instanceof Number || input instanceof String) return remember(Object(input.valueOf()));
    if (input instanceof Map) {
      const map = remember(new Map());
      for (const [key, item] of input) map.set(copy(key), copy(item));
      return map;
    }
    if (input instanceof Set) {
      const set = remember(new Set());
      for (const item of input) set.add(copy(item));
      return set;
    }
    if (input instanceof Error) {
      const Ctor = ERROR_TYPES[input.name] ?? Error;
      const error = remember(new Ctor(input.message));
      if (input.stack !== undefined) Object.defineProperty(error, 'stack', { value: input.stack, configurable: true, writable: true });
      if ('cause' in input) Object.defineProperty(error, 'cause', { value: copy(input.cause), configurable: true, writable: true });
      return error;
    }
    if (Array.isArray(input)) {
      const array: unknown[] = remember(new Array(input.length));
      for (const key of Object.keys(input)) array[key as never] = copy((input as never)[key]);
      return array;
    }
    const out: Record<string, unknown> = remember({});
    for (const key of Object.keys(input)) out[key] = copy((input as Record<string, unknown>)[key]);
    return out;
  };
  const cloned = copy(value);
  // Detached on the sender's side now that the receiver has its bytes.
  for (const buffer of buffers) buffer.transfer();
  // A transferred port or bitmap the message does not mention still moves; `event.ports` lists the ports in transfer order.
  const ports: MessagePortShim[] = [];
  for (const item of moves) {
    const moved = seen.has(item) ? seen.get(item) : (item as Cloneable)[CLONE](true);
    if (moved instanceof MessagePortShim) ports.push(moved);
  }
  return { value: cloned, ports };
}

const transferOf = (options: unknown): unknown[] =>
  Array.isArray(options) ? options : typeof options === 'object' && options !== null && Array.isArray((options as { transfer?: unknown[] }).transfer) ? (options as { transfer: unknown[] }).transfer : [];

// ---- ports ----

/** One end of a `MessageChannel`. Messages wait until it is started (`start()`, or `onmessage` assigned). */
export class MessagePortShim extends Target implements Cloneable {
  private peer: MessagePortShim | null = null;
  private started = false;
  private closed = false;
  private movedTo: MessagePortShim | null = null;
  private held: Event[] = [];

  static pair(): [MessagePortShim, MessagePortShim] {
    const a = new MessagePortShim();
    const b = new MessagePortShim();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }
  get onmessage(): Listener | null {
    return this.slotOf('message');
  }
  set onmessage(value: Listener | null) {
    this.slot('message', value);
    this.start();
  }
  get onmessageerror(): Listener | null {
    return this.slotOf('messageerror');
  }
  set onmessageerror(value: Listener | null) {
    this.slot('messageerror', value);
  }
  postMessage(message: unknown, options?: unknown): void {
    const { value, ports } = cloneMessage(message, transferOf(options));
    const target = this.peer;
    if (target === null || this.closed) return;
    enqueue(() => target.receive(new MessageEventShim(value, ports)));
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    const waiting = this.held;
    this.held = [];
    for (const event of waiting) enqueue(() => this.receive(event));
  }
  close(): void {
    this.closed = true;
    if (this.peer) this.peer.peer = null;
    this.peer = null;
    this.held = [];
  }
  private receive(event: Event): void {
    if (this.movedTo !== null) return this.movedTo.receive(event);
    if (this.closed) return;
    if (!this.started) this.held.push(event);
    else this.dispatchEvent(event);
  }
  /** A port in a transfer list: the receiver's port takes this one's place in the pair, and this one is dead. */
  [CLONE](transferred: boolean): MessagePortShim {
    if (!transferred) throw dataCloneError('A MessagePort could not be cloned because it was not transferred.');
    const next = new MessagePortShim();
    next.peer = this.peer;
    if (this.peer) this.peer.peer = next;
    next.held = this.held;
    this.peer = null;
    this.held = [];
    this.movedTo = next;
    this.closed = true;
    return next;
  }
}

export class MessageChannelShim {
  readonly port1: MessagePortShim;
  readonly port2: MessagePortShim;
  constructor() {
    [this.port1, this.port2] = MessagePortShim.pair();
  }
}

// ---- the worker's global scope ----

export class WorkerGlobalScopeShim extends Target {
  get onmessage(): Listener | null {
    return this.slotOf('message');
  }
  set onmessage(value: Listener | null) {
    this.slot('message', value);
  }
  get onmessageerror(): Listener | null {
    return this.slotOf('messageerror');
  }
  set onmessageerror(value: Listener | null) {
    this.slot('messageerror', value);
  }
  get onerror(): Listener | null {
    return this.slotOf('error');
  }
  set onerror(value: Listener | null) {
    this.slot('error', value);
  }
}
export class DedicatedWorkerGlobalScopeShim extends WorkerGlobalScopeShim {}

/** What a worker's script must not see of the page's global object: it has no window. */
const PAGE_ONLY = [
  'window', 'document', 'parent', 'top', 'frames', 'opener', 'localStorage', 'sessionStorage', 'history', 'screen', 'innerWidth',
  'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'matchMedia', 'getComputedStyle', 'visualViewport', 'customElements',
  'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'Element', 'Node', 'Image',
] as const;

const UNSCOPABLE = Object.fromEntries(
  ['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].map((n) => [n, true]),
);

/** Runs `code` as a classic script with `scope` as its global scope: a free name it assigns lands on `scope`, one it reads is looked up there first. */
function runIn(scope: object, code: string, file: string): void {
  const wrapper = `(function (__scope) { with (__scope) {\n${code}\n} })`;
  (new Script(wrapper, { filename: file }).runInThisContext() as (s: object) => void).call(scope, scope);
}

const MODULE_SYNTAX = /(^|[\n;])\s*(import\s*(?:[\w{*$"']|\()|export\s+(?:default|const|let|var|function|class|async|\{|\*))/;

let moduleLoader: ((file: string | null, code: string, url: string) => string) | null = null;

/** Turns a module worker's source into a classic script (bundles its imports): the CLI sets one made of esbuild. */
export function setWorkerModuleLoader(loader: ((file: string | null, code: string, url: string) => string) | null): void {
  moduleLoader = loader;
}

function sourceOfSync(url: string): { code: string; file: string | null } {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const body = url.slice(comma + 1);
    return { code: url.slice(5, comma).endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body), file: null };
  }
  const file = projectFileOf(url);
  if (file === null) throw new DOMException(`Failed to execute 'importScripts' on 'WorkerGlobalScope': the script at '${url}' cannot be read here (a project file or a data: URL can)`, 'NetworkError');
  return { code: readFileSync(file, 'utf8'), file };
}

let workerCount = 0;

// ---- Worker ----

export interface WorkerShimOptions {
  type?: 'classic' | 'module';
  name?: string;
}

export class WorkerShim extends Target {
  private scope: (WorkerGlobalScopeShim & Record<string, unknown>) | null = null;
  private ready = false;
  private dead = false;
  /** The script called `close()`: nothing more is delivered to it or posted by it, but what it already posted arrives. */
  private closed = false;
  private early: Event[] = [];
  private readonly url: string;
  private readonly module: boolean;

  constructor(url: string | URL, options: WorkerShimOptions = {}) {
    super();
    const text = String(url);
    this.url = /^(blob|data|file):/i.test(text) ? text : resolveDocumentUrl(text);
    this.module = options.type === 'module';
    workerCount++;
    enqueue(() => this.load(options.name ?? ''));
  }

  get onmessage(): Listener | null {
    return this.slotOf('message');
  }
  set onmessage(value: Listener | null) {
    this.slot('message', value);
  }
  get onmessageerror(): Listener | null {
    return this.slotOf('messageerror');
  }
  set onmessageerror(value: Listener | null) {
    this.slot('messageerror', value);
  }
  get onerror(): Listener | null {
    return this.slotOf('error');
  }
  set onerror(value: Listener | null) {
    this.slot('error', value);
  }

  postMessage(message: unknown, options?: unknown): void {
    const { value, ports } = cloneMessage(message, transferOf(options));
    if (this.dead) return;
    enqueue(() => this.deliver(new MessageEventShim(value, ports)));
  }

  terminate(): void {
    this.dead = true;
    this.scope = null;
    this.early = [];
  }

  /** The worker's script threw, or a handler did: an `error` event on the Worker, and when nobody handles it, an error on the page. */
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const event = new ErrorEvent('error', { message, error, filename: this.url, cancelable: true });
    this.dispatchEvent(event);
    if (!event.defaultPrevented && this.slotOf('error') === null) reportUncaught(`${message} (in the worker ${this.url.slice(0, 80)})`);
  }

  private deliver(event: Event): void {
    if (this.dead || this.closed) return;
    if (!this.ready) this.early.push(event);
    else this.scope!.dispatchEvent(event);
  }

  private async load(name: string): Promise<void> {
    let code: string;
    let file: string | null = null;
    try {
      const response = await ordered(() => (globalThis.fetch as typeof fetch)(this.url));
      if (!response.ok) throw new Error(`the worker script ${this.url.slice(0, 80)} could not be loaded (${response.status})`);
      code = await response.text();
      file = /^(blob|data):/.test(this.url) ? null : projectFileOf(this.url);
      if (this.module && MODULE_SYNTAX.test(code)) {
        if (moduleLoader === null) throw new Error(`the module worker ${this.url.slice(0, 80)} has imports or exports, and this render has no bundler for them: bundle the worker into one script, or write it as a classic script`);
        code = moduleLoader(file, code, this.url);
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.dead) return;
    const scope = this.makeScope(name);
    this.scope = scope;
    try {
      runIn(scope, code, file ?? this.url);
    } catch (error) {
      this.fail(error);
    }
    if (this.dead) return;
    this.ready = true;
    const early = this.early;
    this.early = [];
    for (const event of early) enqueue(() => this.deliver(event));
  }

  private makeScope(name: string): WorkerGlobalScopeShim & Record<string, unknown> {
    const scope = new DedicatedWorkerGlobalScopeShim() as WorkerGlobalScopeShim & Record<string | symbol, unknown>;
    const define = (key: string | symbol, value: unknown): void => {
      Object.defineProperty(scope, key, { value, configurable: true, writable: true, enumerable: false });
    };
    // A handler that throws is an `error` event on the worker's own scope, then on the Worker.
    scope.onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const own = new ErrorEvent('error', { message, error, cancelable: true });
      scope.dispatchEvent(own);
      if (!own.defaultPrevented) this.fail(error);
    };
    for (const key of PAGE_ONLY) define(key, undefined);
    define(Symbol.unscopables, UNSCOPABLE);
    define('self', scope);
    define('globalThis', scope);
    define('name', name);
    define('postMessage', (message: unknown, options?: unknown): void => {
      const { value, ports } = cloneMessage(message, transferOf(options));
      if (this.dead || this.closed) return;
      enqueue(() => {
        if (!this.dead) this.dispatchEvent(new MessageEventShim(value, ports));
      });
    });
    define('close', () => {
      this.closed = true;
    });
    define('location', new URL(this.url));
    define('importScripts', (...urls: string[]) => {
      for (const item of urls) {
        const { code, file } = sourceOfSync(resolveDocumentUrl(String(item)));
        runIn(scope, code, file ?? String(item));
      }
    });
    define('fetch', (input: RequestInfo | URL, init?: RequestInit) => ordered(() => (globalThis.fetch as typeof fetch)(input, init)));
    define('createImageBitmap', (...args: unknown[]) => ordered(() => (globalThis.createImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(...args)));
    define('navigator', { hardwareConcurrency: HARDWARE_CONCURRENCY, userAgent: 'Kinetograph', language: 'en-US', languages: ['en-US'], onLine: true, platform: '' });
    define('WorkerGlobalScope', WorkerGlobalScopeShim);
    define('DedicatedWorkerGlobalScope', DedicatedWorkerGlobalScopeShim);
    return scope;
  }
}

/** The workers started so far (for tests that want to know none was made). */
export function workersStarted(): number {
  return workerCount;
}

/** Drops every queued message (tests). */
export function resetWorkers(): void {
  queue.length = 0;
}
