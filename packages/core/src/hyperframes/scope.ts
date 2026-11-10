// A mounted composition's script sees its own composition (HyperFrames' documented behaviour): `document.querySelector`,
// `querySelectorAll` and `getElementById` find only elements inside the composition's root, GSAP's string targets
// (`gsap.to('.title', …)`, `tl.from('.title', …)`, `gsap.utils.toArray`) are looked up there too, and `var`s of the
// script stay in the script. Two compositions can both have a `.title` and a `const tl`.

import { Script } from 'node:vm';

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

/** `value` as the inside of a double-quoted CSS string. */
const cssString = (value: string): string => value.replace(/[\\"]/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);

const IDENT_CHAR = /[\w-]|[^\x00-\x7f]/;
const HEX = /[0-9a-fA-F]/;

/**
 * `selector` with each `#<rootId>` token as an attribute selector on the file's root (the child of the host that has the id). Quoted strings and `[...]` are copied
 * as written (an attribute value is not a lookup by id), and an id written with CSS escapes (`#a\.b`, `#\31 a`) is
 * compared unescaped. The DOM takes no escapes in an id selector, but takes them in an attribute value.
 */
export function rewriteRootId(selector: string, rootId: string): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i]!;
    if (ch === '\\') {
      out += selector.slice(i, i + 2);
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === '[') {
      // A string runs to its closing quote, a bracket to its `]` (a quote inside it is a string of its own).
      let quote = ch === '[' ? '' : ch;
      let j = i + 1;
      for (; j < selector.length; j++) {
        const c = selector[j]!;
        if (c === '\\') j++;
        else if (quote !== '') {
          if (c === quote) {
            quote = '';
            if (ch !== '[') break;
          }
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ']') break;
      }
      out += selector.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '#') {
      let j = i + 1;
      let name = '';
      while (j < selector.length) {
        const c = selector[j]!;
        if (c === '\\' && j + 1 < selector.length) {
          let k = j + 1;
          while (k < selector.length && k - j <= 6 && HEX.test(selector[k]!)) k++;
          if (k > j + 1) {
            const code = Number.parseInt(selector.slice(j + 1, k), 16);
            name += code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
            j = k + (/\s/.test(selector[k] ?? '') ? 1 : 0);
          } else {
            name += selector[j + 1]!;
            j += 2;
          }
        } else if (IDENT_CHAR.test(c)) {
          name += c;
          j++;
        } else break;
      }
      out += name === rootId ? `[data-hf-authored-id="${cssString(rootId)}"]` : selector.slice(i, j);
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** `document` limited to `root`. */
export function scopedDocument(env: ScopeEnv): AnyRecord {
  const inside = (node: AnyRecord): boolean => {
    const root = env.root();
    return root === null || node === root || root.contains(node);
  };
  // A mounted file's root element is a child of the host; the planner keeps the id the file gave it as `data-hf-authored-id`.
  const rootIdOf = (): string | null => {
    for (const child of Array.from((env.root()?.children ?? []) as ArrayLike<AnyRecord>)) {
      if (child.getAttribute('data-hf-inner-root') === 'true') return child.getAttribute('data-hf-authored-id');
    }
    return null;
  };
  const all = (selector: string): AnyRecord[] => {
    const rootId = rootIdOf();
    const text = rootId === null || typeof selector !== 'string' ? selector : rewriteRootId(selector, rootId);
    const found = Array.from(env.document.querySelectorAll(text) as ArrayLike<AnyRecord>);
    return env.root() === null ? found : found.filter(inside);
  };
  const byId = (id: string): AnyRecord | null => {
    // The DOM builds an id selector from `id`, which it rejects when `id` has a `.` or `:`; the attribute lookup below does not.
    let found: AnyRecord | null | undefined;
    try {
      found = env.document.getElementById(id);
    } catch {
      found = null;
    }
    if (found !== null && found !== undefined && inside(found)) return found;
    const root = env.root();
    if (root === null) return found ?? null;
    if (root.id === id) return root;
    return root.querySelector(`[id="${cssString(String(id))}"]`) ?? (rootIdOf() === id ? root.querySelector(`[data-hf-authored-id="${cssString(String(id))}"]`) : null);
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
                    ? Array.from(document.querySelectorAll(selector) as ArrayLike<AnyRecord>).filter((n) => n === origin || origin.contains(n))
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

/**
 * Runs a page script as a classic script: in the global scope, where its `var`s and functions become globals and its
 * top-level `const`, `let` and `class` go to the realm's global lexical scope, which every later script sees (a browser
 * shares them between classic scripts the same way; `eval` would keep them to the one script).
 */
export function runGlobalScript(code: string, file: string, report: (message: string) => void): void {
  try {
    new Script(code, { filename: file }).runInThisContext();
  } catch (error) {
    const message = `${file}: script failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!warned.has(message)) {
      warned.add(message);
      report(message);
    }
  }
}
