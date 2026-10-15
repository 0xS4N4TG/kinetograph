// The addon functions DOM islands need (docs/ENGINE.md §2), handed over by the host or found when first needed (a
// project with no DOM elements does not need the addon). A bundle in a project's cache may sit where `require` cannot
// reach `@kinetograph/native`; the CLI then calls `setDomAddon(native)` itself.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface DomAddon {
  /** `IslandRequest` JSON in, `IslandOutput` JSON out. */
  renderDomIsland(requestJson: string): string;
  /** `IslandRequest` JSON in, `{ [path]: { x, y, width, height, rect, client, scroll } }` JSON out. */
  domLayoutBoxes(requestJson: string): string;
  /** `IslandRequest` JSON, an element path and CSS property names in; the computed value of each, "" when unknown. */
  domComputedStyle(requestJson: string, path: string, properties: string[]): string[];
  /** The text engine, for the size of native text in an island. */
  layoutText?(request: unknown): { width: number; height: number };
}

let override: Partial<DomAddon> | null = null;
let loaded: Partial<DomAddon> | null = null;

/** Hands over the addon (the host does; tests pass a stub, `null` goes back to loading it). */
export function setDomAddon(addon: Partial<DomAddon> | null): void {
  override = addon;
}

function load(): Partial<DomAddon> {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return createRequire(base)('@kinetograph/native') as Partial<DomAddon>;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `DOM elements cannot be drawn: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass it to setDomAddon() from @kinetograph/compat/dom.',
  );
}

/** The addon function `name`, or an error that says what is missing. */
export function addonFunction<K extends keyof DomAddon>(name: K): NonNullable<DomAddon[K]> {
  const addon = override ?? (loaded ??= load());
  const fn = addon[name];
  if (typeof fn !== 'function') {
    throw new Error(`The addon has no ${name}(): rebuild @kinetograph/native (npm run build:release -w crates/node)`);
  }
  // Called as a method of the addon object, as napi functions expect.
  return ((...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(addon, args)) as NonNullable<DomAddon[K]>;
}

/** Whether the addon has `name` (a stand-in or an older build may not). */
export function hasAddonFunction(name: keyof DomAddon): boolean {
  try {
    const addon = override ?? (loaded ??= load());
    return typeof addon[name] === 'function';
  } catch {
    return false;
  }
}
