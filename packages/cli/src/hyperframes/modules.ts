// ES module scripts and import maps of a HyperFrames page. A browser loads `<script type="module">` and its imports from
// the web; a render does not. Here the pre-download step (`prefetch.ts`) walks each module's import graph (bare names
// through the page's import map, URLs, relative paths, `export * from`, dynamic `import("…")` of a string) and stores
// every remote module in the cache, pinned in the lock file. A render then bundles each module script with esbuild, the
// graph resolved through the same map from the cache alone, into a classic script that the runtime runs after the page's
// classic scripts, in document order (a module script is deferred). The import map is the WHATWG one: `imports`, `scopes`,
// longest key first, and a key ending in `/` as a prefix.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve as resolvePath, isAbsolute } from 'node:path';
import { build, type Message, type Plugin } from 'esbuild';
import { CliError } from '../errors.js';
import { fetchCdnData, finalUrlOf, resolveCdnData, verifyIntegrity, type FetchedDep, type FetchOptions } from './deps.js';

/** A `<script type="importmap">`: bare names and prefixes to URLs, and per-referrer overrides. Every value is an absolute URL. */
export interface ImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** A `<script type="module">` of the page. */
export interface ModuleScript {
  /** The source of an inline script, or null for a `src`. */
  code: string | null;
  /** What it is, for messages: the script's URL (https) or absolute file path, or the HTML file for an inline script. */
  file: string;
  /** Where its own imports resolve from, as a URL: the script's URL, or the HTML file's `file:` URL for an inline script. */
  base: string;
  /** The composition it belongs to (see `HfScript`), and that composition's file. */
  scope: string | null;
  sourceFile: string | null;
  /** The project's directory: a local module must be inside it. */
  root: string;
  /** The script tag's `integrity`, checked against the bytes of a `src` module. */
  integrity?: string;
}

export const emptyImportMap = (): ImportMap => ({ imports: {}, scopes: {} });

const isUrlLike = (specifier: string): boolean => /^(?:\/|\.\/|\.\.\/)/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier);

function parseUrl(text: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(text) : new URL(text, base);
  } catch {
    return null;
  }
}

/** The specifier as a URL when it is `/x`, `./x`, `../x` or absolute; null for a bare name. */
function asUrl(specifier: string, base: string): URL | null {
  if (/^(?:\/|\.\/|\.\.\/)/.test(specifier)) return parseUrl(specifier, base);
  return /^[a-z][a-z0-9+.-]*:/i.test(specifier) ? parseUrl(specifier) : null;
}

/** An import map's keys and values as absolute URLs where they are URLs; a value that is neither is dropped. */
function normalizeSet(set: unknown, base: string, problems: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof set !== 'object' || set === null || Array.isArray(set)) return out;
  for (const [key, value] of Object.entries(set)) {
    if (key === '') continue;
    if (typeof value !== 'string') {
      problems.push(`the import map maps "${key}" to something that is not a string`);
      continue;
    }
    const target = parseUrl(value, base);
    if (target === null || (!isUrlLike(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value))) {
      problems.push(`the import map maps "${key}" to "${value}", which is not a URL or a path`);
      continue;
    }
    if (key.endsWith('/') && !target.href.endsWith('/')) {
      problems.push(`the import map maps the prefix "${key}" to "${value}", which does not end with a slash`);
      continue;
    }
    const keyUrl = asUrl(key, base);
    out[keyUrl === null ? key : keyUrl.href] = target.href;
  }
  return out;
}

/**
 * Reads the text of a `<script type="importmap">` whose file is at `base` (a URL; relative values resolve from it).
 * `problems` hears about the parts that were ignored.
 */
