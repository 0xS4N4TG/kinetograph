import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context, type BuildOptions, type Message, type Plugin } from 'esbuild';
import { familyFromModuleName } from '@kinetographdev/core/google-fonts';
import { cssPlugin } from './css.js';
import { CliError } from './errors.js';
import { HYPERFRAMES_PREFIX, hyperframesPlugin, isHyperframesEntry, resolveEntry } from './hyperframes/entry.js';

/** The package directory of the CLI: the bundle's `@kinetographdev/*` imports resolve from here, so one copy of each. */
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The `@remotion/<pkg>` packages that have a `@kinetographdev/core/<pkg>` subpath (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5). */
const REMOTION_PACKAGES = new Set([
  'transitions',
  'motion-blur',
  'noise',
  'paths',
  'shapes',
  'layout-utils',
  'animation-utils',
  'captions',
  'google-fonts',
  'fonts',
  'lottie',
  'gif',
  'media-utils',
  'media',
  'light-leaks',
  'starburst',
  'sfx',
  'zod-types',
  'timeline-utils',
  'media-parser',
  'webcodecs',
  'canvas',
  'rive',
  'skia',
]);

export type Resolution =
  | { kind: 'path'; target: string }
  | { kind: 'font'; family: string }
  | { kind: 'unsupported'; message: string };

/**
 * `DMSans` → `DM Sans`, `NotoSansJP` → `Noto Sans JP`, `JetBrainsMono` → `JetBrains Mono`: the family name of a Google
 * Fonts module. The core's function, so its list of names the splitting rule gets wrong is shared.
 */
export const familyFromModule = familyFromModuleName;

/**
 * Where an import of a project goes, or null if the bundle resolves it as usual. `remotion` and `@remotion/*` become
 * the matching `@kinetographdev/core` subpath; `@remotion/google-fonts/<Family>` becomes a generated module; the
 * `@kinetographdev` packages are re-resolved from the CLI so that a project and the CLI share one copy of each.
 */
export function resolveSpecifier(specifier: string): Resolution | null {
  if (specifier === 'remotion' || specifier.startsWith('remotion/')) return { kind: 'path', target: '@kinetographdev/core' };
  const remotion = /^@remotion\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (remotion) {
    const [, pkg, rest] = remotion as unknown as [string, string, string | undefined];
    if (pkg === 'google-fonts' && rest && !rest.includes('/')) return { kind: 'font', family: familyFromModule(rest) };
    if (REMOTION_PACKAGES.has(pkg)) {
      return { kind: 'path', target: `@kinetographdev/core/${pkg}${rest ? `/${rest}` : ''}` };
    }
    return {
      kind: 'unsupported',
      message: `"${specifier}" is not supported by Kinetograph yet. Run \`kinetograph doctor\` for what is.`,
    };
  }
  // React Native Skia's components are the core's (drawn by the optional @kinetographdev/skia addon, packages/cli/skills/kinetograph/references/AUTHORING.md §7.7).
  if (specifier === '@shopify/react-native-skia') return { kind: 'path', target: '@kinetographdev/core/skia' };
  // Reanimated's shared values drive RN-Skia's props; the core has them, worked out from the frame.
  if (specifier === 'react-native-reanimated') return { kind: 'path', target: '@kinetographdev/core/skia/reanimated' };
  if (specifier.startsWith('@shopify/react-native-skia/')) {
    return { kind: 'unsupported', message: `"${specifier}" is an internal of React Native Skia; import from "@shopify/react-native-skia".` };
  }
  if (/^@kinetographdev\/(core|react|scene|audio|compat)(\/.*)?$/.test(specifier)) return { kind: 'path', target: specifier };
  // React too: a project with its own copy of React would otherwise bundle two, and the core's hooks would run against
  // a different React from the project's components.
  if (/^react(-reconciler)?(\/.*)?$/.test(specifier)) return { kind: 'path', target: specifier };
  return null;
}

/** An import of a package Kinetograph does not support, and the file that imports it. */
export interface UnsupportedImport {
  specifier: string;
  file: string | null;
}

