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
          const { plan, files } = await buildPlan(args.path, { probeDuration });
          return {
            contents: [
              `import { defineHyperframes } from '@kinetographdev/core/hyperframes';`,
              `defineHyperframes(${JSON.stringify(plan)});`,
            ].join('\n'),
            loader: 'js' as const,
            resolveDir: plan.baseDir,
            watchFiles: files,
          };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
    },
  };
}
