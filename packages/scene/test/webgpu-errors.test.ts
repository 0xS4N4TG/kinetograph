import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_BUFFER_USAGE,
  GPU_TEXTURE_USAGE,
  GPU_GLOBALS,
  type GPUCanvasContextShim,
  type GPUDeviceShim,
} from '../src/index.js';

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 4, height: 4 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

/** What a page that guards its calls does: the call is invalid, the page catches it and carries on. */
const swallowed = (call: () => unknown): void => {
  try {
    call();
  } catch {
    // The page goes on, as a browser's page does when a call is only invalid.
  }
};

describe('invalid calls are reported even when the page catches them', () => {
  it('names the call in the recording, whichever object it was made on', async () => {
    const { device, context } = await setup();
    const buffer = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.COPY_DST });
    swallowed(() => device.queue.writeBuffer(buffer, 2, new Uint8Array(4)));
    swallowed(() => device.createTexture({ size: [0, 4], format: 'rgba8unorm', usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING }));
    swallowed(() => {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, buffer, 4, 64);
      device.queue.submit([encoder.finish()]);
    });
    swallowed(() => device.createBuffer({ size: 1e12, usage: GPU_BUFFER_USAGE.COPY_DST }));
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING });
    swallowed(() => texture.createView({ baseMipLevel: 3 }));
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    swallowed(() => pass.setVertexBuffer(0, buffer, 64));
    const errors = context.content().webgpu!.errors!;
    expect(errors).toHaveLength(6);
    expect(errors.join('\n')).toMatch(/writeBuffer/);
    expect(errors.join('\n')).toMatch(/createTexture/);
    expect(errors.join('\n')).toMatch(/copyBufferToBuffer is out of range/);
    expect(errors.join('\n')).toMatch(/baseMipLevel 3/);
    expect(errors.join('\n')).toMatch(/setVertexBuffer/);
    expect(context.drawn).toBe(true);
  });

  it('keeps an unsupported call as a note and not as an error, and says nothing when nothing went wrong', async () => {
    const { device, context } = await setup();
    expect(context.content().webgpu!.errors).toBeUndefined();
    expect(context.drawn).toBe(false);
    swallowed(() => device.createRenderBundleEncoder());
    const webgpu = context.content().webgpu!;
    expect(webgpu.notes).toEqual(['render bundles']);
    expect(webgpu.errors).toBeUndefined();
  });

  it('records an error once, and keeps at most 32 different ones', async () => {
    const { device, context } = await setup();
    for (let n = 0; n < 3; n += 1) swallowed(() => device.createBuffer({ size: -1, usage: 1 }));
    expect(context.content().webgpu!.errors).toHaveLength(1);
    for (let n = 0; n < 100; n += 1) swallowed(() => device.createBuffer({ size: -n - 2, usage: 1 }));
    expect(context.content().webgpu!.errors).toHaveLength(32);
  });
});

describe('error scopes', () => {
  it('resolve with the first validation error raised inside them, and with null if there was none', async () => {
    const { device } = await setup();
    device.pushErrorScope('validation');
    swallowed(() => device.createBuffer({ size: -1, usage: 1 }));
    swallowed(() => device.createBuffer({ size: -2, usage: 1 }));
    const error = await device.popErrorScope();
    expect(error).toBeInstanceOf(GPU_GLOBALS.GPUValidationError);
    expect(error!.message).toMatch(/createBuffer/);
    device.pushErrorScope('validation');
    device.createBuffer({ size: 4, usage: 1 });
    expect(await device.popErrorScope()).toBeNull();
  });

  it('nest: the innermost scope that filters validation keeps the error, and other filters keep none', async () => {
    const { device } = await setup();
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    swallowed(() => device.createBuffer({ size: -1, usage: 1 }));
    expect(await device.popErrorScope()).not.toBeNull();
    expect(await device.popErrorScope()).toBeNull();
    expect(await device.popErrorScope()).toBeNull();
  });

  it('refuse a filter that is not one, and a pop with nothing pushed', async () => {
    const { device } = await setup();
    expect(() => device.pushErrorScope('whatever' as never)).toThrow(/filter/);
    await expect(device.popErrorScope()).rejects.toMatchObject({ name: 'OperationError' });
  });
});
