// staticFile and the delayRender family (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §7.1).
//
// A frame is not final while a `delayRender()` handle is open: the frame loop
// waits for every handle to be continued, and fails if one stays open too long
// (30 s by default) or if `cancelRender()` is called. That timeout is measured
// in real time on purpose: it is the only place a render may look at a real
// clock, and only to give up, never to decide what a frame looks like.

import { isAbsolute, join, resolve } from 'node:path';
import { realTimers } from './determinism.js';

// ---- staticFile ----

let publicDir: string | null = null;

/**
 * Where `staticFile` looks. `setPublicDir` wins; then the `KINETOGRAPH_PUBLIC_DIR` environment variable, which a host
 * sets before it imports the project so that a `staticFile()` call made while the project loads (a font, a module-level
 * constant) already sees the right folder; then `<cwd>/public`.
 */
export function setPublicDir(dir: string): void {
  publicDir = resolve(dir);
}

export function getPublicDir(): string {
  if (publicDir !== null) return publicDir;
  const fromEnvironment = process.env.KINETOGRAPH_PUBLIC_DIR;
  return fromEnvironment ? resolve(fromEnvironment) : resolve('public');
}

/** The absolute path of `name` in the public directory. */
export function staticFile(name: string): string {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`staticFile() takes the name of a file in the public folder, but got ${JSON.stringify(name)}`);
  }
  if (/^https?:\/\//i.test(name)) {
    throw new TypeError(`staticFile() is for files in the public folder, not URLs: use "${name}" directly`);
  }
  const relative = name.replace(/^[/\\]+/, '');
  const target = isAbsolute(relative) ? relative : join(getPublicDir(), relative);
  return target.replaceAll('\\', '/');
}

// ---- delayRender ----

const DEFAULT_TIMEOUT_MS = 30_000;

/** The CLI's `--timeout`, handed to the project (and its render workers) as the default for `delayRender`. */
const TIMEOUT_ENV = 'KINETOGRAPH_DELAY_RENDER_TIMEOUT';

/** The `code` of the error a handle that is never cleared fails the frame with (the CLI reports it in `--json`). */
export const DELAY_RENDER_TIMEOUT = 'DELAY_RENDER_TIMEOUT';

function defaultTimeout(): number {
  const fromEnvironment = Number(process.env[TIMEOUT_ENV]);
  return Number.isFinite(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : DEFAULT_TIMEOUT_MS;
}

interface Handle {
  label: string;
  timer: ReturnType<typeof realTimers.setTimeout>;
}

let nextHandle = 1;
const open = new Map<number, Handle>();
let failure: Error | null = null;
const waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

function openLabels(): string[] {
  return [...open.values()].map((handle) => handle.label);
}

/**
 * A handle's timer holds the process only while something waits for the handle. Unreferenced, a wait that nothing
 * else keeps alive let Node exit (code 13, "unsettled top-level await") before the timeout could fire; referenced
 * with nobody waiting, a handle a project leaves open would keep a finished process from exiting.
 */
function holdProcessWhileWaiting(): void {
  for (const handle of open.values()) {
    const timer = handle.timer as { ref?: () => void; unref?: () => void };
    if (waiters.size > 0) timer.ref?.();
    else timer.unref?.();
  }
}

function fail(error: Error): void {
  failure ??= error;
  for (const waiter of [...waiters]) waiter.reject(failure);
  waiters.clear();
  holdProcessWhileWaiting();
}

function settleIfIdle(): void {
  if (open.size > 0) return;
  for (const waiter of [...waiters]) waiter.resolve();
  waiters.clear();
}

export interface DelayRenderOptions {
  /** Real milliseconds to wait for `continueRender` before the frame fails. Default 30000, or the CLI's `--timeout`. */
  timeoutInMilliseconds?: number;
}

/** Holds the frame until `continueRender(handle)`. The handle is a number. */
export function delayRender(label?: string, options: DelayRenderOptions = {}): number {
  const handle = nextHandle++;
  const text = label ?? `handle ${handle}`;
  const timeout = options.timeoutInMilliseconds ?? defaultTimeout();
  const timer = realTimers.setTimeout(() => {
    fail(
      Object.assign(
        new Error(
          `A delayRender() "${text}" was called but not cleared after ${timeout}ms. Still open: ${openLabels()
            .map((l) => `"${l}"`)
            .join(', ')}. Call continueRender() when the data is ready, or cancelRender() on failure; ` +
            'a longer wait takes --timeout (the CLI) or delayRender(label, { timeoutInMilliseconds }).',
        ),
        { code: DELAY_RENDER_TIMEOUT },
      ),
    );
  }, timeout);
  open.set(handle, { label: text, timer });
  holdProcessWhileWaiting();
  return handle;
}

/** Releases a handle from `delayRender`. An unknown or already released handle does nothing. */
export function continueRender(handle: number): void {
  const entry = open.get(handle);
  if (!entry) return;
  realTimers.clearTimeout(entry.timer);
  open.delete(handle);
  settleIfIdle();
}

/**
 * Fails the frame being rendered. It records the error rather than throwing so
 * that calling it from a promise callback cannot become an unhandled rejection;
 * the frame loop rejects with it.
 */
export function cancelRender(error: unknown): void {
  fail(error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error)));
}

const delayRenderHook = { delayRender, continueRender, cancelRender };

/** `delayRender`, `continueRender` and `cancelRender` as Remotion's hook returns them, for a component that holds its own frame. */
export function useDelayRender(): typeof delayRenderHook {
  return delayRenderHook;
}

/** Handles currently open (for the frame loop and tests). */
export function openRenderHandles(): number {
  return open.size;
}

/** The recorded failure (a timeout or `cancelRender`), if any. */
export function renderFailure(): Error | null {
  return failure;
}

/**
 * Rejects whoever waits for the handles now (`whenRenderIdle`) with `error`, without recording a failure: the frame that
 * was waiting fails, a later one is not affected.
 */
export function rejectRenderWaits(error: Error): void {
  for (const waiter of [...waiters]) waiter.reject(error);
  waiters.clear();
}

/** Resolves once no handle is open; rejects with the failure if one is recorded or arrives while waiting. */
export function whenRenderIdle(): Promise<void> {
  if (failure) return Promise.reject(failure);
  if (open.size === 0) return Promise.resolve();
  return new Promise<void>((resolveWait, rejectWait) => {
    waiters.add({ resolve: resolveWait, reject: rejectWait });
    holdProcessWhileWaiting();
  });
}

/** Closes every handle and forgets any failure (a new renderer starts clean; tests). */
export function resetRenderState(): void {
  for (const handle of open.values()) realTimers.clearTimeout(handle.timer);
  open.clear();
  failure = null;
  waiters.clear();
}
