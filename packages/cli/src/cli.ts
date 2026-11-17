#!/usr/bin/env node
import { useCompileCache } from './compile-cache.js';

useCompileCache();
// Loaded after the cache is on, so the CLI's own modules are cached too.
const { run } = await import('./run.js');
const code = await run(process.argv.slice(2));
// Wait for stdout to drain before leaving: a render that has the addon's threads or a project's handles open would
// otherwise keep the process alive, and exiting at once could cut a large JSON result short.
await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
process.exit(code);
