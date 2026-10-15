// `.css` imports (docs/ENGINE.md §1, docs/COMPAT.md §2): the bundle collects each imported stylesheet's text, with its
// local `@import`s inlined and its relative `url()`s made absolute, and hands it to the DOM engine as a stylesheet.
// Tailwind's own `@tailwind` / `@import "tailwindcss"` files are built with the project's Tailwind when it has one;
// CSS modules (`*.module.css`) get their class names scoped and exported.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'esbuild';

/** Whether the file asks for Tailwind to build it. */
export function usesTailwind(css: string): boolean {
  return (
    /@tailwind\s+(base|components|utilities|variants)\b/.test(css) ||
    /@import\s+(url\()?\s*['"]tailwindcss(\/[^'"]*)?['"]/.test(css) ||
    (/@(apply|theme|plugin|config)\b/.test(css) && /tailwind/i.test(css))
  );
}

/** The nearest directory with a package.json at or above `from`. */
export function projectRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

// ---- Tailwind ----

/** The extensions whose text is scanned for class names. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.mdx', '.md', '.svelte', '.vue']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.cache', '.next', 'coverage']);

/** The class-name candidates in the project's source files: every run of characters Tailwind could take a class from. */
export function scanCandidates(root: string): string[] {
  const found = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path, depth + 1);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && statSync(path).size <= 1 << 20) {
        for (const token of readFileSync(path, 'utf8').match(/[^\s"'`<>{};,]+/g) ?? []) found.add(token);
      }
    }
  };
  visit(root, 0);
  return [...found];
}

/** Tailwind 4 through its own `compile()` API (what its CLI and plugins call), scanning the sources in JS. */
async function buildTailwindV4(file: string, root: string): Promise<{ css: string } | { error: string }> {
  const require = createRequire(join(root, 'package.json'));
  let tailwind: { compile?(css: string, options: object): Promise<{ build(candidates: string[]): string }> };
  let pkgDir: string;
  try {
    pkgDir = dirname(require.resolve('tailwindcss/package.json'));
    tailwind = require('tailwindcss');
  } catch {
    return { error: 'tailwindcss is not installed in the project' };
  }
  if (typeof tailwind.compile !== 'function') return { error: 'the installed tailwindcss is not version 4 (it has no compile())' };
  const stylesheet = (id: string, base: string): string => {
    if (id === 'tailwindcss') return join(pkgDir, 'index.css');
    if (id.startsWith('tailwindcss/')) {
      const rest = id.slice('tailwindcss/'.length);
      return join(pkgDir, rest.endsWith('.css') ? rest : `${rest}.css`);
    }
    if (id.startsWith('.') || isAbsolute(id)) return resolve(base, id);
    return createRequire(join(base, 'x.js')).resolve(id);
  };
  try {
    const compiler = await tailwind.compile(readFileSync(file, 'utf8'), {
      base: dirname(file),
      loadStylesheet: async (id: string, base: string) => {
        const path = stylesheet(id, base);
        return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
      },
      loadModule: async (id: string, base: string) => {
        const path = id.startsWith('.') ? resolve(base, id) : createRequire(join(base, 'x.js')).resolve(id);
        const loaded = await import(pathToFileURL(path).href);
        return { path, base: dirname(path), module: loaded.default ?? loaded };
      },
    });
    return { css: compiler.build(scanCandidates(root)) };
  } catch (error) {
    return { error: `tailwindcss compile() failed: ${(error as Error).message.split('\n')[0]}` };
  }
}

/**
 * Builds `file` with the project's Tailwind: its CLI (`tailwindcss` v3, or `@tailwindcss/cli` v4) if installed, else
 * Tailwind 4's `compile()`, else PostCSS with the Tailwind plugin.
 */
