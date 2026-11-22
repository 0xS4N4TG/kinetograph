// The default engine's dispose, with the addon replaced: no project is loaded and nothing is drawn.

import { expect, it, vi } from 'vitest';

const release = vi.hoisted(() => vi.fn());
vi.mock('kinetograph', async (original) => ({
  ...(await original<typeof import('kinetograph')>()),
  native: () => ({ webglReleaseThread: release }),
}));

const { createEngine } = await import('../src/real-engine.js');

it("releases the thread's ANGLE contexts on dispose even when it made no renderer of its own", () => {
  // `render` draws through a renderer it does not keep, so dispose cannot tell from `renderer` whether this thread drew.
  createEngine({ entry: '/nowhere/index.tsx', bundleFile: null }).dispose();
  expect(release).toHaveBeenCalledOnce();
});
