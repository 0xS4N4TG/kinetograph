import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context, type BuildOptions, type Message, type Plugin } from 'esbuild';
import { CliError } from './errors.js';

/** The package directory of the CLI: the bundle's `@kinetograph/*` imports resolve from here, so one copy of each. */
export const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The `@remotion/<pkg>` packages that have a `@kinetograph/core/<pkg>` subpath (docs/AUTHORING.md §7.5). */
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
]);

export type Resolution =
  | { kind: 'path'; target: string }
  | { kind: 'font'; family: string }
  | { kind: 'unsupported'; message: string };

/** `DMSans` → `DM Sans`, `NotoSansJP` → `Noto Sans JP`, `Exo2` → `Exo 2`: the family name of a Google Fonts module. */
export function familyFromModule(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2');
}

/**
 * Where an import of a project goes, or null if the bundle resolves it as usual. `remotion` and `@remotion/*` become
 * the matching `@kinetograph/core` subpath; `@remotion/google-fonts/<Family>` becomes a generated module; the
 * `@kinetograph` packages are re-resolved from the CLI so that a project and the CLI share one copy of each.
 */
export function resolveSpecifier(specifier: string): Resolution | null {
  if (specifier === 'remotion' || specifier.startsWith('remotion/')) return { kind: 'path', target: '@kinetograph/core' };
  const remotion = /^@remotion\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (remotion) {
    const [, pkg, rest] = remotion as unknown as [string, string, string | undefined];
    if (pkg === 'google-fonts' && rest && !rest.includes('/')) return { kind: 'font', family: familyFromModule(rest) };
    if (REMOTION_PACKAGES.has(pkg)) {
      return { kind: 'path', target: `@kinetograph/core/${pkg}${rest ? `/${rest}` : ''}` };
    }
    return {
      kind: 'unsupported',
      message: `"${specifier}" is not supported by Kinetograph yet. Run \`kinetograph doctor\` for what is.`,
    };
  }
  if (/^@kinetograph\/(core|react|scene|audio|compat)(\/.*)?$/.test(specifier)) return { kind: 'path', target: specifier };
  // React too: a project with its own copy of React would otherwise bundle two, and the core's hooks would run against
  // a different React from the project's components.
  if (/^react(-reconciler)?(\/.*)?$/.test(specifier)) return { kind: 'path', target: specifier };
  return null;
}

function aliasPlugin(): Plugin {
  return {
    name: 'kinetograph-aliases',
    setup(b) {
      b.onResolve({ filter: /^(remotion($|\/)|@remotion\/|@kinetograph\/(core|react|scene|audio|compat)($|\/)|react(-reconciler)?($|\/))/ }, async (args) => {
        if (args.pluginData?.kinetograph) return undefined;
        const resolution = resolveSpecifier(args.path);
        if (!resolution) return undefined;
        if (resolution.kind === 'unsupported') return { errors: [{ text: resolution.message }] };
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
      b.onLoad({ filter: /.*/, namespace: 'kinetograph-google-font' }, (args) => ({
        contents: [
          `import { makeGoogleFont } from '@kinetograph/core/google-fonts';`,
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

/** The synthetic entry (docs/AUTHORING.md §9): the shim's side-effect module is evaluated before the project. */
export function syntheticEntry(entry: string): string {
  return [
    `import '@kinetograph/core/determinism/install';`,
    `import ${JSON.stringify(entry)};`,
    `export * from '@kinetograph/core';`,
    // Text measurement goes through the CLI's own addon: a bundle under node_modules/.cache cannot always find it.
    `export { setLayoutText } from '@kinetograph/core/layout-utils';`,
    `export { setMediaProbe } from '@kinetograph/core/media-utils';`,
    // DOM elements are laid out by the addon too (docs/COMPAT.md §5.1).
    `export { setLayoutDom } from '@kinetograph/compat/dom';`,
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
const EXTERNAL = ['@kinetograph/native', 'node-web-audio-api'];

export interface BundleResult {
  /** The written `.mjs` file. */
  file: string;
  warnings: string[];
}

/** The esbuild options that bundle the project at `absolute` (docs/AUTHORING.md §9). */
function bundleOptions(absolute: string): BuildOptions {
  return {
    stdin: {
      contents: syntheticEntry(absolute),
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
    sourcemap: 'inline',
    logLevel: 'silent',
    external: EXTERNAL,
    plugins: [aliasPlugin()],
    // Bundled CommonJS packages (react-reconciler) call `require` for Node built-ins.
    banner: { js: `import { createRequire as __kCreateRequire } from 'node:module';\nconst require = __kCreateRequire(import.meta.url);` },
  };
}

/** The error for esbuild's `errors`: one line per message, with its file and line when it has them. */
function bundleFailure(errors: Message[], fallback: unknown): CliError {
  const messages = errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text));
  return new CliError('BUNDLE_FAILED', messages.length ? messages.join('\n') : String(fallback));
}

/**
 * Bundles the project at `entry` with esbuild into `node_modules/.cache/kinetograph/`. The file name carries a hash of
 * the entry's path and one of the output, so it only changes when the code does and a changed project is re-imported
 * even by a process that has already imported the old one.
 */
export async function bundleProject(entry: string): Promise<BundleResult> {
  const absolute = resolve(entry);
  let result;
  try {
    result = await build(bundleOptions(absolute));
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
  const options = bundleOptions(resolve(entry));
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
