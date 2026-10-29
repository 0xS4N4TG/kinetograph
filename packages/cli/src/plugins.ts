// Kinetograph plugins: packages whose package.json has a `kinetograph` field (`skill`, `panel`). They are found from the
// project: the dependencies and devDependencies of the nearest package.json above the entry, each resolved from the
// entry's directory.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

export interface PluginInfo {
  name: string;
  version: string;
  /** The SKILL.md, absolute; null when the plugin ships none. */
  skill: string | null;
  /** The panel module's source, absolute; null when the plugin has no panel. */
  panelFile: string | null;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  kinetograph?: { skill?: unknown; panel?: unknown };
}

function readJson(file: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** `node_modules/<name>` as Node finds it, looking up from `base` (the nearest ancestor that has it). */
function packageDir(base: string, name: string): string | null {
  for (let dir = base; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** A manifest path inside the package, absolute, or null when it is missing, not a file or points outside. */
function inside(root: string, path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return null;
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/** The plugins the project at `entry` (a file or a directory) depends on, by name. */
export function findPlugins(entry: string): PluginInfo[] {
  const start = resolve(entry);
  const base = existsSync(start) && statSync(start).isDirectory() ? start : dirname(start);
  let project: PackageJson | null = null;
  for (let dir = base; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      project = readJson(join(dir, 'package.json'));
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!project) return [];
  const names = [...new Set([...Object.keys(project.dependencies ?? {}), ...Object.keys(project.devDependencies ?? {})])];
  const found: PluginInfo[] = [];
  for (const name of names.sort()) {
    const root = packageDir(base, name);
    const manifest = root ? readJson(join(root, 'package.json')) : null;
    if (!root || !manifest || typeof manifest.kinetograph !== 'object' || manifest.kinetograph === null) continue;
    found.push({
      name,
      version: manifest.version ?? '0.0.0',
      skill: inside(root, manifest.kinetograph.skill),
      panelFile: inside(root, manifest.kinetograph.panel),
    });
  }
  return found;
}

/** A plugin's panel module bundled for the browser (ESM, its imports included). Throws with esbuild's message. */
export async function bundlePanel(file: string): Promise<string> {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles[0]!.text;
}