/** The names `importer` imports from `specifier` (`import { a, b as c } from '...'`), found with a pattern: a stub needs them as exports. */
function importedNames(importer: string, specifier: string): string[] {
  let text = '';
  try {
    text = readFileSync(importer, 'utf8');
  } catch {
    return [];
  }
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const names = new Set<string>();
  for (const m of text.matchAll(new RegExp(`import\\s+(?:([\\w$]+)\\s*,?\\s*)?(?:\\{([^}]*)\\})?\\s*from\\s*['"]${escaped}['"]`, 'g'))) {
    for (const part of (m[2] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim() ?? '';
      if (/^[\w$]+$/.test(name) && !name.startsWith('type ') && name !== 'default') names.add(name);
    }
  }
  return [...names];
}

/** What an unsupported package is replaced with when the caller wants to carry on without it (`doctor`): every import is a component that draws nothing. */
function unsupportedStub(names: string[]): string {
  return [...names.map((n) => `export const ${n} = () => null;`), 'export default () => null;'].join('\n');
}

function aliasPlugin(unsupported?: UnsupportedImport[]): Plugin {
  return {
    name: 'kinetograph-aliases',
    setup(b) {
      b.onResolve({ filter: /^(remotion($|\/)|@remotion\/|@shopify\/react-native-skia($|\/)|react-native-reanimated$|@kinetographdev\/(core|react|scene|audio|compat)($|\/)|react(-reconciler)?($|\/))/ }, async (args) => {
        if (args.pluginData?.kinetograph) return undefined;
        const resolution = resolveSpecifier(args.path);
        if (!resolution) return undefined;
        if (resolution.kind === 'unsupported') {
          if (!unsupported) return { errors: [{ text: resolution.message }] };
          const file = args.importer || null;
          if (!unsupported.some((u) => u.specifier === args.path && u.file === file)) unsupported.push({ specifier: args.path, file });
          return { path: `${args.path}?${args.importer}`, namespace: 'kinetograph-unsupported', pluginData: { names: importedNames(args.importer, args.path) } };
        }
        if (resolution.kind === 'font') return { path: resolution.family, namespace: 'kinetograph-google-font' };
        const fromCli = await b.resolve(resolution.target, {
          resolveDir: CLI_DIR,
          kind: args.kind,
          pluginData: { kinetograph: true },
        });
        if (fromCli.errors.length === 0) return fromCli;
        // Not reachable from the CLI (a package manager that does not hoist): resolve from where it was imported.
        if (resolution.target === args.path) return undefined;
        return b.resolve(resolution.target, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { kinetograph: true },
        });
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-unsupported' }, (args) => ({ contents: unsupportedStub(args.pluginData?.names ?? []), loader: 'js' }));
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-google-font' }, (args) => ({
        contents: [
          `import { makeGoogleFont } from '@kinetographdev/core/google-fonts';`,
          `const font = makeGoogleFont(${JSON.stringify(args.path)});`,
          `export const { loadFont, fontFamily, getInfo } = font;`,
          `export default font;`,
        ].join('\n'),
        resolveDir: CLI_DIR,
        loader: 'js',
      }));
    },
  };
}

/**
 * Tells the engine which GSAP the project imported. GSAP's ES module keeps its instance to itself (its browser build
 * puts it on `window.gsap`, which an `import` never runs), and the engine drives GSAP's clock from the frame's time
 * (packages/core/src/gsap-clock.ts). Nothing of GSAP changes: `import 'gsap'` resolves to a module that re-exports
 * GSAP's own and records the instance.
 */
function gsapPlugin(): Plugin {
  return {
    name: 'kinetograph-gsap',
    setup(b) {
      b.onResolve({ filter: /^gsap(\/all)?$/ }, async (args) => {
        if (args.pluginData?.kinetographGsap || (args.kind !== 'import-statement' && args.kind !== 'dynamic-import')) return undefined;
        const real = await b.resolve(args.path, { resolveDir: args.resolveDir, importer: args.importer, kind: args.kind, pluginData: { kinetographGsap: true } });
        if (real.errors.length > 0 || real.external) return undefined;
        return { path: real.path, namespace: 'kinetograph-gsap' };
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-gsap' }, (args) => {
        const from = JSON.stringify(args.path);
        return {
          contents: [
            `import { gsap as instance } from ${from};`,
            `export * from ${from};`,
            `export { default } from ${from};`,
            `globalThis[Symbol.for('kinetograph.gsap')] = instance;`,
          ].join('\n'),
          resolveDir: dirname(args.path),
          loader: 'js',
        };
      });
    },
  };
}