export function parseImportMap(text: string, base: string, problems: string[] = []): ImportMap {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    problems.push(`the import map is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return emptyImportMap();
  }
  const map = emptyImportMap();
  const root = json as { imports?: unknown; scopes?: unknown } | null;
  map.imports = normalizeSet(root?.imports, base, problems);
  if (typeof root?.scopes === 'object' && root.scopes !== null) {
    for (const [prefix, set] of Object.entries(root.scopes)) {
      const prefixUrl = parseUrl(prefix, base);
      if (prefixUrl === null) {
        problems.push(`the import map has a scope "${prefix}" that is not a URL`);
        continue;
      }
      map.scopes[prefixUrl.href] = { ...(map.scopes[prefixUrl.href] ?? {}), ...normalizeSet(set, base, problems) };
    }
  }
  return map;
}

/** Merges `extra` into `map`: a name already mapped keeps its first mapping (as in a browser, where a later map cannot override an earlier). */
export function mergeImportMaps(map: ImportMap, extra: ImportMap): void {
  for (const [key, value] of Object.entries(extra.imports)) if (!(key in map.imports)) map.imports[key] = value;
  for (const [scope, set] of Object.entries(extra.scopes)) {
    const into = (map.scopes[scope] ??= {});
    for (const [key, value] of Object.entries(set)) if (!(key in into)) into[key] = value;
  }
}

/** The first mapping of `specifier` in one set: an exact key, else the longest `…/` key that prefixes it. */
function matchSet(specifier: string, set: Record<string, string>): string | null {
  if (Object.hasOwn(set, specifier)) return set[specifier]!;
  const prefixes = Object.keys(set)
    .filter((key) => key.endsWith('/') && specifier.startsWith(key))
    .sort((a, b) => b.length - a.length);
  const key = prefixes[0];
  return key === undefined ? null : set[key]! + specifier.slice(key.length);
}

/**
 * The URL `specifier` names when imported by the module at `referrer` (a URL): the matching scope first (the longest scope
 * prefix that holds the referrer, then shorter ones), then the top-level `imports`, then the specifier as a URL. A bare name
 * with no mapping is an error, as in a browser.
 */
export function resolveImport(specifier: string, referrer: string, map: ImportMap): string {
  const url = asUrl(specifier, referrer);
  const key = url === null ? specifier : url.href;
  const scopes = Object.keys(map.scopes)
    .filter((scope) => scope === referrer || (scope.endsWith('/') && referrer.startsWith(scope)))
    .sort((a, b) => b.length - a.length);
  for (const scope of scopes) {
    const hit = matchSet(key, map.scopes[scope]!);
    if (hit !== null) return hit;
  }
  const hit = matchSet(key, map.imports);
  if (hit !== null) return hit;
  if (url !== null) return url.href;
  throw new Error(`the bare specifier "${specifier}" is not in an import map (imported by ${referrer})`);
}

// ---- bundling ----

const REMOTE = 'kinetograph-module-url';
const GSAP = 'kinetograph-module-gsap';
const INLINE = 'kinetograph-module-inline';
const INLINE_ENTRY = 'kinetograph-module-inline:entry';

/** `gsap` or a CDN URL of it: imported, it leaves its instance where the GSAP clock looks (`GSAP_REGISTRY` in core). */
const GSAP_URL = /^\/(?:v\d+\/)?(?:npm\/)?gsap(?:@[^/]+)?(?:\/(?:all|index\.js|\+esm|es\d+\/gsap(?:\.bundle)?\.m?js))?$/;
const isGsap = (specifier: string, url: string): boolean => {
  if (specifier === 'gsap' || specifier === 'gsap/all') return true;
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === 'https:' && GSAP_URL.test(parsed.pathname);
};

/** `import.meta` of a module is its own URL, as a browser has it. */
function withImportMeta(code: string, url: string): string {
  if (!code.includes('import.meta')) return code;
  const quoted = JSON.stringify(url);
  return code.replace(/\bimport\.meta\.url\b/g, quoted).replace(/\bimport\.meta\b/g, `({ url: ${quoted} })`);
}

const loaderFor = (url: string): 'js' | 'json' | 'empty' => {
  const path = parseUrl(url)?.pathname ?? url;
  if (/\.json$/i.test(path)) return 'json';
  if (/\.css$/i.test(path)) return 'empty';
  return 'js';
};

interface PluginState {
  script: ModuleScript;
  map: ImportMap;
  /** `fetch`: a module that is not cached is downloaded; `offline`: it is an error. */
  fetch: FetchOptions | null;
  /** Modules the graph reached, by URL. */
  fetched: FetchedDep[];
  /** URLs that are not in the cache. */
  missing: string[];
  /** Set when a script's `integrity` did not match. */
  integrityFailed: boolean;
}

/** Whether the file at `path` is inside `root` once symlinks are resolved. */
function insideRoot(path: string, root: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    // A file that is not there: the lexical position decides, and esbuild reports the missing file.
    const rel = relative(resolvePath(root), resolvePath(path));
    return !rel.startsWith('..') && !isAbsolute(rel);
  }
}

function modulePlugin(state: PluginState): Plugin {
  return {
    name: 'kinetograph-modules',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          // The synthetic entry: the inline script, or the script's URL / file.
          if (args.path === INLINE_ENTRY) return { path: state.script.file, namespace: INLINE, sideEffects: true };
          if (/^https:/i.test(args.path)) return { path: args.path, namespace: REMOTE, sideEffects: true };
          if (!insideRoot(args.path, state.script.root)) return { errors: [{ text: `${args.path} is outside the project (${state.script.root}): it is not loaded` }] };
          return { path: args.path, sideEffects: true };
        }
        const referrer =
          args.namespace === REMOTE || args.namespace === GSAP ? finalUrlOf(args.importer) : args.namespace === INLINE ? state.script.base : pathToFileURL(args.importer).href;
        let target: string;
        try {
          target = resolveImport(args.path, referrer, state.map);
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
        if (!args.pluginData?.noShim && isGsap(args.path, target) && /^https:/i.test(target)) return { path: target, namespace: GSAP };
        const fromRemote = args.namespace === REMOTE || args.namespace === GSAP;
        if (/^https:/i.test(target)) return { path: target, namespace: REMOTE, sideEffects: true };
        // A remote module imports https URLs only: it cannot pull a file of this machine into the bundle.
        if (fromRemote) return { errors: [{ text: `${args.path} (imported by the remote module ${referrer}) resolves to ${target}: a remote module may only import https: URLs` }] };
        if (/^file:/i.test(target)) {
          const file = fileURLToPath(target);
          if (!insideRoot(file, state.script.root)) return { errors: [{ text: `${target} (imported by ${referrer}) is outside the project (${state.script.root}): it is not loaded` }] };
          return { path: file, sideEffects: true };
        }
        return { errors: [{ text: `${target} (imported by ${referrer}) is not an https: or file: URL: it is not loaded` }] };
      });

      const text = async (url: string): Promise<{ text: string } | { errors: { text: string }[] }> => {
        let found = resolveCdnData(url);
        if ('error' in found && state.fetch !== null) {
          const [result] = await fetchCdnData([url], state.fetch);
          if (result !== undefined) state.fetched.push(result);
          if (result?.status === 'failed') return { errors: [{ text: `${url}: ${result.error}` }] };
          found = resolveCdnData(url);
        } else if ('file' in found) {
          if (state.fetch !== null) state.fetched.push(...(await fetchCdnData([url], state.fetch)));
        }
        if ('error' in found) {
          state.missing.push(url);
          return { errors: [{ text: found.error }] };
        }
        return { text: readFileSync(found.file, 'utf8') };
      };

      b.onLoad({ filter: /.*/, namespace: INLINE }, () => ({ contents: withImportMeta(state.script.code ?? '', state.script.base), loader: 'js' }));
      b.onLoad({ filter: /.*/, namespace: REMOTE }, async (args) => {
        const got = await text(args.path);
        if ('errors' in got) return got;
        if (args.path === state.script.file && state.script.integrity) {
          try {
            verifyIntegrity(Buffer.from(got.text), state.script.integrity, args.path);
          } catch (error) {
            state.integrityFailed = true;
            return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
          }
        }
        // A redirected download is based at where it ended, as in a browser: its relative imports and `import.meta.url`.
        return { contents: withImportMeta(got.text, finalUrlOf(args.path)), loader: loaderFor(args.path), pluginData: { noShim: true } };
      });
      b.onLoad({ filter: /.*/, namespace: GSAP }, async (args) => {
        // The module itself is read through the cache (and walked for its imports) like any other.
        const from = JSON.stringify(args.path);
        return {
          contents: [
            `import * as ns from ${from};`,
            `export * from ${from};`,
            `export { default } from ${from};`,
            `globalThis[Symbol.for('kinetograph.gsap')] = ns.gsap ?? ns.default?.gsap ?? ns.default;`,
          ].join('\n'),
          loader: 'js',
          pluginData: { noShim: true },
        };
      });
      // A local module: `import.meta.url` is its file URL.
      b.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8');
        if (!code.includes('import.meta')) return undefined;
        return { contents: withImportMeta(code, pathToFileURL(args.path).href), loader: /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js' };
      });
    },
  };
}

const messageText = (m: Message): string => (m.location ? `${m.location.file}:${m.location.line}: ${m.text}` : m.text);

async function bundle(state: PluginState, format: 'iife' | 'esm'): Promise<string> {
  const { script } = state;
  const entry = script.code !== null ? INLINE_ENTRY : script.file;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [modulePlugin(state)],
  });
  return result.outputFiles[0]!.text;
}

/**
 * `script` and everything it imports as one classic script. Top-level `await` makes the script an async function that the
 * runtime does not wait for (it runs to its first `await` at once). The build reads the cache only, unless `fetch` is given
 * (the pre-download step), which downloads what is not there.
 */
export async function bundleModuleScript(script: ModuleScript, map: ImportMap, fetch: FetchOptions | null = null): Promise<{ code: string; fetched: FetchedDep[] }> {
  const state: PluginState = { script, map, fetch, fetched: [], missing: [], integrityFailed: false };
  try {
    return { code: await bundle(state, 'iife'), fetched: state.fetched };
  } catch (error) {
    const errors = (error as { errors?: Message[] }).errors ?? [];
    if (errors.some((e) => /top-level await/i.test(e.text))) {
      try {
        const esm = await bundle(state, 'esm');
        return { code: `(async () => {\n${esm}\n})();`, fetched: state.fetched };
      } catch (again) {
        throw failure(script, state, (again as { errors?: Message[] }).errors ?? [], again);
      }
    }
    throw failure(script, state, errors, error);
  }
}

function failure(script: ModuleScript, state: PluginState, errors: Message[], fallback: unknown): CliError {
  const text = errors.length > 0 ? errors.map(messageText).join('\n') : fallback instanceof Error ? fallback.message : String(fallback);
  const message = `${script.file}: the module script's imports could not be bundled:\n${text}`;
  return new CliError(state.integrityFailed ? 'INTEGRITY_MISMATCH' : state.missing.length > 0 ? 'SCRIPT_NOT_AVAILABLE' : 'MODULE_BUNDLE_FAILED', message);
}

/**
 * The pre-download step for module scripts: each one's import graph is walked (by bundling it) and every remote module is
 * downloaded and locked. A script that cannot be bundled is a failed entry (its imports of the graph that were reached are
 * kept); the render reports it.
 */
export async function fetchModuleGraph(modules: ModuleScript[], map: ImportMap, options: FetchOptions): Promise<FetchedDep[]> {
  const results: FetchedDep[] = [];
  const seen = new Set<string>();
  for (const script of modules) {
    try {
      const { fetched } = await bundleModuleScript(script, map, options);
      for (const f of fetched) if (!seen.has(f.url)) (seen.add(f.url), results.push(f));
    } catch (error) {
      results.push({ url: script.file, file: '', status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
