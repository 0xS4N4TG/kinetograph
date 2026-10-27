// `import()` of a specifier built at run time (`import(`./locale/${lang}.js`)`): esbuild cannot find it, so `modules.ts`
// hands each such call to the host with the importing module's URL. Here the host resolves it through the page's import
// map, builds the module from the cache (the whole graph under it, bundled by esbuild), and answers with its namespace.
//
//   - The pre-download step runs the page's first frames in discovery mode: the specifiers the page asks for are downloaded
//     and locked, so a render finds them in the cache.
//   - A specifier first seen during a render is downloaded once, locked and noted, as a remote picture is.
//   - With `--offline` nothing is downloaded: an uncached module is an error naming the specifier.

import { Script } from 'node:vm';
import { noteStylesheetProblem } from '@kinetographdev/compat/dom';
import { trackPending } from '@kinetographdev/compat/shim';
import { lockPathOf } from '@kinetographdev/core/lock';
import { activeLockFile, MAX_DATA_BYTES, useLockFile, type FetchedDep, type FetchOptions } from './deps.js';
import { bundleDynamicImport, DYNAMIC_IMPORT, type ImportMap } from './modules.js';

/** What the project's bundle leaves for the host: the page's import map and where the project is. */
export const DYNAMIC_CONFIG = Symbol.for('kinetograph.hf.dynamic');
export interface DynamicConfig {
  importMap: ImportMap;
  root: string;
  entry: string;
}

/** Set while the pre-download step runs the page: downloads are allowed, and what happens is kept in `discovered`. */
let discovery: FetchOptions | null = null;
export const discovered: { fetched: FetchedDep[]; failed: { specifier: string; referrer: string; error: string; code?: string }[] } = { fetched: [], failed: [] };

export function setDiscovery(options: FetchOptions | null): void {
  discovery = options;
  if (options !== null) {
    discovered.fetched = [];
    discovered.failed = [];
  }
}

let slots = 0;

const loaded = new Map<string, Promise<unknown>>();

async function load(referrer: string, specifier: string): Promise<unknown> {
  const config = (globalThis as Record<symbol, unknown>)[DYNAMIC_CONFIG] as DynamicConfig | undefined;
  if (config === undefined) throw new Error(`import(${JSON.stringify(specifier)}) from ${referrer}: the project's import map is not loaded`);
  // A render worker never built the plan: the lock the downloads are checked against and recorded in is the project's.
  if (activeLockFile() === null) useLockFile(lockPathOf(config.entry));
  const offline = process.env.KINETOGRAPH_OFFLINE === '1';
  const fetch: FetchOptions | null = discovery ?? (offline ? null : { maxBytes: MAX_DATA_BYTES });
  const name = `import(${JSON.stringify(specifier)}) from ${referrer}`;
  const slot = Symbol.for(`kinetograph.import.slot.${slots++}`);
  let built;
  try {
    built = await bundleDynamicImport(specifier, slot, referrer, config.root, config.importMap, fetch);
  } catch (error) {
    const e = error as Error & { missing?: string[]; code?: string };
    const hint =
      fetch === null && (e.missing?.length ?? 0) > 0
        ? `\n--offline is set, so ${e.missing!.join(', ')} is not downloaded: run without --offline once, or \`kinetograph fetch-deps\``
        : '';
    const code = e.code ?? (/kinetograph\.lock\.json/.test(e.message) ? 'LOCK_MISMATCH' : undefined);
    discovered.failed.push({ specifier, referrer, error: e.message, ...(code ? { code } : {}) });
    throw new Error(`${name} failed: ${e.message}${hint}`);
  }
  discovered.fetched.push(...built.fetched);
  if (discovery === null && built.fetched.some((f) => f.status === 'fetched')) {
    noteStylesheetProblem(`${name} was first requested during the render (the pre-download pass did not reach it): downloaded now and added to the lock`);
  }
  try {
    await (new Script(built.code, { filename: name }).runInThisContext() as Promise<void>);
    return (globalThis as Record<symbol, unknown>)[slot];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    discovered.failed.push({ specifier, referrer, error: message });
    throw error;
  } finally {
    delete (globalThis as Record<symbol, unknown>)[slot];
  }
}

/** Makes `import()` of a computed specifier in the page's module scripts answer from here. */
export function installDynamicImport(): void {
  (globalThis as Record<symbol, unknown>)[DYNAMIC_IMPORT] = (referrer: string, specifier: unknown): Promise<unknown> => {
    const text = String(specifier);
    const key = `${referrer}\n${text}`;
    let promise = loaded.get(key);
    if (promise === undefined) {
      promise = load(referrer, text);
      loaded.set(key, promise);
      // The page sees the rejection; the next frame must not report it as unhandled here too.
      promise.catch(() => {});
    }
    return trackPending(promise);
  };
}

/** Forgets the modules already answered (tests; a studio rebuild). */
export function resetDynamicImports(): void {
  loaded.clear();
}
