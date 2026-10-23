// The determinism shim (packages/cli/skills/kinetograph/references/AUTHORING.md §7.4). Rendering is a pure function
// of (project, frame), so everything in a project that looks at time or luck
// has to be driven by the frame being rendered:
//
//  - `Date.now()`, `new Date()` and `performance.now()` return a virtual time
//    (2026-01-01T00:00:00Z plus frame / fps seconds);
//  - `Math.random()` is a seeded generator, reseeded from the frame number;
//  - `setTimeout`, `setInterval` and `requestAnimationFrame` run on the virtual
//    clock: their callbacks fire, in due order, when `setVirtualFrame` moves the
//    clock past their time.
//
// Nothing else is patched (`setImmediate`, promises and I/O stay real). The
// real timer functions are kept here for the shim's own use: the delayRender
// timeout needs real time to fail, and nothing else may.

/**
 * The real functions, captured when this module is first evaluated (before `installDeterminism`). Bound to the global
 * object: a browser's timers throw "Illegal invocation" when called as methods of another object.
 */
const originalTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
export const realTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setImmediate: globalThis.setImmediate?.bind(globalThis),
};

const RealDate = globalThis.Date;
const realCrypto = (globalThis as { crypto?: { getRandomValues?: unknown; randomUUID?: unknown } }).crypto;
const realGetRandomValues = realCrypto?.getRandomValues;
const realRandomUUID = realCrypto?.randomUUID;
const realMathRandom = Math.random;
const realRequestAnimationFrame = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
const realCancelAnimationFrame = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;

/** The virtual epoch: frame 0 is this instant. */
export const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1);

/** `Math.random()` before the first frame. */
const INITIAL_SEED = 0x4b494e45;

/** More firings than this in one advance means a timer that re-arms itself with no delay. */
const MAX_FIRINGS_PER_ADVANCE = 100_000;

let installed = false;
let virtualMs = 0;
let currentFps = 30;
let randomState = INITIAL_SEED;

interface Timer {
  id: number;
  due: number;
  seq: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  /** Milliseconds between firings, for `setInterval`. */
  interval: number | null;
  handle: VirtualTimeout;
}

let nextTimerId = 1;
let nextSeq = 0;
const timers = new Map<number, Timer>();

interface AnimationCallback {
  id: number;
  callback: (time: number) => void;
}
let nextAnimationId = 1;
let animationQueue: AnimationCallback[] = [];

