import { Worker } from 'node:worker_threads';
import type { StudioError } from './protocol.js';
import type { WorkerInit, WorkerReply, WorkerRequest } from './engine.js';
import { builtFile, StudioFailure } from './util.js';

/** The worker script and the default engine, built next to this file (or in `dist/` under vitest). */
export const WORKER_FILE = builtFile('worker.js');
export const REAL_ENGINE_FILE = builtFile('real-engine.js');

type Distribute<T> = T extends { id: number } ? Omit<T, 'id'> : never;
export type Call = Distribute<WorkerRequest>;

interface Pending {
  op: WorkerRequest['op'];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** How long `close` lets the calls in flight, and then the engine's dispose, take before it stops the thread anyway. */
export const CLOSE_WAIT_MS = 5_000;
/** The wait for the calls in flight when one of them is a render, which can run for minutes. */
export const CLOSE_RENDER_WAIT_MS = 120_000;

/** True when `promise` settles within `ms`, false when the time runs out first. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  return Promise.race([promise.then(() => true), late]).finally(() => clearTimeout(timer));
}

/** The server's side of one worker thread: calls out, replies and progress back. */
export class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closing = false;
  private exited: Promise<void>;
  private failure: StudioError | null = null;
  /** Progress of a render call, by call id. */
  onProgress: ((done: number, total: number) => void) | undefined;

  constructor(init: WorkerInit) {
    this.worker = new Worker(WORKER_FILE, { workerData: init, name: `kinetograph-studio-${init.role}` });
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()));
    this.worker.on('message', (reply: WorkerReply) => this.receive(reply));
    this.worker.on('error', (error) => this.fail({ code: 'INTERNAL', message: `the ${init.role} worker crashed: ${error.stack ?? error.message}` }));
    this.worker.on('exit', (code) => this.fail({ code: 'INTERNAL', message: `the ${init.role} worker stopped (exit code ${code})` }));
  }

  /** Runs `call` in the worker. Rejects with an error that has the worker's `code`. */
  call<T>(call: Call): Promise<T> {
    if (this.failure) return Promise.reject(new StudioFailure(this.failure.code, this.failure.message));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { op: call.op, resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...call, id } as WorkerRequest);
    });
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Lets the calls in flight finish, has the engine dispose of what it holds on its own thread, then stops the thread.
   * A call that does not finish within `waitMs` (`CLOSE_RENDER_WAIT_MS` for a render), or a dispose that does not, is
   * failed and the thread stopped anyway.
   */
  close(waitMs = CLOSE_WAIT_MS): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    const rendering = [...this.pending.values()].some((p) => p.op === 'render');
    const drained = this.pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => (this.drained = resolve));
    void (async () => {
      if (await within(drained, rendering ? CLOSE_RENDER_WAIT_MS : waitMs)) {
        await within(this.call({ op: 'dispose' }).catch(() => undefined), waitMs);
      }
      await this.terminate();
    })();
    return this.exited;
  }

  private drained: (() => void) | null = null;

  /** Stops the thread now; calls in flight fail with `reason`. */
  async terminate(reason: StudioError = { code: 'INTERNAL', message: 'the worker was stopped' }): Promise<void> {
    this.closing = true;
    this.fail(reason);
    await this.worker.terminate();
    await this.exited;
  }

  private receive(reply: WorkerReply): void {
    if ('event' in reply) {
      this.onProgress?.(reply.done, reply.total);
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new StudioFailure(reply.error.code, reply.error.message));
    if (this.closing && this.pending.size === 0) this.drained?.();
  }

  private fail(error: StudioError): void {
    this.failure ??= error;
    for (const [, pending] of this.pending) pending.reject(new StudioFailure(error.code, error.message));
    this.pending.clear();
  }
}
