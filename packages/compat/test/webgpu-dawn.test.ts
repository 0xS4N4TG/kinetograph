// The Dawn WebGPU provider (src/shim/webgpu-dawn.ts) on the real library: one adapter on every machine, timestamp queries that
// measure nothing, errors that become frame warnings, devices that are destroyed when a renderer is disposed. The library is
// the `webgpu` package (dawn.node), which is not a dependency of the repo: set KINETOGRAPH_DAWN_MODULE to its folder. These
// tests are skipped, with the reason, where it is not there.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { hasAddonFunction } from '../src/addon.js';
import { DAWN_FEATURES, DAWN_LIMITS, DawnCanvasContext, dawnCommandsOf, dawnGlobals, dawnReadCommands, flushDawnCanvases, installDawn, releaseDawn, takeDawnReports } from '../src/shim/webgpu-dawn.js';

const missing = ((): string | null => {
  const spec = process.env.KINETOGRAPH_DAWN_MODULE;
  if (!spec) return 'KINETOGRAPH_DAWN_MODULE is not set (the folder of the "webgpu" package, dawn.node)';
  try {
    createRequire(import.meta.url)(spec);
    return null;
  } catch (error) {
    return `the "webgpu" package at ${spec} cannot be loaded (${(error as Error).message.split('\n')[0]})`;
  }
})();

if (missing !== null) describe('WebGPU through Dawn', () => it.skip(`skipped: ${missing}`, () => {}));

describe.skipIf(missing !== null)('WebGPU through Dawn', () => {
  const gpu = missing === null ? installDawn({ track: (work) => work, rasterize: () => null }) : null;
  const g = missing === null ? (dawnGlobals() as Record<string, any>) : {};

  it('gives every machine the same adapter: the WebGPU default limits and a fixed feature list', async () => {
    const adapter = await gpu.requestAdapter();
    expect({ ...adapter.limits }).toEqual(DAWN_LIMITS);
    const offered = [...adapter.features].filter((f: string) => f !== 'timestamp-query').sort();
    expect(offered.every((f: string) => DAWN_FEATURES.includes(f))).toBe(true);
    expect(adapter.features.has('timestamp-query')).toBe(true);
    const device = await adapter.requestDevice();
    expect(device.limits.maxTextureDimension2D).toBe(8192);
    // A limit better than the default is refused: a picture must not depend on this machine's GPU.
    await expect(adapter.requestDevice({ requiredLimits: { maxTextureDimension2D: 16384 } })).rejects.toThrow(/better than the WebGPU default/);
    await expect(adapter.requestDevice({ requiredFeatures: ['no-such-feature'] })).rejects.toThrow(/not supported/);
    device.destroy();
  });

  it('answers a timestamp query with zeros, never the time', async () => {
    const adapter = await gpu.requestAdapter();
    takeDawnReports();
    const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
    const set = device.createQuerySet({ type: 'timestamp', count: 2 });
    const resolve = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.QUERY_RESOLVE | g.GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.MAP_READ | g.GPUBufferUsage.COPY_DST });
    for (let round = 0; round < 2; round++) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({ timestampWrites: { querySet: set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
      pass.end();
      encoder.resolveQuerySet(set, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(g.GPUMapMode.READ);
      expect([...new BigUint64Array(read.getMappedRange().slice(0))]).toEqual([0n, 0n]);
      read.unmap();
    }
    // The resolve buffer has no COPY_DST, as a page's usually has not: the stand-in must not be a validation error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(takeDawnReports()).toEqual([]);
    device.destroy();
  });

  it('reports an error the page did not catch as a frame warning, once', async () => {
    takeDawnReports();
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    device.createBuffer({ size: 4, usage: 0xffff }); // an invalid usage: a validation error nobody catches
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reports = takeDawnReports();
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatch(/^WebGPU \(Dawn\): GPUValidationError/);
    expect(takeDawnReports()).toEqual([]);
    device.destroy();
  });

  it('destroys every device when the renderer is disposed, and a destroyed device is not a warning', async () => {
    takeDawnReports();
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const lost = device.lost;
    releaseDawn();
    expect((await lost).reason).toBe('destroyed');
    expect(takeDawnReports()).toEqual([]);
  });

  it('reads a canvas back as the same bytes each time, and a frame that is not drawn has no picture', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = new DawnCanvasContext({ size: () => ({ width: 8, height: 4 }) });
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
    const draw = (): void => {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.25, g: 0.5, b: 0.75, a: 1 } }] }).end();
      device.queue.submit([encoder.finish()]);
    };
    const seen: unknown[] = [];
    for (let frame = 0; frame < 3; frame++) {
      context.resetState();
      expect(context.drawn).toBe(false);
      draw();
      await flushDawnCanvases();
      expect(context.drawn).toBe(true);
      seen.push(JSON.stringify(context.picture));
    }
    // The same picture each frame (the addon keeps one version of it; without the addon it is the same pixels as text).
    expect(new Set(seen).size).toBe(1);
    // With the addon the commands only name the picture: its bytes are not in the text the scene is made of.
    if (hasAddonFunction('putCanvasPixels')) {
      expect(context.picture?.source.kind).toBe('stored');
      expect(JSON.stringify(dawnCommandsOf(context)).length).toBeLessThan(400);
    }
    context.resetState();
    await flushDawnCanvases();
    expect(context.drawn).toBe(false);
    device.destroy();
  });

  it('refuses to read a canvas the frame is still drawing, and reads it once the frame has been read back', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = new DawnCanvasContext({ size: () => ({ width: 4, height: 4 }) });
    context.configure({ device, format: 'bgra8unorm', alphaMode: 'opaque' });
    context.resetState();
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 0, a: 1 } }] }).end();
    device.queue.submit([encoder.finish()]);
    // toDataURL and toBlob take these commands: before the read-back there is no picture, and an empty one would be a lie.
    expect(() => dawnReadCommands(context)).toThrow(/read back after the scripts of a frame ran/);
    await flushDawnCanvases();
    expect(dawnReadCommands(context)).toHaveLength(1);
    device.destroy();
  });
});
