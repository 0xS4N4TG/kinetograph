import nodeModule from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps V8's compiled code of every module the calling thread loads from now on (the CLI's, the engine's, a project's
 * 4 MB bundle) under `~/.cache/kinetograph/compile-cache`, so the next run does not parse and compile them again.
 * Node 22.1 or later; `NODE_COMPILE_CACHE` names another directory and `NODE_DISABLE_COMPILE_CACHE=1` turns it off. Each
 * thread turns it on for itself, before it imports the modules it wants cached. A cache that cannot be written (a
 * read-only home) is not an error.
 */
export function useCompileCache(): void {
  try {
    nodeModule.enableCompileCache?.(join(homedir(), '.cache', 'kinetograph', 'compile-cache'));
  } catch {
    // The run goes on without.
  }
}
