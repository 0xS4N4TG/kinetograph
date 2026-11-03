// The slice of Remotion's `Internals` and `NoReactInternals` that `@remotion/effects` reads. The package is the user's
// own install (the bundle resolves it from their `node_modules`, see packages/cli/src/bundle.ts); its `import { Internals }
// from 'remotion'` is this object. Nothing else of Remotion's internals is promised.

import { createEffect, createEffectImplementation } from './effects.js';
import { processColor } from './process-color.js';

/** Remotion's `createWebGL2ContextError`: what an effect throws when its canvas gives no WebGL 2 context. */
function createWebGL2ContextError(effectName: string): Error {
  return new Error(`Failed to acquire WebGL2 context for ${effectName}.`);
}

/** Remotion's `createCurveSampler` is not part of the shim yet: `curves()` needs it. */
function createCurveSampler(): never {
  throw new Error('curves(): `createCurveSampler` is not implemented yet in Kinetograph.');
}

export const Internals = { createEffect, createEffectImplementation, createWebGL2ContextError, createCurveSampler };

export const NoReactInternals = { processColor };