export async function buildTailwind(file: string): Promise<{ css: string } | { error: string }> {
  const root = projectRoot(dirname(file));
  const bin = join(root, 'node_modules', '.bin', 'tailwindcss');
  const failures: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), 'kinetograph-tailwind-'));
  try {
    if (existsSync(bin)) {
      const out = join(tmp, 'out.css');
      try {
        execFileSync(bin, ['-i', file, '-o', out], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
        return { css: readFileSync(out, 'utf8') };
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
        failures.push(`tailwindcss failed: ${(stderr ?? (error as Error).message).split('\n').slice(0, 3).join(' ')}`);
      }
    }
    const v4 = await buildTailwindV4(file, root);
    if ('css' in v4) return v4;
    failures.push(v4.error);
    // PostCSS with the plugin: Tailwind 4's `@tailwindcss/postcss`, else Tailwind 3's own plugin. `process` is
    // asynchronous, so it runs in a child.
    try {
      const script = `
        const { createRequire } = require('node:module');
        const r = createRequire(${JSON.stringify(join(root, 'package.json'))});
        const postcss = r('postcss');
        let plugin; try { plugin = r('@tailwindcss/postcss')(); } catch { plugin = r('tailwindcss')(); }
        postcss([plugin]).process(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'), { from: ${JSON.stringify(file)} })
          .then((result) => process.stdout.write(result.css), (e) => { process.stderr.write(String((e && e.message) || e)); process.exit(1); });
      `;
      const css = execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      return { css };
    } catch (error) {
      const message = (error as { stderr?: Buffer }).stderr?.toString().trim() || (error as Error).message;
      failures.push(`postcss: ${message.split('\n')[0]}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    error:
      `${file} uses Tailwind, but the project has none that can build it (${failures.join('; ')}). ` +
      'Install tailwindcss (v3) or @tailwindcss/cli (v4) in the project, or import the built CSS file instead.',
  };
}

// ---- reading a stylesheet ----

/** A CSS string/comment-aware scan for `@import` rules at the top level. */
const IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/g;

const isRemote = (target: string): boolean => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target) || target.startsWith('#');

/** Rewrites `url(relative)` to `url("<absolute>")` when the file exists next to `base`; `rewrite` maps it from there. */
export function absolutizeUrls(css: string, base: string, rewrite: (absolute: string) => string = (a) => a): string {
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (match, _quote: string, target: string) => {
    const t = target.trim();
    if (t === '' || isRemote(t)) return match;
    const absolute = isAbsolute(t) ? t : resolve(base, t.split(/[?#]/)[0]!);
    if (!existsSync(absolute.split(/[?#]/)[0]!)) return match;
    const suffix = /[?#].*$/.exec(t)?.[0] ?? '';
    return `url("${rewrite(absolute) + suffix}")`;
  });
}

export interface ReadCss {
  css: string;
  /** Every file read, for the bundler to watch. */
  files: string[];
  warnings: string[];
}

/** The stylesheet at `file` with its local `@import`s inlined (media queries on an import wrap the inlined text). */
export function readStylesheet(file: string, rewriteUrl?: (absolute: string) => string, seen = new Set<string>()): ReadCss {
  const files = [file];
  const warnings: string[] = [];
  seen.add(file);
  let css = readFileSync(file, 'utf8');
  css = css.replace(IMPORT, (match, _quote: string, target: string, tail: string) => {
    if (isRemote(target)) return match;
    // Tailwind's entry is built by Tailwind, not inlined.
    if (/^tailwindcss(\/|$)/.test(target)) return '';
    // A bare name is a package (`@import 'normalize.css'`), a relative one a file.
    let path: string | null = null;
    if (target.startsWith('.') || isAbsolute(target)) path = resolve(dirname(file), target);
    else {
      try {
        path = createRequire(file).resolve(target);
      } catch {
        const beside = resolve(dirname(file), target);
        path = existsSync(beside) ? beside : null;
      }
    }
    if (path !== null && !/\.css$/i.test(path)) path = null;
    if (path === null || !existsSync(path)) {
      warnings.push(`${file}: @import "${target}" was not found`);
      return '';
    }
    if (seen.has(path)) return '';
    const inner = readStylesheet(path, rewriteUrl, seen);
    files.push(...inner.files);
    warnings.push(...inner.warnings);
    const media = tail.trim();
    return media === '' ? inner.css : `@media ${media} {\n${inner.css}\n}`;
  });
  return { css: absolutizeUrls(css, dirname(file), rewriteUrl), files, warnings };
}

// ---- CSS modules ----

/** Scopes the class names of `css` (`.title` → `.title_3f9a1c`) and returns the mapping. `:global(.x)` is left alone. */
export function scopeModule(css: string, file: string): { css: string; exports: Record<string, string> } {
  const hash = createHash('sha256').update(file).digest('hex').slice(0, 6);
  const exports: Record<string, string> = {};
  // Hide strings, comments and url() so a `.png` or `.5` in them is not taken for a class.
  const hidden: string[] = [];
  const hide = (text: string): string => {
    hidden.push(text);
    return `\u0000${hidden.length - 1}\u0000`;
  };
  let masked = css
    .replace(/\/\*[\s\S]*?\*\//g, hide)
    .replace(/url\([^)]*\)/g, hide)
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, hide);
  masked = masked.replace(/:global\(([^)]*)\)/g, (_m, inner: string) => hide(inner));
  // Only selectors: text before a `{`. Declarations (`1.5em`) have no letter right after the dot in a class position.
  masked = masked.replace(/([^{};]*)\{/g, (whole, selector: string) => {
    if (/^\s*@(?!media|supports|container|layer)/.test(selector)) return whole;
    return (
      selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (_m, name: string) => {
        const scoped = `${name}_${hash}`;
        exports[name] = scoped;
        return `.${scoped}`;
      }) + '{'
    );
  });
  const restored = masked.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => hidden[Number(i)]!);
  return { css: restored, exports };
}

// ---- the esbuild plugin ----

export type CssTarget = 'node' | 'browser';

export interface CssPluginOptions {
  target: CssTarget;
  /** For `browser`: the URL a local file is served at (the driver's `/@file`). */
  fileUrl?: (absolute: string) => string;
}

/** Turns each imported `.css` into a module that registers its text (Node) or adds a `<style>` (Chrome). */
export function cssPlugin(options: CssPluginOptions): Plugin {
  return {
    name: 'kinetograph-css',
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, async (args) => {
        const warnings: { text: string }[] = [];
        const read = readStylesheet(args.path, options.target === 'browser' ? options.fileUrl : undefined);
        for (const text of read.warnings) warnings.push({ text });
        let css = read.css;
        const files = [...read.files];
        if (usesTailwind(readFileSync(args.path, 'utf8'))) {
          const built = await buildTailwind(args.path);
          if ('css' in built) {
            css = absolutizeUrls(built.css, dirname(args.path), options.target === 'browser' ? options.fileUrl : undefined);
          } else {
            warnings.push({ text: built.error });
            if (options.target === 'node') {
              const note = `noteStylesheetProblem(${JSON.stringify(built.error)});`;
              return finish(options, args.path, css, {}, files, warnings, note);
            }
          }
        }
        let exports: Record<string, string> = {};
        if (/\.module\.css$/.test(args.path)) {
          const scoped = scopeModule(css, args.path);
          css = scoped.css;
          exports = scoped.exports;
        }
        return finish(options, args.path, css, exports, files, warnings, '');
      });
    },
  };
}

function finish(
  options: CssPluginOptions,
  file: string,
  css: string,
  exports: Record<string, string>,
  files: string[],
  warnings: { text: string }[],
  extra: string,
) {
  const text = JSON.stringify(css);
  const lines: string[] = [];
  if (options.target === 'node') {
    lines.push(`import { registerStylesheet, noteStylesheetProblem } from '@kinetograph/compat/dom';`);
    lines.push(`void noteStylesheetProblem;`);
    if (extra) lines.push(extra);
    lines.push(`registerStylesheet(${text}, ${JSON.stringify(file)});`);
  } else {
    lines.push(`const style = document.createElement('style');`);
    lines.push(`style.setAttribute('data-kg-file', ${JSON.stringify(file)});`);
    lines.push(`style.textContent = ${text};`);
    lines.push(`document.head.appendChild(style);`);
  }
  lines.push(`const classes = ${JSON.stringify(exports)};`, `export default classes;`);
  for (const name of Object.keys(exports)) {
    if (/^[A-Za-z_$][\w$]*$/.test(name)) lines.push(`export const ${name} = classes[${JSON.stringify(name)}];`);
  }
  return {
    contents: lines.join('\n'),
    loader: 'js' as const,
    resolveDir: dirname(file),
    watchFiles: files,
    warnings,
  };
}
