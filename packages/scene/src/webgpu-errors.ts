// What the recording WebGPU device (`webgpu.ts`) does with the errors its own checks throw. A browser's invalid call does not
// throw: it makes the object invalid and the error goes to the nearest error scope, or to `uncapturederror`. Here the call
// throws (the page learns at once, and a library that guards its calls in try/catch sees it), and before it reaches the page
// the device records it: the frame reports it as a warning (an error under `--strict`) even when the page swallows it, and an
// open error scope keeps it for `popErrorScope`. A call the engine does not draw (`WebGpuUnsupportedError`) is reported as a
// note instead, so it is not recorded here.

/** `GPUError`, which `popErrorScope` resolves with. */
export class GPUErrorShim {
  constructor(readonly message: string) {}
}

export class GPUValidationErrorShim extends GPUErrorShim {}

const FILTERS = new Set(['validation', 'out-of-memory', 'internal']);

/** The stack of `pushErrorScope` and the first error each scope caught. */
export class ErrorScopes {
  private readonly stack: { filter: string; error: GPUErrorShim | null }[] = [];
  push(filter: unknown): void {
    if (typeof filter !== 'string' || !FILTERS.has(filter)) throw new TypeError(`pushErrorScope: the filter ${String(filter)} is not validation, out-of-memory or internal`);
    this.stack.push({ filter, error: null });
  }
  /** The error a scope caught (none, if nothing went wrong in it): the call that popped it settles with it. */
  pop(): Promise<GPUErrorShim | null> {
    const scope = this.stack.pop();
    if (scope === undefined) return Promise.reject(new DOMException('popErrorScope: there is no error scope to pop', 'OperationError'));
    return Promise.resolve(scope.error);
  }
  /** An invalid call: the innermost scope that filters validation errors keeps the first one. False if no scope does. */
  capture(message: string): boolean {
    for (let n = this.stack.length - 1; n >= 0; n -= 1) {
      const scope = this.stack[n]!;
      if (scope.filter !== 'validation') continue;
      scope.error ??= new GPUValidationErrorShim(message);
      return true;
    }
    return false;
  }
}

/** The most distinct errors a device keeps for the frame to report. */
export const MAX_ERRORS = 32;

/**
 * What a call that a browser finds invalid gives back: an object that is invalid, which accepts any call and returns itself.
 * It is not a `GPUBuffer` or the like, so a page that goes on to hand it to another call gets that call's own error.
 */
const INVALID: object = new Proxy(function invalid() {}, {
  get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : INVALID),
  apply: () => INVALID,
});

/** Calls that are running: only the page's own call (the outermost) gives up its error inside an error scope. */
let running = 0;

/**
 * Wraps each method of `cls` so that an error it throws is handed to `invalid` of the device `deviceOf` finds before it is
 * thrown on, unless `skip` says it is reported another way. Inside an open validation error scope a browser does not throw
 * for an invalid call: the error goes to the scope and the call returns (an invalid object, for a call that makes one), so
 * the outermost call here does the same for a RangeError or an Error (OperationError, InvalidStateError). A TypeError
 * still throws: some are the type checks the browser's bindings throw, and the rest cannot be told from them.
 */
export function reporting<T extends object>(
  cls: { prototype: T },
  deviceOf: (self: any, args: unknown[]) => { invalid(error: unknown): boolean } | null | undefined,
  skip: (error: unknown) => boolean,
  only?: string[],
): void {
  const proto = cls.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const method = Object.getOwnPropertyDescriptor(proto, name)?.value as ((...args: unknown[]) => unknown) | undefined;
    if (name === 'constructor' || typeof method !== 'function' || (only !== undefined && !only.includes(name))) continue;
    proto[name] = function (this: unknown, ...args: unknown[]): unknown {
      running += 1;
      try {
        return method.apply(this, args);
      } catch (error) {
        const kept = skip(error) ? false : deviceOf(this, args)?.invalid(error);
        if (kept === true && running === 1 && !(error instanceof TypeError)) return INVALID;
        throw error;
      } finally {
        running -= 1;
      }
    };
  }
}