/** A package's `browser` map (object form) and the directory it sits in, found from a file inside the package; null when there is none. */
const browserMaps = new Map<string, { root: string; map: Record<string, string | false> } | null>();
function browserMapOf(dir: string): { root: string; map: Record<string, string | false> } | null {
  const cached = browserMaps.get(dir);
  if (cached !== undefined) return cached;
  let found: { root: string; map: Record<string, string | false> } | null = null;
  const file = join(dir, 'package.json');
  if (existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { browser?: unknown };
      if (typeof json.browser === 'object' && json.browser !== null) found = { root: dir, map: json.browser as Record<string, string | false> };
    } catch {
      // A package.json that does not parse is no map.
    }
  } else if (dirname(dir) !== dir) {
    found = browserMapOf(dirname(dir));
  }
  browserMaps.set(dir, found);
  return found;
}

/**
 * A package's `browser` map says which of its Node-only imports a browser leaves out (`"jsdom": false`) or swaps. The
 * bundle runs on Node, so a map is not applied while its import resolves; but one that does not (Paper.js's optional
 * `jsdom` and `canvas`, which a browser never has) is read as the package saying "not needed here": `false` bundles an
 * empty module, a string its replacement. Only packages under `node_modules` are read.
 */
function browserFieldPlugin(): Plugin {
  return {
    name: 'kinetograph-browser-field',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.kinetographBrowser || args.kind === 'entry-point' || !args.importer || !args.importer.includes(`${sep}node_modules${sep}`)) return undefined;
        const found = browserMapOf(dirname(args.importer));
        if (found === null) return undefined;
        const tried = await b.resolve(args.path, { resolveDir: args.resolveDir, importer: args.importer, kind: args.kind, namespace: args.namespace, pluginData: { kinetographBrowser: true } });
        if (tried.errors.length === 0) return tried;
        const relative = args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : null;
        const spellings = relative === null ? [] : [relative, `${relative}.js`, `${relative}.json`, `${relative}${sep}index.js`];
        for (const [key, to] of Object.entries(found.map)) {
          const same = key.startsWith('.') ? spellings.includes(resolve(found.root, key)) : key === args.path;
          if (!same) continue;
          if (to === false) return { path: args.path, namespace: 'kinetograph-browser-empty' };
          return b.resolve(to.startsWith('.') ? resolve(found.root, to) : to, { resolveDir: found.root, kind: args.kind, pluginData: { kinetographBrowser: true } });
        }
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-browser-empty' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    },
  };
}

/**
 * The studio's `jsxDEV`: React 19 ignores the `__source` esbuild's dev transform passes, so this records it, keyed by
 * the element's props object, for the reconciler to read back when it makes the host element (`origin.ts` in
 * `@kinetographdev/react`, which shares the key). Only the studio's bundles use it; a render's bundle has no `__source`
 * and no shim, so it is unchanged.
 */
const JSX_DEV_SHIM = `
import * as real from 'react/jsx-dev-runtime';
const sources = (globalThis[Symbol.for('kinetograph.jsxSources')] ??= new WeakMap());
export const Fragment = real.Fragment;
export function jsxDEV(type, config, key, isStatic, source, self) {
  const element = real.jsxDEV
    ? real.jsxDEV(type, config, key, isStatic, source, self)
    : (isStatic ? real.jsxs : real.jsx)(type, config, key);
  if (source && element && typeof element.props === 'object' && element.props !== null) sources.set(element.props, source);
  return element;
}
`;

function jsxDevPlugin(): Plugin {
  return {
    name: 'kinetograph-jsx-dev',
    setup(b) {
      b.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, (args) => {
        if (args.pluginData?.kinetographJsxDev === 'real') return undefined;
        // The shim's own import is React's.
        if (args.namespace === 'kinetograph-jsx-dev') {
          return b.resolve(args.path, { resolveDir: CLI_DIR, kind: args.kind, pluginData: { kinetograph: true, kinetographJsxDev: 'real' } });
        }
        return { path: 'jsx-dev-runtime', namespace: 'kinetograph-jsx-dev' };
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-jsx-dev' }, () => ({ contents: JSX_DEV_SHIM, resolveDir: CLI_DIR, loader: 'js' }));
    },
  };
}

/**
 * The project's entry file always runs: the synthetic entry imports it only for its side effects (`registerRoot`), and
 * a package.json with `"sideEffects": [...]` that leaves it out (as Remotion's templates do) would let esbuild drop it.
 */
function entryPlugin(absolute: string): Plugin {
  return {
    name: 'kinetograph-entry',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => (args.path === absolute ? { path: absolute, sideEffects: true } : undefined));
    },
  };
}

