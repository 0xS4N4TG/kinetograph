// HyperFrames projects as entries: `kinetograph render <dir or index.html>`. An entry that is an HTML file, or a
// directory holding an `index.html`, is read by `plan.ts` and run by `@kinetographdev/core/hyperframes` instead of
// being bundled as TypeScript.

import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { buildPlan } from './plan.js';

/** A directory's `index.html`; any other path as it is. */
export function resolveEntry(entry: string): string {
  const absolute = resolve(entry);
  try {
    if (statSync(absolute).isDirectory()) {
      const index = join(absolute, 'index.html');
      if (existsSync(index)) return index;
      throw new CliError('ENTRY_NOT_FOUND', `${entry} is a directory without an index.html`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  return absolute;
}

/** Whether the entry is an HTML file (a HyperFrames project). */
export function isHyperframesEntry(entry: string): boolean {
  return ['.html', '.htm'].includes(extname(entry).toLowerCase());
}

let beforePlan: ((entry: string) => Promise<void>) | null = null;

/** Called with the entry before the plan is read for a bundle (the studio: download what a rebuild newly needs). */
export function setBeforePlan(hook: ((entry: string) => Promise<void>) | null): ((entry: string) => Promise<void>) | null {
  const had = beforePlan;
  beforePlan = hook;
  return had;
}

const NAMESPACE = 'kinetograph-hf';
export const HYPERFRAMES_PREFIX = `${NAMESPACE}:`;

/** A media file's length in seconds, from its container. */
function probeDuration(file: string): number | null {
  try {
    return native().probeStreams(file).durationInSeconds ?? null;
  } catch {
    return null;
  }
}

/** The module a HyperFrames project is bundled as, and the files its plan was read from. */
export interface HyperframesModule {
  contents: string;
  baseDir: string;
  files: string[];
}

/** A plan read before the bundle (`prepareHyperframes`), for the plugin to take instead of reading the project again. */
const prepared = new Map<string, HyperframesModule>();

/** Reads the project's plan and writes the module that hands it to the runtime. Throws what is wrong with the project. */
export async function hyperframesModule(path: string): Promise<HyperframesModule> {
  // A dependency the studio has not downloaded yet (a module added since the last build) is downloaded first.
  await beforePlan?.(path);
  const { plan, files, computedImports, importMap } = await buildPlan(path, { probeDuration });
  return {
    contents: [
      `import { defineHyperframes } from '@kinetographdev/core/hyperframes';`,
      // What `import()` of a computed specifier needs when the page runs (`dynamic.ts`).
      ...(computedImports ? [`globalThis[Symbol.for('kinetograph.hf.dynamic')] = ${JSON.stringify({ importMap, root: plan.baseDir, entry: path })};`] : []),
      `defineHyperframes(${JSON.stringify(plan)});`,
    ].join('\n'),
    baseDir: plan.baseDir,
    files,
  };
}

/**
 * The module of the project at `path` as the bundle will have it, read now: the bundle's key is made from it (a plan
 * is read from files and caches no one lists), and the build takes it rather than reading the project twice. Null when
 * the project cannot be read: the build reports why.
 */
export async function prepareHyperframes(path: string): Promise<HyperframesModule | null> {
  try {
    const module = await hyperframesModule(path);
    prepared.set(path, module);
    return module;
  } catch {
    return null;
  }
}

/** Drops a plan `prepareHyperframes` made and the build did not take (a cached bundle was used). */
export function forgetHyperframes(path: string): void {
  prepared.delete(path);
}

/**
 * Resolves `kinetograph-hf:<index.html>` to a module that hands the project's plan to the runtime. The files the plan
 * was read from are watched, so the studio rebuilds when one changes.
 */
export function hyperframesPlugin(): Plugin {
  return {
    name: 'kinetograph-hyperframes',
    setup(b) {
      b.onResolve({ filter: /^kinetograph-hf:/ }, (args) => ({ path: args.path.slice(HYPERFRAMES_PREFIX.length), namespace: NAMESPACE, sideEffects: true }));
      b.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        try {
          const taken = prepared.get(args.path);
          prepared.delete(args.path);
          const { contents, baseDir, files } = taken ?? (await hyperframesModule(args.path));
          return { contents, loader: 'js' as const, resolveDir: baseDir, watchFiles: files };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
    },
  };
}
