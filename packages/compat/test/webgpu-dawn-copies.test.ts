// Two projects in one process, as Studio and the MCP server have them: each project's bundle carries its own copy of the compat
// module, while the Dawn library and the addon's picture store are the process's. The copies are made here with `vi.resetModules()`,
// which evaluates the module again over the same library (Node's own module cache keeps the library).

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

type Shim = typeof import('../src/shim/webgpu-dawn.js');

const missing = ((): string | null => {
  try {
    createRequire(import.meta.url)(process.env.KINETOGRAPH_DAWN_MODULE || 'webgpu');
    return null;
  } catch (error) {
    return `the "webgpu" package cannot be loaded (${(error as Error).message.split('\n')[0]})`;
  }
})();

if (missing !== null) describe('two copies of the Dawn provider', () => it.skip(`skipped: ${missing}`, () => {}));

async function copy(): Promise<{ shim: Shim; track: ReturnType<typeof vi.fn>; gpu: any }> {
  vi.resetModules();
  const shim = await import('../src/shim/webgpu-dawn.js');
  const track = vi.fn(<T,>(work: Promise<T>) => work);
  const gpu = shim.installDawn({ track, rasterize: () => null });
  return { shim, track, gpu };
}

describe.skipIf(missing !== null)('two copies of the Dawn provider', () => {
  it('patches the library once: a second copy does not wrap the classes again', async () => {
    const a = await copy();
    const proto = (a.shim.dawnGlobals() as any).GPUBuffer.prototype;
    const [map, adapter] = [proto.mapAsync, (a.shim.dawnGlobals() as any).GPU.prototype.requestAdapter];
    await copy();
    expect(proto.mapAsync).toBe(map);
    expect((a.shim.dawnGlobals() as any).GPU.prototype.requestAdapter).toBe(adapter);
  });

  it('gives a frame the hooks of its own copy only, whichever copy patched the library', async () => {
    const a = await copy();
    const b = await copy();
    const scopeA = a.shim.createDawnScope();
    const scopeB = b.shim.createDawnScope();
    const leaveB = b.shim.enterDawnScope(scopeB);
    await (await b.gpu.requestAdapter()).requestDevice();
    leaveB();
    // The frame was B's: B waited for the adapter and the device, A heard of neither.
    expect(b.track).toHaveBeenCalled();
    expect(a.track).not.toHaveBeenCalled();
    a.track.mockClear();
    b.track.mockClear();
    const leaveA = a.shim.enterDawnScope(scopeA);
    const deviceA = await (await a.gpu.requestAdapter()).requestDevice();
    leaveA();
    expect(a.track).toHaveBeenCalled();
    expect(b.track).not.toHaveBeenCalled();
    // Each copy's scope holds only its own devices, so releasing one leaves the other's alone.
    expect(scopeA.devices.size).toBe(1);
    expect(scopeB.devices.size).toBe(1);
    a.shim.releaseDawn(scopeA);
    expect((await deviceA.lost).reason).toBe('destroyed');
    expect(scopeB.devices.size).toBe(1);
    b.shim.releaseDawn(scopeB);
  });

  it('names the pictures of the canvases of two copies apart, so that releasing one copy lets go of no picture of the other', async () => {
    const a = await copy();
    const b = await copy();
    const size = () => ({ width: 4, height: 4 });
    const keys = [new a.shim.DawnCanvasContext({ size }), new b.shim.DawnCanvasContext({ size }), new a.shim.DawnCanvasContext({ size }), new b.shim.DawnCanvasContext({ size })].map((context) => (context as any).key as string);
    expect(new Set(keys).size).toBe(4);
  });
});