/** The picture files an `import` gives the path of. */
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

/**
 * `import tex from './tex.jpg'` is the file's real absolute path, a string `<Img>`, `new Image().src`, `Gif`, `staticFile`-style
 * code and a canvas's `drawImage` all load. The bundle is written under `node_modules/.cache`, so a path made from
 * `import.meta.url` (`new URL('./tex.jpg', import.meta.url)`) points into the cache, where the file is not; this
 * import resolves where the project or plugin keeps it. (Remotion's own bundler gives a URL of its dev server here; a
 * Node render has no server, and the path is what a file on disk is loaded by.) A `url()` in a stylesheet is the CSS
 * plugin's, not this one's.
 */
function imagePlugin(): Plugin {
  return {
    name: 'kinetograph-image',
    setup(b) {
      b.onResolve({ filter: IMAGE_FILE }, async (args) => {
        if (args.kind !== 'import-statement' && args.kind !== 'require-call' && args.kind !== 'dynamic-import') return undefined;
        if (args.pluginData?.kinetographImage || args.namespace !== 'file') return undefined;
        const found = await b.resolve(args.path, { resolveDir: args.resolveDir, importer: args.importer, kind: args.kind, pluginData: { kinetographImage: true } });
        if (found.errors.length > 0 || found.external) return found.errors.length > 0 ? { errors: found.errors } : undefined;
        return { path: found.path, namespace: 'kinetograph-image' };
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-image' }, (args) => ({ contents: `export default ${JSON.stringify(args.path)};`, loader: 'js' }));
    },
  };
}

/** The synthetic entry (packages/cli/skills/kinetograph/references/AUTHORING.md §9): the shim's side-effect module is evaluated before the project. */
export function syntheticEntry(entry: string, dev = false): string {
  return [
    // The studio's JSX shim makes its table of source locations before the project runs.
    ...(dev ? [`import 'react/jsx-dev-runtime';`] : []),
    `import '@kinetographdev/core/determinism/install';`,
    `import '@kinetographdev/core/web/install';`,
    // An HTML entry is a HyperFrames project: the plugin turns it into a module that defines the composition.
    `import ${JSON.stringify(isHyperframesEntry(entry) ? `${HYPERFRAMES_PREFIX}${entry}` : entry)};`,
    `export * from '@kinetographdev/core';`,
    // Text measurement goes through the CLI's own addon: a bundle under node_modules/.cache cannot always find it.
    `export { setLayoutText } from '@kinetographdev/core/layout-utils';`,
    `export { setAudioDecoder, setMediaProbe } from '@kinetographdev/core/media-utils';`,
    `export { setMediaParserAddon } from '@kinetographdev/core/media-parser';`,
    // DOM elements are styled, laid out and painted by the addon too (packages/cli/skills/kinetograph/references/ENGINE.md §2).
    `export { setDomAddon, setDomEnvironment, stylesheetNotes } from '@kinetographdev/compat/dom';`,
    '',
  ].join('\n');
}

/** `node_modules/.cache/kinetograph` of the project the entry belongs to: the nearest directory with a package.json. */
export function cacheDir(entry: string): string {
  let dir = dirname(entry);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'node_modules', '.cache', 'kinetograph');
    const parent = dirname(dir);
    if (parent === dir) return join(dirname(entry), 'node_modules', '.cache', 'kinetograph');
    dir = parent;
  }
}

// `node-web-audio-api` and the addon are native modules that cannot be bundled. A bundle never loads the first (the
// audio package imports it only when it renders), and the CLI loads the second itself.
const EXTERNAL = ['@kinetographdev/native', 'node-web-audio-api'];

export interface BundleResult {
  /** The written `.mjs` file. */
  file: string;
  warnings: string[];
}

