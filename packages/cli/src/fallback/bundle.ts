// The project bundled for the browser (docs/COMPAT.md §6.2): React DOM, this repo's `@kinetograph/core`, and
// `@kinetograph/react` aliased to `@kinetograph/compat/browser`, so the native elements draw DOM. The determinism shim is
// installed in the page before the project, as in the Node bundle. `remotion` and `@remotion/*` resolve as they do there.

import { dirname, resolve } from 'node:path';
import { build, type BuildOptions, type Message, type Plugin } from 'esbuild';
import { CLI_DIR, entryPlugin, familyFromModule, resolveSpecifier } from '../bundle.js';
import { CliError } from '../errors.js';

export interface BrowserBundleSettings {
  /** The composition the page draws. */
  composition: string;
  /** `--props`: the input props the composition was opened with. */
  inputProps: Record<string, unknown>;
  /** The working directory of the Node side: relative font paths and `process.cwd()` in the page resolve against it. */
  cwd: string;
  /** The public directory `staticFile` reads from. */
  publicDir: string;
}

/**
 * The synthetic entry: the prelude and the determinism shim first (ESM evaluates imports in order), then the project,
 * then the page's runtime. The page asks its driver, synchronously, for the two things only the addon can do:
 * measure text and read a media file's header.
 */
export function browserEntry(entry: string, settings: Pick<BrowserBundleSettings, 'composition' | 'inputProps'>): string {
  return [
    `import '@kinetograph/compat/browser/prelude';`,
    `import '@kinetograph/core/determinism/install';`,
    `import ${JSON.stringify(entry)};`,
    `import { createFrameRenderer, registerFont } from '@kinetograph/core';`,
    `import { setLayoutText } from '@kinetograph/core/layout-utils';`,
    `import { setAudioDecoder, setMediaProbe } from '@kinetograph/core/media-utils';`,
    `import { installBrowserRuntime } from '@kinetograph/compat/browser';`,
    `function ask(method, url, body) {`,
    `  const request = new XMLHttpRequest();`,
    `  request.open(method, url, false);`,
    `  if (body !== undefined) request.setRequestHeader('content-type', 'application/json');`,
    `  request.send(body === undefined ? null : JSON.stringify(body));`,
    `  const reply = JSON.parse(request.responseText);`,
    `  if (request.status !== 200) throw new Error(reply.error ? reply.error.message : 'the driver answered ' + request.status);`,
    `  return reply;`,
    `}`,
    // The Node side's registry is the one that has every font (Google Fonts are downloaded there); the driver mirrors
    // it here, so that measureText and the like see the fonts the project registered.
    `window.__kinetographRegisterFonts = (fonts) => {`,
    `  for (const [key, path] of Object.entries(fonts)) {`,
    `    const m = /^(.*?)(?::(\\d+)(i)?)?$/.exec(key);`,
    `    registerFont({ family: m[1], path, weight: Number(m[2] || 400), style: m[3] ? 'italic' : 'normal' });`,
    `  }`,
    `};`,
    `setLayoutText((request) => ask('POST', '/@layout', request));`,
    `setMediaProbe((path) => ask('GET', '/@probe?src=' + encodeURIComponent(path)));`,
    `setAudioDecoder((path, sampleRate) => {`,
    `  const pcm = ask('GET', '/@audio?src=' + encodeURIComponent(path) + '&sampleRate=' + sampleRate);`,
    `  if (pcm === null) return null;`,
    `  const channels = pcm.channels.map((text) => {`,
    `    const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));`,
    `    return new Float32Array(bytes.buffer);`,
    `  });`,
    `  return { sampleRate: pcm.sampleRate, channels };`,
    `});`,
    `installBrowserRuntime(createFrameRenderer(${JSON.stringify(settings.composition)}, { inputProps: ${JSON.stringify(settings.inputProps)} }));`,
    '',
  ].join('\n');
}

