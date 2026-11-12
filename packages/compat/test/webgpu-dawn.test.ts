// The Dawn WebGPU provider (src/shim/webgpu-dawn.ts) on the real library: one adapter on every machine, timestamp queries that
// measure nothing, errors that become frame warnings, devices that are destroyed when a renderer is disposed. The library is
// the `webgpu` package (dawn.node), which is not a dependency of the repo: set KINETOGRAPH_DAWN_MODULE to its folder. These
// tests are skipped, with the reason, where it is not there.

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { CANVAS_SOURCE } from '@kinetographdev/scene';
import { carryDepends, carryNeedsReplay, resetCarry } from '../src/shim/webgpu-dawn-carry.js';
import { hasAddonFunction } from '../src/addon.js';
import { DAWN_FEATURES, DAWN_LIMITS, DawnCanvasContext, createDawnScope, dawnCommandsOf, dawnGlobals, dawnPictureSource, dawnReadCommands, duringAnimationFrames, enterDawnScope, flushDawnCanvases, installDawn, noteDawnRewind, releaseDawn, setDawnClock, takeDawnReports } from '../src/shim/webgpu-dawn.js';

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

/** The engine's clock for the carry rules (`setDawnClock`), set by hand: the epoch of the frame a test is in. */
function engineClock(): { mockReturnValue(at: number): void; mockRestore(): void } {
  let at = 0;
  setDawnClock(() => at);
  return { mockReturnValue: (value) => { at = value; }, mockRestore: () => setDawnClock(() => 0) };
}

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
    // The resolve buffer has no COPY_DST, as a page's usually has not: the stand-in must not be a validation error. It is said, once, that the
    // results are zeros (both rounds resolved one).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const said = takeDawnReports();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/a timestamp query is a stand-in here: its results are zeros/);
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

  it('forgets what the frames of a composition read of each other when its devices are released, and starts a renderer without it', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const clock = engineClock();
    const buffer = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.STORAGE | g.GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> b: array<f32>; @compute @workgroup_size(1) fn main() { b[0] = b[0] + 1.0; }' });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const step = (at: number): void => {
      clock.mockReturnValue(at);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] }));
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    resetCarry();
    step(0);
    step(33);
    expect(carryDepends()).toBe(true);
    releaseDawn();
    expect(carryDepends()).toBe(false);
    expect(carryNeedsReplay()).toBe(false);
    step(0);
    step(33);
    expect(carryDepends()).toBe(true);
    // A renderer made now has a state of its own: what the frames of the one before it read is not in it.
    const leave = enterDawnScope(createDawnScope());
    expect(carryDepends()).toBe(false);
    leave();
    expect(carryDepends()).toBe(true);
    clock.mockRestore();
    device.destroy();
  });

  it('keeps the devices, canvases and pictures of one renderer when another on the same thread releases its own', async () => {
    const draw = async (device: any, context: DawnCanvasContext, clear: number): Promise<void> => {
      context.resetState();
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: clear, g: 0, b: 0, a: 1 } }] }).end();
      device.queue.submit([encoder.finish()]);
      await flushDawnCanvases();
    };
    const open = async () => {
      const scope = createDawnScope();
      const leave = enterDawnScope(scope);
      const device = await (await gpu.requestAdapter()).requestDevice();
      let lost = false;
      void device.lost.then(() => { lost = true; });
      const context = new DawnCanvasContext({ size: () => ({ width: 4, height: 4 }) });
      context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
      await draw(device, context, 0.5);
      leave();
      return { scope, device, context, isLost: () => lost };
    };
    const [a, b] = [await open(), await open()];
    // `release` of B's scope, by the frame loop's `dispose`, destroys B's device and nothing of A's.
    releaseDawn(b.scope);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(b.isLost()).toBe(true);
    expect(a.isLost()).toBe(false);
    // A still draws, and the picture it holds is still there: the same bytes again are "the same picture as the newest version" for the addon.
    const leave = enterDawnScope(a.scope);
    await draw(a.device, a.context, 0.5);
    expect(a.context.drawn).toBe(true);
    if (hasAddonFunction('putCanvasPixels')) {
      const kept = JSON.stringify(a.context.picture);
      await draw(a.device, a.context, 0.5);
      expect(JSON.stringify(a.context.picture)).toBe(kept);
      expect(JSON.parse(kept).source.version).toBe(1);
    }
    leave();
    releaseDawn(a.scope);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(a.isLost()).toBe(true);
    expect(takeDawnReports()).toEqual([]);
  });

  it('dates what a frame reads and writes by the engine clock, not by the page\'s performance.now', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const clock = engineClock();
    // A page that replaced performance.now (or the real one, once the engine's determinism is uninstalled) must not move the frames' dates.
    const real = performance.now;
    performance.now = () => 5;
    try {
      const U = g.GPUTextureUsage;
      const make = () => device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_DST });
      const [a, b] = [make(), make()];
      const copy = (): void => {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture({ texture: a }, { texture: b }, [4, 4]);
        device.queue.submit([encoder.finish()]);
      };
      resetCarry();
      clock.mockReturnValue(0);
      for (const texture of [a, b]) {
        const encoder = device.createCommandEncoder();
        encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
        device.queue.submit([encoder.finish()]);
      }
      clock.mockReturnValue(33);
      copy();
      expect(carryNeedsReplay()).toBe(true);
    } finally {
      performance.now = real;
      clock.mockRestore();
      device.destroy();
    }
  });

  it('says a jump back shows old state unless every device that carried state was made again', async () => {
    const scope = createDawnScope();
    const leave = enterDawnScope(scope);
    const clock = engineClock();
    const open = async () => (await gpu.requestAdapter()).requestDevice();
    const module = (device: any) => device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> b: array<f32>; @compute @workgroup_size(1) fn main() { b[0] = b[0] + 1.0; }' });
    /** A compute device with a particle buffer a pass advances in place: its state carries. */
    const particles = async () => {
      const device = await open();
      const buffer = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.STORAGE | g.GPUBufferUsage.COPY_DST });
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: module(device), entryPoint: 'main' } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
      return (at: number): void => {
        clock.mockReturnValue(at);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
        device.queue.submit([encoder.finish()]);
      };
    };
    /** A render device the page makes at each mount: it writes a texture every frame and carries nothing. */
    const render = async () => {
      const device = await open();
      const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: g.GPUTextureUsage.RENDER_ATTACHMENT });
      return (at: number): void => {
        clock.mockReturnValue(at);
        const encoder = device.createCommandEncoder();
        encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
        device.queue.submit([encoder.finish()]);
      };
    };
    takeDawnReports();
    // A compute device made once (module scope) and a render device made per mount: the frames before the rewind carry state in the first.
    resetCarry();
    const computeOnce = await particles();
    const renderFirst = await render();
    for (const at of [0, 33, 66]) { computeOnce(at); renderFirst(at); }
    expect(carryDepends()).toBe(true);
    // The rewind starts the composition over: the render device is made again, the compute device is the same one, which holds frame 66's particles.
    noteDawnRewind();
    const renderAgain = await render();
    clock.mockReturnValue(0);
    renderAgain(0);
    computeOnce(10);
    expect(takeDawnReports().join('\n')).toMatch(/a jump back to an earlier frame on a page whose GPU state carries/);
    // Every device that carried made again: nothing to say.
    noteDawnRewind();
    const computeAgain = await particles();
    const renderThird = await render();
    for (const at of [0, 33]) { computeAgain(at); renderThird(at); }
    expect(takeDawnReports()).toEqual([]);
    // A device that carried and is not used after the rewind (the page dropped it) is not either.
    noteDawnRewind();
    (await render())(0);
    expect(takeDawnReports()).toEqual([]);
    clock.mockRestore();
    leave();
    releaseDawn(scope);
  });

  it('says a device is the fixed adapter\'s, not this machine\'s', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    expect(device.adapterInfo.vendor).toBe('kinetograph');
    expect(device.adapterInfo.description).toBe('Kinetograph (Dawn)');
    expect(adapter.info.vendor).toBe('kinetograph');
    device.destroy();
  });

  describe('copyExternalImageToTexture', () => {
    const picture = (width: number, height: number, rgba: number[]) => ({
      [CANVAS_SOURCE as symbol]: () => ({ source: { kind: 'pixels', width, height, data: Buffer.from(rgba).toString('base64') }, width, height }),
    });
    /** The bytes of a texture of `bytes` per pixel, read back row by row. */
    const readTexture = async (device: any, texture: any, width: number, height: number, bytes: number): Promise<Uint8Array> => {
      const buffer = device.createBuffer({ size: 256 * height, usage: g.GPUBufferUsage.MAP_READ | g.GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [width, height, 1]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(g.GPUMapMode.READ);
      const all = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      const out = new Uint8Array(width * height * bytes);
      for (let y = 0; y < height; y++) out.set(all.subarray(y * 256, y * 256 + width * bytes), y * width * bytes);
      return out;
    };
    const setup = async (format: string, width = 2, height = 1) => {
      const device = await (await gpu.requestAdapter()).requestDevice();
      const texture = device.createTexture({ size: [width, height], format, usage: g.GPUTextureUsage.COPY_DST | g.GPUTextureUsage.COPY_SRC | g.GPUTextureUsage.RENDER_ATTACHMENT | g.GPUTextureUsage.TEXTURE_BINDING });
      return { device, texture, copy: (source: any, size: any = [width, height], extra: any = {}) => device.queue.copyExternalImageToTexture(source, { texture, ...extra }, size) };
    };
    // red, then half-transparent blue
    const two = picture(2, 1, [255, 0, 0, 255, 0, 0, 255, 128]);

    it('writes each destination format its own bytes', async () => {
      const cases: [string, number, number[]][] = [
        ['rgba8unorm', 4, [255, 0, 0, 255, 0, 0, 255, 128]],
        ['rgba8unorm-srgb', 4, [255, 0, 0, 255, 0, 0, 255, 128]],
        ['bgra8unorm', 4, [0, 0, 255, 255, 255, 0, 0, 128]],
        ['r8unorm', 1, [255, 0]],
        ['rg8unorm', 2, [255, 0, 0, 0]],
        // 1.0 is 0x3c00 in half floats and 0 is 0 (the last two bytes, 128/255, are not compared)
        ['rgba16float', 8, [0x00, 0x3c, 0, 0, 0, 0, 0x00, 0x3c, 0, 0, 0, 0, 0x00, 0x3c, 0x01, 0x38]],
        ['r32float', 4, [0, 0, 0x80, 0x3f, 0, 0, 0, 0]],
        ['rgb10a2unorm', 4, [0xff, 0x03, 0, 0xc0, 0, 0, 0xf0, 0xbf]],
      ];
      for (const [format, bytes, expected] of cases) {
        const { device, texture, copy } = await setup(format);
        copy({ source: two });
        const got = [...(await readTexture(device, texture, 2, 1, bytes))];
        if (format === 'rgba16float') expect(got.slice(0, 14)).toEqual(expected.slice(0, 14));
        else expect(got, format).toEqual(expected);
        device.destroy();
      }
    });

    it('writes a whole picture as it is and a part of it the same pixels', async () => {
      // The whole picture takes the direct path (no flip, no premultiplication, no origin); a rectangle of a larger one the copying path.
      const rgba = Array.from({ length: 4 * 3 * 4 }, (_, i) => (i * 7) % 256);
      const whole = await setup('rgba8unorm', 4, 3);
      whole.copy({ source: picture(4, 3, rgba) }, [4, 3]);
      expect([...(await readTexture(whole.device, whole.texture, 4, 3, 4))]).toEqual(rgba);
      const part = await setup('rgba8unorm', 2, 3);
      part.copy({ source: picture(4, 3, rgba), origin: [0, 0] }, [2, 3]);
      const left = [0, 1, 2].flatMap((y) => rgba.slice(y * 16, y * 16 + 8));
      expect([...(await readTexture(part.device, part.texture, 2, 3, 4))]).toEqual(left);
      whole.device.destroy();
      part.device.destroy();
    });

    it('premultiplies and flips as asked, and copies the rectangle at the origin', async () => {
      const four = picture(2, 2, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 128]);
      const { device, texture, copy } = await setup('rgba8unorm', 2, 1);
      copy({ source: four, origin: [0, 1] }, [2, 1]);
      expect([...(await readTexture(device, texture, 2, 1, 4))]).toEqual([70, 80, 90, 255, 100, 110, 120, 128]);
      device.queue.copyExternalImageToTexture({ source: four, origin: [0, 1] }, { texture, premultipliedAlpha: true }, [2, 1]);
      expect([...(await readTexture(device, texture, 2, 1, 4))]).toEqual([70, 80, 90, 255, 50, 55, 60, 128]);
      device.destroy();
      // flipY turns the rectangle upside down
      const flipped = await setup('rgba8unorm', 2, 2);
      flipped.copy({ source: four, flipY: true });
      expect([...(await readTexture(flipped.device, flipped.texture, 2, 2, 4))]).toEqual([70, 80, 90, 255, 100, 110, 120, 128, 10, 20, 30, 255, 40, 50, 60, 255]);
      flipped.device.destroy();
    });

    it('refuses a negative origin, a rectangle outside the source and a destination format it cannot write, as the spec does', async () => {
      const { device, copy } = await setup('rgba8unorm');
      expect(() => copy({ source: two, origin: [-1, 0] }, [1, 1])).toThrow(TypeError);
      expect(() => copy({ source: two, origin: { x: 0, y: -2 } }, [1, 1])).toThrow(/origin.y/);
      for (const [origin, size] of [[[1, 0], [2, 1]], [[0, 0], [3, 1]], [[0, 1], [1, 1]]] as const) {
        let error: any;
        try { copy({ source: two, origin }, size); } catch (e) { error = e; }
        expect(error?.name, `${origin} ${size}`).toBe('OperationError');
        expect(error.message).toMatch(/outside the 2x1 source/);
      }
      expect(() => copy({ source: two }, [1, 1, 2])).toThrow(/more than 1/);
      device.destroy();
      const rg11 = await setup('rg32float');
      expect(() => rg11.copy({ source: two })).not.toThrow();
      rg11.device.destroy();
      const depth = await (await gpu.requestAdapter()).requestDevice();
      const texture = depth.createTexture({ size: [2, 1], format: 'rg11b10ufloat', usage: g.GPUTextureUsage.COPY_DST | g.GPUTextureUsage.TEXTURE_BINDING });
      expect(() => depth.queue.copyExternalImageToTexture({ source: two }, { texture }, [2, 1])).toThrow(/destination format rg11b10ufloat is not supported/);
      depth.destroy();
    });

    it.skipIf(!hasAddonFunction('getCanvasPixels'))('takes a WebGPU canvas of this provider as the source, from what its read-back left', async () => {
      const { device, texture, copy } = await setup('rgba8unorm', 4, 4);
      const scope = createDawnScope();
      const leave = enterDawnScope(scope);
      const canvasDevice = await (await gpu.requestAdapter()).requestDevice();
      const context = new DawnCanvasContext({ size: () => ({ width: 4, height: 4 }) });
      context.configure({ device: canvasDevice, format: 'bgra8unorm', alphaMode: 'opaque' });
      const host = { [CANVAS_SOURCE as symbol]: () => ({ source: dawnPictureSource(context, 4, 4), width: 4, height: 4 }) };
      context.resetState();
      const encoder = canvasDevice.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0.5, b: 0, a: 1 } }] }).end();
      canvasDevice.queue.submit([encoder.finish()]);
      // Drawn in this frame, not read back yet: said, not a copy of an empty picture.
      expect(() => copy({ source: host })).toThrow(/read back after the scripts of a frame ran/);
      await flushDawnCanvases();
      copy({ source: host });
      const got = await readTexture(device, texture, 4, 4, 4);
      expect([...got.subarray(0, 4)]).toEqual([255, 128, 0, 255]);
      expect([...got.subarray(60, 64)]).toEqual([255, 128, 0, 255]);
      // A canvas that was not drawn this frame is transparent.
      context.resetState();
      copy({ source: host });
      expect([...(await readTexture(device, texture, 4, 4, 4)).subarray(0, 4)]).toEqual([0, 0, 0, 0]);
      leave();
      releaseDawn(scope);
      device.destroy();
    });
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

  it('keeps the canvas texture from frame to frame, cleared at each frame\'s first use, until the size or the configuration changes', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    let size = { width: 8, height: 4 };
    const context = new DawnCanvasContext({ size: () => size });
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
    const pixelAt = async (): Promise<number[]> => {
      await flushDawnCanvases();
      const picture = context.picture!;
      // The straight pixels of the read-back, through the same conversion the copy of a canvas uses.
      return [...context.pixels().rgba.subarray(0, 4)].concat([picture.width]);
    };
    // Frame 1 draws red; frame 2 loads what the canvas holds and draws nothing: it holds transparent black, not frame 1's red.
    context.resetState();
    const first = context.getCurrentTexture();
    let encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: first.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 0, a: 1 } }] }).end();
    device.queue.submit([encoder.finish()]);
    if (hasAddonFunction('getCanvasPixels')) expect(await pixelAt()).toEqual([255, 0, 0, 255, 8]);
    else await flushDawnCanvases();
    context.resetState();
    const second = context.getCurrentTexture();
    expect(second).toBe(first);
    expect(context.getCurrentTexture()).toBe(first);
    encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: second.createView(), loadOp: 'load', storeOp: 'store' }] }).end();
    device.queue.submit([encoder.finish()]);
    if (hasAddonFunction('getCanvasPixels')) expect(await pixelAt()).toEqual([0, 0, 0, 0, 8]);
    else await flushDawnCanvases();
    // A size change makes a new texture, so does a configuration; a frame that draws nothing leaves the texture as it is.
    context.resetState();
    size = { width: 4, height: 4 };
    const resized = context.getCurrentTexture();
    expect(resized).not.toBe(first);
    expect(resized.width).toBe(4);
    context.resetState();
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
    expect(context.getCurrentTexture()).not.toBe(resized);
    // A configuration without RENDER_ATTACHMENT cannot be cleared by a pass: a new texture each frame, as before.
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque', usage: g.GPUTextureUsage.STORAGE_BINDING });
    context.resetState();
    const a = context.getCurrentTexture();
    context.resetState();
    expect(context.getCurrentTexture()).not.toBe(a);
    context.unconfigure();
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

  it('counts a loaded depth attachment as carried state only when a pipeline of the pass tests depth', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0, 0, 0.5, 1); } @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }' });
    const pipeline = (depthCompare: string) => device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'point-list' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare } });
    const clock = engineClock();
    const frames = (compare: string): boolean => {
      resetCarry();
      clock.mockReturnValue(0);
      const draw = pipeline(compare);
      const color = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: g.GPUTextureUsage.RENDER_ATTACHMENT });
      const depth = device.createTexture({ size: [4, 4], format: 'depth24plus', usage: g.GPUTextureUsage.RENDER_ATTACHMENT });

      for (const [at, load] of [[0, 'clear'], [33, 'load'], [66, 'load']] as const) {
        clock.mockReturnValue(at);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: { view: depth.createView(), depthLoadOp: load, depthStoreOp: 'store', depthClearValue: 1 },
        });
        pass.setPipeline(draw);
        pass.draw(1);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
      return carryDepends();
    };
    // An output pass that loads the depth and draws with the test off reads nothing from it; a pass that tests against it does.
    expect(frames('always')).toBe(false);
    expect(frames('less')).toBe(true);
    clock.mockRestore();
    device.destroy();
  });
  it('decides from the frame alone that a frame reads what an earlier frame wrote and writes a resource that held something, and not for a static texture, a depth buffer or a uniform', async () => {
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const U = g.GPUTextureUsage;
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); }
      @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return textureLoad(src, vec2i(p.xy), 0); }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
    const clock = engineClock();
    const make = (usage: number, format = 'rgba8unorm') => device.createTexture({ size: [4, 4], format, usage });
    const fill = (texture: any): void => device.queue.writeTexture({ texture }, new Uint8Array(64).fill(9), { bytesPerRow: 16 }, [4, 4]);
    const pass = (source: any, target: any, loadOp = 'clear'): void => {
      const encoder = device.createCommandEncoder();
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp, storeOp: 'store' }] });
      p.setPipeline(pipeline);
      p.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.createView() }] }));
      p.draw(3);
      p.end();
      device.queue.submit([encoder.finish()]);
    };
    /** `build` makes new resources and returns what the page does when it mounts (epoch 0) and in a frame jumped to (epoch 33, nothing drawn between); whether that frame is for a replay. */
    const replays = (build: () => [() => void, () => void]): boolean => {
      resetCarry();
      clock.mockReturnValue(0);
      const [mount, frame] = build();
      mount();
      clock.mockReturnValue(33);
      frame();
      return carryNeedsReplay();
    };
    const sampled = U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_DST;

    // A ping-pong filled when it mounts: A cleared by a pass, B written from data. The frame reads A and writes B.
    expect(replays(() => {
      const [a, b] = [make(sampled), make(sampled)];
      return [() => { pass(make(sampled), a); fill(b); }, () => pass(a, b)];
    })).toBe(true);
    // A static texture that is only read, drawn to a target nothing can sample (a depth buffer, a multisample colour target) that the pass clears.
    expect(replays(() => {
      const [still, target] = [make(sampled), make(U.RENDER_ATTACHMENT)];
      return [() => fill(still), () => pass(still, target)];
    })).toBe(false);
    // The same after a frame that drew to the target before: the clear of the target is not what an earlier frame made.
    expect(replays(() => {
      const [still, target] = [make(sampled), make(U.RENDER_ATTACHMENT)];
      return [() => { fill(still); pass(still, target); }, () => pass(still, target)];
    })).toBe(false);
    // A static texture, and a uniform buffer the page writes every frame (and a copy of bytes it wrote this frame to another).
    expect(replays(() => {
      const still = make(sampled);
      const uniform = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.UNIFORM | g.GPUBufferUsage.COPY_DST });
      const staging = device.createBuffer({ size: 16, usage: g.GPUBufferUsage.COPY_SRC | g.GPUBufferUsage.COPY_DST });
      const target = make(U.RENDER_ATTACHMENT);
      const frame = (): void => {
        device.queue.writeBuffer(uniform, 0, new Float32Array(4));
        device.queue.writeBuffer(staging, 0, new Float32Array(4));
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(staging, 0, uniform, 0, 16);
        device.queue.submit([encoder.finish()]);
        pass(still, target);
      };
      return [() => { fill(still); frame(); }, frame];
    })).toBe(false);
    // A target a shader can sample, written every frame (a shadow map, a post-processing target), is the cost: the same as a ping-pong
    // texture to the rule when the frame also reads a texture an earlier frame wrote.
    expect(replays(() => {
      const [still, target] = [make(sampled), make(sampled)];
      return [() => { fill(still); pass(still, target); }, () => pass(still, target)];
    })).toBe(true);
    // Written for the first time in the frame, not before: nothing it held can be read.
    expect(replays(() => {
      const [still, target] = [make(sampled), make(sampled)];
      return [() => fill(still), () => pass(still, target)];
    })).toBe(false);
    // What a frame does inside an animation-frame callback is stepped by a jump, never replayed.
    expect(replays(() => {
      const [a, b] = [make(sampled), make(sampled)];
      return [() => { pass(make(sampled), a); fill(b); }, () => duringAnimationFrames(() => pass(a, b))];
    })).toBe(false);
    clock.mockRestore();
    device.destroy();
  });
});
