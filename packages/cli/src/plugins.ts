// Kinetograph plugins: packages whose package.json has a `kinetograph` field (`skill`, `panel`). They are found from the
// project: the dependencies and devDependencies of the nearest package.json above the entry, each resolved from the
// entry's directory.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

export interface PluginInfo {
  name: string;
  version: string;
  /** The SKILL.md, absolute; null when the plugin ships none. */
  skill: string | null;
  /** The panel module's source, absolute; null when the plugin has no panel. */
  panelFile: string | null;
  /** The tools module's source, absolute; null when the plugin has no tools. */
  toolsFile: string | null;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  kinetograph?: { skill?: unknown; panel?: unknown; tools?: unknown };
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
      toolsFile: inside(root, manifest.kinetograph.tools),
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

/** A tool a plugin offers (contract §7). `input` is a zod 4 object schema. */
export interface PluginTool {
  name: string;
  description: string;
  input: unknown;
  run(input: unknown): unknown;
}

/** `@kinetographdev/hexed` → `hexed`; `my-fx` → `my_fx`. The prefix of a plugin's MCP tool names. */
export function pluginShortName(name: string): string {
  return name.replace(/^@[^/]+\//, '').replace(/-/g, '_');
}

/**
 * The tools of a plugin, loaded: its tools module bundled for node (ESM, its imports included) and imported. Throws with
 * a plain message when the module does not build, import or export valid tools.
 */
export async function loadPluginTools(plugin: Pick<PluginInfo, 'name' | 'toolsFile'>): Promise<PluginTool[]> {
  if (!plugin.toolsFile) return [];
  const result = await build({
    entryPoints: [plugin.toolsFile],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    banner: { js: "import { createRequire as __kgRequire } from 'node:module'; const require = __kgRequire(import.meta.url);" },
  });
  // Imported from a file: a data: URL is not loadable under every module loader. The file is removed once it is loaded.
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-tools-'));
  let loaded: { tools?: unknown };
  try {
    const file = join(dir, 'tools.mjs');
    writeFileSync(file, result.outputFiles[0]!.text);
    loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { tools?: unknown };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!Array.isArray(loaded.tools)) throw new Error('the tools module must export `tools`, an array');
  const seen = new Set<string>();
  for (const [i, tool] of (loaded.tools as Record<string, unknown>[]).entries()) {
    const at = `tools[${i}]`;
    if (typeof tool !== 'object' || tool === null) throw new Error(`${at} is not an object`);
    if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`${at}.name must be snake_case`);
    if (seen.has(tool.name)) throw new Error(`the tool "${tool.name}" appears twice`);
    seen.add(tool.name);
    if (typeof tool.description !== 'string') throw new Error(`${tool.name}: description must be a string`);
    if (typeof tool.run !== 'function') throw new Error(`${tool.name}: run must be a function`);
    if (typeof tool.input !== 'object' || tool.input === null || !('_zod' in tool.input)) {
      throw new Error(`${tool.name}: input must be a zod 4 object schema`);
    }
  }
  return loaded.tools as PluginTool[];
}

/** The MCP name of a plugin's tool. */
export function mcpToolName(plugin: Pick<PluginInfo, 'name'>, tool: Pick<PluginTool, 'name'>): string {
  return `${pluginShortName(plugin.name)}_${tool.name}`;
}

/** The MCP names of a plugin's tools; a plugin whose tools fail to load has none, and `onError` hears why. */
export async function pluginToolNames(plugin: PluginInfo, onError: (message: string) => void = () => undefined): Promise<string[]> {
  try {
    return (await loadPluginTools(plugin)).map((t) => mcpToolName(plugin, t));
  } catch (error) {
    onError(`kinetograph: the tools of ${plugin.name} did not load: ${(error as Error).message}`);
    return [];
  }
}