/** What an import becomes in the browser bundle: a path to resolve from the CLI, or one of the stand-ins. */
export type BrowserResolution =
  | { kind: 'path'; target: string }
  | { kind: 'font'; family: string }
  | { kind: 'stub'; message: string; silent: boolean }
  | { kind: 'node-path' }
  | { kind: 'unsupported'; message: string };

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'perf_hooks',
  'process', 'readline', 'stream', 'tls', 'url', 'util', 'v8', 'worker_threads', 'zlib',
]);

/**
 * Where an import goes in the browser bundle, or null to resolve it as usual. The Node bundle's aliases hold
 * (`remotion`, `@remotion/*`, the `@kinetograph` packages), with these differences: `@kinetograph/react` is
 * `@kinetograph/compat/browser`; React DOM resolves from the CLI like React does; and the packages that need Node
 * (`@kinetograph/native`, `@kinetograph/audio`, Node's own modules) are stand-ins that fail only if they are called.
 */
export function resolveBrowserSpecifier(specifier: string): BrowserResolution | null {
  if (specifier === '@kinetograph/react') return { kind: 'path', target: '@kinetograph/compat/browser' };
  if (/^@kinetograph\/compat(\/|$)/.test(specifier)) return { kind: 'path', target: specifier };
  if (/^react-dom(\/.*)?$/.test(specifier)) return { kind: 'path', target: specifier };
  // The sound of a project is not part of a picture: its calls are accepted and do nothing.
  if (specifier === '@kinetograph/audio' || specifier.startsWith('@kinetograph/audio/')) {
    return { kind: 'stub', message: '', silent: true };
  }
  if (specifier === '@kinetograph/native' || specifier === 'node-web-audio-api') {
    return { kind: 'stub', message: `${specifier} is not available in Chrome frames`, silent: false };
  }
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (bare === 'path' || bare === 'path/posix') return { kind: 'node-path' };
  if (NODE_BUILTINS.has(bare.split('/')[0]!)) {
    return { kind: 'stub', message: `"${specifier}" is not available in Chrome frames`, silent: false };
  }
  return resolveSpecifier(specifier);
}

// A bundled CommonJS module whose every property is a function that throws (or, for `silent`, returns nothing). A
// CommonJS stand-in lets `import { createHash } from 'node:crypto'` bundle whatever the name, unlike an ES module.
function stubSource(label: string, silent: boolean): string {
  return silent
    ? `module.exports = new Proxy({}, { get: (_, name) => name === '__esModule' ? false : name === 'then' ? undefined : () => undefined });`
    : `module.exports = new Proxy({}, { get: (_, name) => name === '__esModule' ? false : name === 'then' ? undefined : () => { throw new Error(${JSON.stringify(label)} + ' (' + String(name) + ')'); } });`;
}

// POSIX path functions for the few places core resolves a file name (`staticFile`, `registerFont`).
const NODE_PATH_SOURCE = `
const cwd = () => (globalThis.process && globalThis.process.cwd ? globalThis.process.cwd() : '/');
const isAbsolute = (p) => p.startsWith('/');
function normalize(p) {
  const absolute = isAbsolute(p);
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!absolute) out.push('..'); }
    else out.push(part);
  }
  const joined = out.join('/');
  return absolute ? '/' + joined : joined || '.';
}
const join = (...parts) => normalize(parts.filter((p) => p !== '').join('/') || '.');
function resolve(...parts) {
  let path = '';
  for (let i = parts.length - 1; i >= 0 && !isAbsolute(path); i--) if (parts[i]) path = parts[i] + (path ? '/' + path : '');
  if (!isAbsolute(path)) path = cwd() + (path ? '/' + path : '');
  return normalize(path);
}
const dirname = (p) => { const n = p.replace(/\\/+$/, ''); const i = n.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : n.slice(0, i); };
const basename = (p, ext) => { const n = p.replace(/\\/+$/, ''); let b = n.slice(n.lastIndexOf('/') + 1); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; };
const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); };
function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean); const b = resolve(to).split('/').filter(Boolean);
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => '..'), ...b].join('/');
}
const path = { sep: '/', delimiter: ':', isAbsolute, normalize, join, resolve, dirname, basename, extname, relative };
path.posix = path;
module.exports = path;
`;

