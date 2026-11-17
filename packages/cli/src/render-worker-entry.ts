// The file a render worker thread starts from: the thread's compile cache is turned on before `render-worker.ts` and
// what it imports are loaded.
import { useCompileCache } from './compile-cache.js';

useCompileCache();
await import('./render-worker.js');