/** What `setTimeout` returns: a Node-shaped handle that also coerces to its numeric id. */
class VirtualTimeout {
  constructor(readonly id: number) {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  refresh(): this {
    const timer = timers.get(this.id);
    if (timer) {
      timer.due = virtualMs + Math.max(1, timer.interval ?? 1);
      timer.seq = nextSeq++;
    }
    return this;
  }
  close(): this {
    timers.delete(this.id);
    return this;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

function idOf(handle: unknown): number | null {
  if (handle instanceof VirtualTimeout) return handle.id;
  if (typeof handle === 'number') return handle;
  if (typeof handle === 'string' && handle !== '' && !Number.isNaN(Number(handle))) return Number(handle);
  return null;
}

function normaliseDelay(delay: unknown): number {
  const value = Number(delay);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function addTimer(callback: unknown, delay: unknown, args: unknown[], repeat: boolean): VirtualTimeout {
  if (typeof callback !== 'function') {
    throw new TypeError(`The "callback" argument must be of type function. Received ${typeof callback}`);
  }
  const id = nextTimerId++;
  const ms = normaliseDelay(delay);
  const handle = new VirtualTimeout(id);
  timers.set(id, {
    id,
    due: virtualMs + ms,
    seq: nextSeq++,
    callback: callback as Timer['callback'],
    args,
    interval: repeat ? ms : null,
    handle,
  });
  return handle;
}

function virtualSetTimeout(callback: unknown, delay?: unknown, ...args: unknown[]): VirtualTimeout {
  return addTimer(callback, delay, args, false);
}
function virtualSetInterval(callback: unknown, delay?: unknown, ...args: unknown[]): VirtualTimeout {
  return addTimer(callback, delay, args, true);
}
function virtualClear(handle: unknown): void {
  const id = idOf(handle);
  if (id !== null) timers.delete(id);
}

function virtualRequestAnimationFrame(callback: (time: number) => void): number {
  if (typeof callback !== 'function') {
    throw new TypeError('requestAnimationFrame: the callback must be a function');
  }
  const id = nextAnimationId++;
  animationQueue.push({ id, callback });
  return id;
}
function virtualCancelAnimationFrame(id: number): void {
  animationQueue = animationQueue.filter((entry) => entry.id !== id);
}

// ---- the virtual clock ----

function dateNow(): number {
  return VIRTUAL_EPOCH_MS + Math.floor(virtualMs + 1e-6);
}

function nextDueTimer(limit: number): Timer | null {
  let best: Timer | null = null;
  for (const timer of timers.values()) {
    if (timer.due > limit) continue;
    if (best === null || timer.due < best.due || (timer.due === best.due && timer.seq < best.seq)) best = timer;
  }
  return best;
}

function fireTimersUpTo(target: number): void {
  let firings = 0;
  for (;;) {
    const timer = nextDueTimer(target);
    if (timer === null) break;
    if (++firings > MAX_FIRINGS_PER_ADVANCE) {
      throw new Error(
        'A timer fired more than 100000 times within one frame: a setInterval or chained setTimeout with a tiny delay never lets the virtual clock move on.',
      );
    }
    // Inside the callback the clock reads the timer's own due time, so a timer it sets is relative to that.
    virtualMs = Math.max(virtualMs, timer.due);
    if (timer.interval === null) timers.delete(timer.id);
    else {
      timer.due += timer.interval;
      timer.seq = nextSeq++;
    }
    timer.callback(...timer.args);
  }
}

export interface VirtualFrameOptions {
  /** Seed `Math.random()` from this frame instead of from `frame`. A motion-blur sub-frame keeps its frame's randomness. */
  seedFrame?: number;
  /** Default true. False moves the clock without running timers or animation frames (sub-frames, restoring). */
  fireTimers?: boolean;
}

function seedFor(frame: number): number {
  return (Math.imul(Math.floor(frame) | 0, 0x9e3779b1) ^ INITIAL_SEED) >>> 0;
}

/**
 * Moves the virtual clock to `frame` at `fps`: reseeds `Math.random()`, fires
 * the timers that came due (in due order), then runs the animation-frame
 * callbacks queued before this call, once, with the virtual `performance.now()`.
 */
export function setVirtualFrame(frame: number, fps: number, options: VirtualFrameOptions = {}): void {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError(`setVirtualFrame needs a finite frame and a positive fps, got ${frame} and ${fps}`);
  }
  currentFps = fps;
  randomState = seedFor(options.seedFrame ?? frame);
  const target = (frame / fps) * 1000;
  if (options.fireTimers === false) {
    virtualMs = target;
    return;
  }
  fireTimersUpTo(target);
  virtualMs = target;
  const due = animationQueue;
  animationQueue = [];
  for (const entry of due) entry.callback(virtualMs);
}

/** Back to frame 0 with no timers or animation frames pending, as before the first frame. */
export function resetVirtualClock(): void {
  virtualMs = 0;
  currentFps = 30;
  randomState = INITIAL_SEED;
  timers.clear();
  animationQueue = [];
}

/** The virtual time in milliseconds since frame 0 (what `performance.now()` returns once installed). */
export function virtualNow(): number {
  return virtualMs;
}

/** The frames per second of the last `setVirtualFrame`. */
export function virtualFps(): number {
  return currentFps;
}

function virtualRandom(): number {
  // Mulberry32: tiny, fast, and the same on every platform.
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The bytes `crypto.getRandomValues` fills, from the seeded generator, so a frame does not depend on the machine. */
function virtualGetRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (array === null) return array;
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(virtualRandom() * 256);
  return array;
}

function virtualRandomUUID(): string {
  const bytes = virtualGetRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const VirtualDate: DateConstructor = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) return new target(dateNow());
    return Reflect.construct(target, args, newTarget === VirtualDate ? target : newTarget);
  },
  apply() {
    return new RealDate(dateNow()).toString();
  },
  get(target, property, receiver) {
    if (property === 'now') return dateNow;
    return Reflect.get(target, property, receiver);
  },
});

/** Patches the globals listed at the top of this file. Calling it again does nothing. */
export function installDeterminism(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as Record<string, unknown>;
  g.Date = VirtualDate;
  Math.random = virtualRandom;
  if (globalThis.performance) globalThis.performance.now = () => virtualMs;
  if (realCrypto) {
    const patch = realCrypto as { getRandomValues: unknown; randomUUID: unknown };
    patch.getRandomValues = virtualGetRandomValues;
    patch.randomUUID = virtualRandomUUID;
  }
  g.setTimeout = virtualSetTimeout;
  g.setInterval = virtualSetInterval;
  g.clearTimeout = virtualClear;
  g.clearInterval = virtualClear;
  g.requestAnimationFrame = virtualRequestAnimationFrame;
  g.cancelAnimationFrame = virtualCancelAnimationFrame;
}

export function isDeterminismInstalled(): boolean {
  return installed;
}

/** Puts the real globals back (for tests; a render never calls this). */
export function uninstallDeterminism(): void {
  if (!installed) return;
  installed = false;
  const g = globalThis as Record<string, unknown>;
  g.Date = RealDate;
  Math.random = realMathRandom;
  // `now` was an own property of the instance; dropping it exposes the prototype's real one again.
  if (globalThis.performance) delete (globalThis.performance as { now?: unknown }).now;
  if (realCrypto) {
    const patch = realCrypto as { getRandomValues: unknown; randomUUID: unknown };
    patch.getRandomValues = realGetRandomValues;
    if (realRandomUUID !== undefined) patch.randomUUID = realRandomUUID;
  }
  g.setTimeout = originalTimers.setTimeout;
  g.setInterval = originalTimers.setInterval;
  g.clearTimeout = originalTimers.clearTimeout;
  g.clearInterval = originalTimers.clearInterval;
  if (realRequestAnimationFrame === undefined) delete g.requestAnimationFrame;
  else g.requestAnimationFrame = realRequestAnimationFrame;
  if (realCancelAnimationFrame === undefined) delete g.cancelAnimationFrame;
  else g.cancelAnimationFrame = realCancelAnimationFrame;
  resetVirtualClock();
}