/** The Google Fonts modules in a Chrome frame: the Node side has downloaded and registered the fonts, so nothing loads. */
function googleFontModule(family: string): string {
  return [
    `export const fontFamily = ${JSON.stringify(family)};`,
    `export const loadFont = () => ({ fontFamily, waitUntilDone: () => Promise.resolve() });`,
    `export const getInfo = () => ({ fontFamily });`,
    `export default { loadFont, fontFamily, getInfo };`,
  ].join('\n');
}

function aliasPlugin(): Plugin {
  return {
    name: 'kinetograph-browser-aliases',
    setup(b) {
      b.onResolve(
        { filter: /^(remotion($|\/)|@remotion\/|@kinetograph\/|react($|\/)|react-dom($|\/)|react-reconciler($|\/)|node:|node-web-audio-api$|(assert|buffer|child_process|crypto|events|fs|http|https|module|net|os|path|perf_hooks|process|readline|stream|tls|url|util|v8|worker_threads|zlib)($|\/))/ },
        async (args) => {
          if (args.pluginData?.kinetographBrowser) return undefined;
          const resolution = resolveBrowserSpecifier(args.path);
          if (!resolution) return undefined;
          if (resolution.kind === 'unsupported') return { errors: [{ text: resolution.message }] };
          if (resolution.kind === 'font') return { path: resolution.family, namespace: 'kinetograph-browser-font' };
          if (resolution.kind === 'stub') {
            return { path: `${args.path}|${resolution.silent ? 'silent' : resolution.message}`, namespace: 'kinetograph-browser-stub' };
          }
          if (resolution.kind === 'node-path') return { path: 'path', namespace: 'kinetograph-browser-path' };
          const fromCli = await b.resolve(resolution.target, {
            resolveDir: CLI_DIR,
            kind: args.kind,
            pluginData: { kinetographBrowser: true },
          });
          if (fromCli.errors.length === 0) return fromCli;
          if (resolution.target === args.path) return undefined;
          return b.resolve(resolution.target, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { kinetographBrowser: true } });
        },
      );
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-browser-stub' }, (args) => {
        const separator = args.path.indexOf('|');
        const message = args.path.slice(separator + 1);
        return { contents: stubSource(message, message === 'silent'), loader: 'js' };
      });
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-browser-path' }, () => ({ contents: NODE_PATH_SOURCE, loader: 'js' }));
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-browser-font' }, (args) => ({ contents: googleFontModule(args.path), loader: 'js' }));
    },
  };
}

/** The esbuild options that bundle the project at `entry` for Chrome. */
export function browserBundleOptions(entry: string, settings: BrowserBundleSettings): BuildOptions {
  const absolute = resolve(entry);
  return {
    stdin: {
      contents: browserEntry(absolute, settings),
      resolveDir: dirname(absolute),
      sourcefile: 'kinetograph-browser-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: dirname(absolute),
    bundle: true,
    write: false,
    outfile: 'bundle.js',
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [entryPlugin(absolute), aliasPlugin()],
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.KINETOGRAPH_PUBLIC_DIR': JSON.stringify(settings.publicDir),
      global: 'globalThis',
    },
  };
}

function failure(errors: Message[], fallback: unknown): CliError {
  const messages = errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text));
  return new CliError('BUNDLE_FAILED', messages.length ? messages.join('\n') : String(fallback));
}

/** Bundles the project for Chrome; nothing is written. */
export async function buildBrowserBundle(entry: string, settings: BrowserBundleSettings): Promise<{ code: string; warnings: string[] }> {
  let result;
  try {
    result = await build(browserBundleOptions(entry, settings));
  } catch (error) {
    throw failure((error as { errors?: Message[] }).errors ?? [], error);
  }
  return { code: result.outputFiles![0]!.text, warnings: result.warnings.map((w) => w.text) };
}

export { familyFromModule };
