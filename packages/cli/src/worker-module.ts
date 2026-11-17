// A module worker with imports (`new Worker(url, { type: 'module' })` of a file that imports another) is run by the shim
// as one classic script: esbuild bundles the file and everything it imports into an IIFE. The worker's own files are the
// project's, so its imports resolve the way the project's do.

import { dirname } from 'node:path';
import { buildSync } from 'esbuild';

export function bundleWorkerModule(file: string | null, code: string, url: string): string {
  const result = buildSync({
    stdin: { contents: code, sourcefile: file ?? url, resolveDir: file === null ? (process.env.KINETOGRAPH_BASE_DIR ?? process.cwd()) : dirname(file), loader: /\.[cm]?tsx?$/.test(file ?? '') ? 'ts' : 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}
