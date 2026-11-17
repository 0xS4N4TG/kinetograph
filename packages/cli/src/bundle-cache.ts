// A bundle that is already built and whose inputs have not changed is used as it is, instead of building it again (the
// build of the 4 MB bundle is 0.1 to 0.2 s of every render). What a build read is written beside the bundle: each file
// esbuild loaded (its metafile) and each the plugins say they read (`watchFiles`), with its modification time and size.
// The bundle is used again only when
//   - esbuild, the options, and the CLI's own code (the plugins) are the ones that built it,
//   - every file it read is as it was, and so are the directories and package files its resolution looked in (a file
//     added next to an import changes which file the import means), and
//   - for a HyperFrames project, the module its plan makes (which reads files and caches the files do not list) is the same.
// Any mismatch builds again. A file is also known by a hash of its bytes: modification times are whole seconds (or two)
// on some file systems, and a restore can keep them, so a same-size edit in the same second would not show in them. A
// file modified while a build ran may have been read before or after, so a build with an input modified within the last
// 2.5 s (a coarse clock's rounding) is not recorded.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildOptions, Metafile, Plugin } from 'esbuild';
import { version as esbuildVersion } from 'esbuild';
import { UNCACHEABLE } from './css.js';

/**
 * A file or directory as a build found it: `size` is -1 for a directory (which has no hash), and a path that is not there
 * is `absent`: a path the build looked for and did not find is stamped too, as one created later changes the build.
 */
type Stamp = [path: string, mtimeMs: number, size: number, hash: string] | [path: string, absent: true];

interface KeyRecord {
  format: 1;
  /** What the bundle was built with: esbuild, the options, the CLI's code, and the plan's module. */
  recipe: string;
  /** The bundle's file name in the cache directory. */
  file: string;
  warnings: string[];
  inputs: Stamp[];
}

/** The CLI's own files (the plugins are code here): a build by other code is not used. */
function cliStamp(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parts: string[] = [];
  for (const dir of [here, join(here, 'hyperframes')]) {
    for (const name of readdirSync(dir).sort()) {
      if (!/\.(js|ts)$/.test(name)) continue;
      const info = statSync(join(dir, name));
      parts.push(`${name}:${info.mtimeMs}:${info.size}`);
    }
  }
  return parts.join(',');
}

/** What a build is made from other than the files it reads. `module` is a HyperFrames project's module, which the plugin makes from a plan. */
export function recipeOf(options: BuildOptions, module: string | null): string {
  // Functions (the plugins' hooks) are left out of the text; the plugins' names and the CLI's code stand for them.
  const text = JSON.stringify({ esbuild: esbuildVersion, node: process.version, options, plugins: (options.plugins ?? []).map((p) => p.name), cli: cliStamp(), module });
  return createHash('sha256').update(text).digest('hex');
}

const hashOf = (path: string): string => {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('base64');
  } catch {
    return '';
  }
};

function stampOf(path: string): Stamp {
  try {
    const info = statSync(path);
    return info.isDirectory() ? [path, info.mtimeMs, -1, ''] : [path, info.mtimeMs, info.size, hashOf(path)];
  } catch {
    return [path, true];
  }
}

/** Whether `path` is as `before` stamped it. The bytes are read only when the time and size say nothing changed. */
function unchanged(before: Stamp): boolean {
  let info;
  try {
    info = statSync(before[0]);
  } catch {
    return before.length === 2;
  }
  if (before.length === 2) return false;
  if (info.mtimeMs !== before[1]) return false;
  if (info.isDirectory()) return before[2] === -1;
  return info.size === before[2] && hashOf(before[0]) === before[3];
}

/** Where a metafile input lies: relative to the working directory for a file; a plugin's namespace names its path after a colon. Null for one that is no file. */
function inputPath(key: string, workingDir: string): string | null {
  const named = /^([A-Za-z][\w-]+):(.*)$/s.exec(key);
  if (named === null) return resolve(workingDir, key);
  const [, , path] = named as unknown as [string, string, string];
  return isAbsolute(path) ? path : null;
}

/**
 * The files a build depends on, from what it read: each input, each file a plugin watches, the directories of the
 * project's own inputs (a file added or removed there is a change), the `package.json` that governs each input, and the
 * `tsconfig.json` and `node_modules` of each directory above them.
 */