/** The esbuild options that bundle the project at `absolute` (packages/cli/skills/kinetograph/references/AUTHORING.md §9). */
function bundleOptions(absolute: string, unsupported?: UnsupportedImport[], dev = false): BuildOptions {
  return {
    stdin: {
      contents: syntheticEntry(absolute, dev),
      resolveDir: dirname(absolute),
      sourcefile: 'kinetograph-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: dirname(absolute),
    bundle: true,
    write: false,
    outfile: 'bundle.mjs',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    // The studio's builds record where each element's JSX is (see `JSX_DEV_SHIM`).
    jsxDev: dev,
    sourcemap: 'inline',
    logLevel: 'silent',
    external: EXTERNAL,
    // An `import './index.css'` registers the stylesheet's text for the DOM engine (packages/cli/skills/kinetograph/references/ENGINE.md §1); Tailwind's
    // entry is built by the project's Tailwind, and `*.module.css` files export their scoped class names.
    plugins: [...(dev ? [jsxDevPlugin()] : []), entryPlugin(absolute), imagePlugin(), hyperframesPlugin(), aliasPlugin(unsupported), gsapPlugin(), browserFieldPlugin(), cssPlugin()],
    // Bundled CommonJS packages (react-reconciler) call `require` for Node built-ins.
    banner: { js: `import { createRequire as __kCreateRequire } from 'node:module';\nconst require = __kCreateRequire(import.meta.url);` },
  };
}

/** The error for esbuild's `errors`: one line per message, with its file and line when it has them. */
function bundleFailure(errors: Message[], fallback: unknown): CliError {
  const messages = errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text));
  // `kinetograph` is the CLI; the video API a project imports is `@kinetographdev/core`.
  if (errors.some((e) => /^No matching export in ".*node_modules[\\/]kinetograph[\\/]/.test(e.text))) {
    messages.push("hint: the 'kinetograph' package is the CLI; import the video API from '@kinetographdev/core'");
  }
  return new CliError('BUNDLE_FAILED', messages.length ? messages.join('\n') : String(fallback));
}

/**
 * Bundles the project at `entry` with esbuild into `node_modules/.cache/kinetograph/`. The file name carries a hash of
 * the entry's path and one of the output, so it only changes when the code does and a changed project is re-imported
 * even by a process that has already imported the old one. With `options.unsupported`, an import of an unsupported
 * package does not fail the bundle: it is listed there (package and importing file) and bundled as a stub.
 */
export async function bundleProject(entry: string, options: { unsupported?: UnsupportedImport[] } = {}): Promise<BundleResult> {
  const absolute = resolveEntry(entry);
  let result;
  try {
    result = await build(bundleOptions(absolute, options.unsupported));
  } catch (error) {
    throw bundleFailure((error as { errors?: Message[] }).errors ?? [], error);
  }

  const code = result.outputFiles![0]!.text;
  const dir = cacheDir(absolute);
  mkdirSync(dir, { recursive: true });
  const entryHash = createHash('sha256').update(absolute).digest('hex').slice(0, 10);
  const codeHash = createHash('sha256').update(code).digest('hex').slice(0, 10);
  const prefix = `${basename(absolute, extname(absolute))}-${entryHash}-`;
  const file = join(dir, `${prefix}${codeHash}.mjs`);
  for (const old of readdirSync(dir)) {
    if (old.startsWith(prefix) && old !== basename(file)) rmSync(join(dir, old), { force: true });
  }
  writeFileSync(file, code);
  return { file, warnings: result.warnings.map((w) => w.text) };
}

/** One build of a watched project: the bundle's code, or why it failed. */
export type ProjectBuild = { code: string; warnings: string[] } | { error: CliError };

/**
 * Bundles the project at `entry` as `bundleProject` does, writes nothing, and keeps watching the files the bundle
 * reads: `onBuild` is called after the first build and after every rebuild with the code or the error. A failed
 * rebuild does not stop the watching. Resolves once watching has started (the first `onBuild` has been called by then).
 */
export async function watchProject(
  entry: string,
  onBuild: (build: ProjectBuild) => void,
): Promise<{ dispose(): Promise<void> }> {
  const options = bundleOptions(resolveEntry(entry), undefined, true);
  const notify: Plugin = {
    name: 'kinetograph-notify',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length > 0) onBuild({ error: bundleFailure(result.errors, 'build failed') });
        else onBuild({ code: result.outputFiles![0]!.text, warnings: result.warnings.map((w) => w.text) });
      });
    },
  };
  const watching = await context({ ...options, plugins: [...(options.plugins ?? []), notify] });
  await watching.watch();
  return { dispose: () => watching.dispose() };
}
