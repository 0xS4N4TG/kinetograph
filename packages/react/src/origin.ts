// Where a host element came from, for the studio: the user component that drew it and the JSX line that wrote it.
//
// The studio bundles the project with esbuild's dev JSX transform and a `jsxDEV` that records each element's source
// location in a WeakMap keyed by its props object (`bundle.ts`, `JSX_DEV_SHIM`). React 19 no longer keeps `_debugSource`,
// so this is the only place the location survives. Here the reconciler reads it back for a new host instance, walking the
// fiber's `_debugOwner` chain (dev builds of React only). Nothing exists in a render's bundle, so a render is unchanged.

import type { SourceLocation } from '@kinetographdev/scene';

/** The key of the global WeakMap `jsxDEV` fills; shared with the shim, which lives in the project's bundle. */
export const JSX_SOURCES_KEY = Symbol.for('kinetograph.jsxSources');

/** What esbuild's dev transform passes as `__source`. */
interface RawSource {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

/** Whether the project was bundled for the studio (the `jsxDEV` shim ran): the only builds that carry names. */
export const studioBuild = (): boolean => sourcesMap() !== undefined;

/** What the reconciler learned of a host element as it was created. */
export interface Origin {
  /** The nearest user component that rendered the JSX that made this element. */
  component?: string;
  /** That JSX: `file` is as esbuild reported it (relative to the project's directory, or absolute). */
  source?: SourceLocation;
  /** `<Sequence>` only: the first user component inside it (its name for people, when it has no `name`). */
  child?: string;
}

interface Fiber {
  tag: number;
  type: unknown;
  memoizedProps: object | null;
  pendingProps: object | null;
  key: string | null;
  _debugOwner?: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

const FUNCTION = 0;
const CLASS = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO = 15;

const sourcesMap = (): WeakMap<object, RawSource> | undefined =>
  (globalThis as unknown as Record<symbol, WeakMap<object, RawSource> | undefined>)[JSX_SOURCES_KEY];

function nameOf(type: unknown): string | undefined {
  if (typeof type === 'function') return (type as { displayName?: string }).displayName || type.name || undefined;
  if (type !== null && typeof type === 'object') {
    const t = type as { displayName?: string; render?: unknown; type?: unknown };
    return t.displayName || nameOf(t.render) || nameOf(t.type);
  }
  return undefined;
}

const rawOf = (map: WeakMap<object, RawSource>, fiber: Fiber): RawSource | undefined =>
  (fiber.memoizedProps ? map.get(fiber.memoizedProps) : undefined) ?? (fiber.pendingProps ? map.get(fiber.pendingProps) : undefined);

/** A component fiber that drew JSX written in the project: one whose own child was made by user JSX. */
function isUserComponent(map: WeakMap<object, RawSource>, fiber: Fiber): boolean {
  if (fiber.tag !== FUNCTION && fiber.tag !== CLASS && fiber.tag !== FORWARD_REF && fiber.tag !== SIMPLE_MEMO) return false;
  return fiber.child !== null && rawOf(map, fiber.child) !== undefined;
}

/** Components whose name says nothing about what is inside them. */
const GENERIC = new Set(['AbsoluteFill', 'Fragment', 'Layer', 'Scoped']);

/**
 * The name of the first component below `fiber` that the project's JSX wrote and that itself drew project JSX (a user
 * component); failing that, the first named component the project's JSX wrote at all (`<Audio>`), by `fallback`.
 */
function firstUserChild(map: WeakMap<object, RawSource>, fiber: Fiber): { name: string; user: boolean } | undefined {
  let budget = 400;
  let sourced: string | undefined;
  const visit = (f: Fiber | null): string | undefined => {
    for (let c = f; c !== null && budget-- > 0; c = c.sibling) {
      if (rawOf(map, c) !== undefined) {
        const name = nameOf(c.type);
        if (name !== undefined) {
          if (isUserComponent(map, c)) return name;
          if (sourced === undefined && !GENERIC.has(name) && typeof c.type !== 'string') sourced = name;
        }
      }
      const inner = visit(c.child);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const user = visit(fiber.child);
  if (user !== undefined) return { name: user, user: true };
  return sourced !== undefined ? { name: sourced, user: false } : undefined;
}

/**
 * The origin of a host element: `props` is what the reconciler was given, `fiber` its internal instance handle. Returns
 * undefined outside the studio (no `jsxDEV` shim ran) or when React is a production build.
 */
export function originOf(type: string, props: object, fiber: unknown): Origin | undefined {
  const map = sourcesMap();
  if (map === undefined || fiber === null || typeof fiber !== 'object') return undefined;
  const host = fiber as Fiber;
  let raw = map.get(props);
  // The element has no JSX of its own when a library component drew it (`<AbsoluteFill>` draws a layer): the JSX that
  // matters is the nearest owner's, the one the project wrote.
  let anchor: Fiber | null = host;
  if (raw === undefined) {
    anchor = null;
    for (let f = host._debugOwner ?? null; f !== null; f = f._debugOwner ?? null) {
      raw = rawOf(map, f);
      if (raw !== undefined) {
        anchor = f;
        break;
      }
    }
  }
  const origin: Origin = {};
  if (raw !== undefined) origin.source = { file: raw.fileName, line: raw.lineNumber, column: raw.columnNumber };
  // The JSX was written inside a component's render: that component is its owner.
  for (let f = anchor?._debugOwner ?? null; f !== null && origin.component === undefined; f = f._debugOwner ?? null) {
    origin.component = nameOf(f.type);
  }
  if (type === 'kg-sequence') {
    const child = firstUserChild(map, host);
    // Sequences made in a loop are told apart by their key: `Audio · 01-intro`.
    const key = anchor?.key;
    if (child !== undefined) origin.child = child.user || typeof key !== 'string' || key === '' ? child.name : `${child.name} · ${key}`;
  }
  return origin.source === undefined && origin.component === undefined && origin.child === undefined ? undefined : origin;
}