function dependencies(metafile: Metafile, workingDir: string, watched: string[]): string[] {
  const files = new Set<string>(watched);
  for (const key of Object.keys(metafile.inputs)) {
    const path = inputPath(key, workingDir);
    if (path !== null) files.add(path);
  }
  const all = new Set<string>(files);
  const dirs = new Set<string>();
  const governed = new Map<string, string | null>();
  /** The `package.json` that governs `dir`: the nearest one up the tree. */
  const packageOf = (dir: string): string | null => {
    const known = governed.get(dir);
    if (known !== undefined) return known;
    const own = join(dir, 'package.json');
    const found = existsSync(own) ? own : dirname(dir) === dir ? null : packageOf(dirname(dir));
    governed.set(dir, found);
    return found;
  };
  for (const file of files) {
    const dir = dirname(file);
    const manifest = packageOf(dir);
    if (manifest !== null) all.add(manifest);
    if (dir.includes(`${sep}node_modules${sep}`)) continue;
    // A project's own directory: files added to it, and the places a bare import is looked for, change what a build finds.
    for (let up = dir; !dirs.has(up); up = dirname(up)) {
      dirs.add(up);
      all.add(join(up, 'tsconfig.json'));
      all.add(join(up, 'jsconfig.json'));
      all.add(join(up, 'node_modules'));
      if (dirname(up) === up) break;
    }
    all.add(dir);
  }
  return [...all].sort();
}

/** `watchFiles` and `watchDirs` the plugins' hooks return, collected while a build runs. */
export class Watched {
  readonly files = new Set<string>();
  /** A plugin made something from files no list names (Tailwind's classes): the build cannot be reused. */
  uncacheable = false;

  /** `plugin`, whose hooks' `watchFiles` and `watchDirs` are noted here. */
  record(plugin: Plugin): Plugin {
    const note = (result: unknown): void => {
      const found = result as { watchFiles?: string[]; watchDirs?: string[]; pluginData?: Record<string, unknown> } | null | undefined;
      if (found?.pluginData?.[UNCACHEABLE] === true) this.uncacheable = true;
      for (const file of found?.watchFiles ?? []) this.files.add(file);
      for (const dir of found?.watchDirs ?? []) this.files.add(dir);
    };
    return {
      name: plugin.name,
      setup: (build) => {
        const wrapped = new Proxy(build, {
          get: (target, name) => {
            if (name !== 'onLoad' && name !== 'onResolve') {
              const value = Reflect.get(target, name);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (options: unknown, callback: (args: unknown) => unknown) =>
              (target[name] as (o: unknown, c: unknown) => void)(options, async (args: unknown) => {
                const result = await callback(args);
                note(result);
                return result;
              });
          },
        });
        return plugin.setup(wrapped);
      },
    };
  }
}

/** The bundle a build left in `keyFile` when it is still the one the same build would make, or null. */
export function cachedBundle(keyFile: string, recipe: string, directory: string): { file: string; warnings: string[] } | null {
  let record: KeyRecord;
  try {
    record = JSON.parse(readFileSync(keyFile, 'utf8')) as KeyRecord;
  } catch {
    return null;
  }
  if (record.format !== 1 || record.recipe !== recipe || !existsSync(join(directory, record.file))) return null;
  for (const before of record.inputs) if (!unchanged(before)) return null;
  return { file: record.file, warnings: record.warnings };
}

/** Writes what a build read beside its bundle, unless an input changed while it ran (then no later build can tell what it read). */
export function recordBundle(
  keyFile: string,
  recipe: string,
  file: string,
  warnings: string[],
  build: { metafile: Metafile; workingDir: string; watched: Watched; startedAt: number },
): void {
  if (build.watched.uncacheable) return;
  const stamps = dependencies(build.metafile, build.workingDir, [...build.watched.files]).map(stampOf);
  // The file systems' clocks are coarse (a second, or two on FAT): a change within this much of the build's start may
  // have come after the read, and its time would not say so.
  const margin = 2500;
  if (stamps.some((s) => s.length === 4 && s[1] > build.startedAt - margin)) return;
  const record: KeyRecord = { format: 1, recipe, file, warnings, inputs: stamps };
  const temporary = `${keyFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, keyFile);
}
