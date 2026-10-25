// A mounted composition's script sees its own composition (HyperFrames' documented behaviour): `document.querySelector`,
// `querySelectorAll` and `getElementById` find only elements inside the composition's root, GSAP's string targets
// (`gsap.to('.title', …)`, `tl.from('.title', …)`, `gsap.utils.toArray`) are looked up there too, and `var`s of the
// script stay in the script. Two compositions can both have a `.title` and a `const tl`.

type AnyRecord = Record<string, any>;

export interface ScopeEnv {
  document: AnyRecord;
  window: AnyRecord;
  /** `window.gsap` when a script has loaded it. */
  gsap: () => AnyRecord | undefined;
  /** The composition's root element, looked up lazily (the script may run before its host is found). */
  root: () => AnyRecord | null;
  hyperframes: AnyRecord;
}

const bound = (target: AnyRecord, value: unknown): unknown => (typeof value === 'function' ? value.bind(target) : value);

/** `document` limited to `root`. */
export function scopedDocument(env: ScopeEnv): AnyRecord {
  const inside = (node: AnyRecord): boolean => {
    const root = env.root();
    return root === null || node === root || root.contains(node);
  };
  const all = (selector: string): AnyRecord[] => {
    const found = Array.from(env.document.querySelectorAll(selector) as ArrayLike<AnyRecord>);
    return env.root() === null ? found : found.filter(inside);
  };
  const byId = (id: string): AnyRecord | null => {
    const found = env.document.getElementById(id);
    if (found !== null && found !== undefined && inside(found)) return found;
    const root = env.root();
    if (root === null) return found ?? null;
    if (root.id === id) return root;
    return root.querySelector(`[id="${String(id).replace(/"/g, '\\"')}"]`) ?? null;
  };
  return new Proxy(env.document, {
    get(target, prop) {
      if (prop === 'querySelector') return (selector: string) => all(selector)[0] ?? null;
      if (prop === 'querySelectorAll') return all;
      if (prop === 'getElementById') return byId;
      return bound(target, Reflect.get(target, prop, target));
    },
  });
}

/** `window` with `__hyperframes` the composition's own (its `getVariables()`). */
export function scopedWindow(env: ScopeEnv): AnyRecord {
  return new Proxy(env.window, {
    get(target, prop) {
      if (prop === '__hyperframes') return env.hyperframes;
      const value = Reflect.get(target, prop, target);
      // Classes keep their statics: only plain functions are bound.
      return typeof value === 'function' && value.prototype === undefined ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

/** `gsap` whose string targets are looked up inside the composition. */
export function scopedGsap(env: ScopeEnv): AnyRecord | undefined {
  const base = env.gsap();
  if (base === undefined || typeof Proxy !== 'function') return base;
  const document = scopedDocument(env);
  const resolve = (target: unknown): unknown => {
    if (typeof target === 'string') return Array.from(document.querySelectorAll(target) as ArrayLike<unknown>);
    if (Array.isArray(target)) {
      return target.flatMap((item) => (typeof item === 'string' ? Array.from(document.querySelectorAll(item) as ArrayLike<unknown>) : [item]));
    }
    return target;
  };
  // A selector that matches nothing is still a target (GSAP warns with its text); an empty array is none.
  const withTargets = (owner: AnyRecord, method: AnyRecord[string]): ((...args: unknown[]) => unknown) =>
    (first: unknown, ...rest: unknown[]) => method.call(owner, resolve(first), ...rest);
  const scopeTimeline = (timeline: AnyRecord): AnyRecord => {
    for (const name of ['to', 'from', 'fromTo', 'set']) {
      const original = timeline[name];
      if (typeof original === 'function') timeline[name] = withTargets(timeline, original);
    }
    return timeline;
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'timeline') return (...args: unknown[]) => scopeTimeline(target.timeline(...args));
      if (prop === 'to' || prop === 'from' || prop === 'fromTo' || prop === 'set') return withTargets(target, target[prop]);
      if (prop === 'utils' && target.utils) {
        return new Proxy(target.utils, {
          get(utils, name) {
            if (name === 'toArray') return withTargets(utils, utils.toArray);
            if (name === 'selector') {
              return (scope: unknown) => {
                const origin = (typeof scope === 'string' ? document.querySelector(scope) : scope) ?? env.root();
                return (selector: string) =>
                  typeof selector === 'string' && origin
                    ? Array.from(env.document.querySelectorAll(selector) as ArrayLike<AnyRecord>).filter((n) => n === origin || origin.contains(n))
                    : [];
              };
            }
            return bound(utils, Reflect.get(utils, name, utils));
          },
        });
      }
      return bound(target, Reflect.get(target, prop, target));
    },
  });
}

const warned = new Set<string>();

/** Runs a composition's script with its own `document`, `gsap`, `window` and `__hyperframes`; a failure is a warning, not the end. */
export function runScopedScript(code: string, file: string, env: ScopeEnv, report: (message: string) => void): void {
  try {
    const run = new Function('document', 'gsap', 'window', '__hyperframes', code);
    run.call(env.window, scopedDocument(env), scopedGsap(env), scopedWindow(env), env.hyperframes);
  } catch (error) {
    const message = `${file}: script failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!warned.has(message)) {
      warned.add(message);
      report(message);
    }
  }
}

/** Runs a page script in the global scope (its `var`s and functions are globals, its `const`s are its own). */
export function runGlobalScript(code: string, file: string, report: (message: string) => void): void {
  try {
    (0, eval)(`${code}\n//# sourceURL=${file.replace(/\s/g, '%20')}`);
  } catch (error) {
    const message = `${file}: script failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!warned.has(message)) {
      warned.add(message);
      report(message);
    }
  }
}
