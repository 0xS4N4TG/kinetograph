import { describe, expect, it } from 'vitest';
import { createGpu, createGpuCanvasContext, GPU_BUFFER_USAGE, GPU_SHADER_STAGE, WebGpuUnsupportedError, type GPUDeviceShim } from '../src/index.js';

const WGSL = `
struct U { time: f32 }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(u.time, 0, 0, 1); }`;

async function page(time: number) {
  const gpu = createGpu();
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 4 }) });
  context.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
  const buffer = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST });
  const module = device.createShaderModule({ code: WGSL });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, buffer: { type: 'uniform' } }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module },
    fragment: { module, targets: [{ format: 'rgba8unorm' }] },
  });
  const draw = (t: number): void => {
    device.queue.writeBuffer(buffer, 0, new Float32Array([t, 0, 0, 0]));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  draw(time);
  return { context, device, draw };
}

describe('the recording WebGPU context', () => {
  it('records a pass with its module, pipeline, bind group and the bytes the buffer held', async () => {
    const { context } = await page(0.5);
    const content = context.content();
    const webgpu = content.webgpu!;
    expect(content.premultipliedAlpha).toBe(true);
    expect(Object.values(webgpu.modules)).toEqual([WGSL]);
    expect(webgpu.passes).toHaveLength(1);
    const [pass] = webgpu.passes;
    expect(pass!.clear).toEqual([0, 0, 0, 0]);
    expect(pass!.commands.map((c) => c.c)).toEqual(['pipeline', 'bind', 'draw']);
    const bind = pass!.commands[1]!;
    if (bind.c !== 'bind') throw new Error('not a bind');
    const entry = webgpu.bindGroups[bind.group]!.entries[0]!;
    expect(Buffer.from(webgpu.buffers[entry.buffer]!, 'base64').readFloatLE(0)).toBeCloseTo(0.5);
    expect(Object.values(webgpu.pipelines)[0]).toMatchObject({ primitive: { topology: 'triangle-list' }, fragment: { targets: [{ format: 'rgba8unorm' }] } });
  });

  it('starts a fresh drawing on the first submit after resetState, and does not depend on earlier frames', async () => {
    const a = await page(0.1);
    a.context.resetState();
    a.draw(0.7);
    expect(a.context.content().webgpu!.passes).toHaveLength(1);
    const sequential = JSON.stringify(a.context.content());
    const alone = await page(0.7);
    expect(JSON.stringify(alone.context.content())).toBe(sequential);
  });

  it('keeps the picture of a frame that draws nothing', async () => {
    const a = await page(0.3);
    a.context.resetState();
    expect(a.context.content().webgpu!.passes).toHaveLength(1);
  });

  it('says what it does not draw: the call throws and the frame reports it', async () => {
    const { context, device } = await page(0);
    expect(() => (device as GPUDeviceShim).createQuerySet()).toThrow(WebGpuUnsupportedError);
    expect(() => device.createRenderBundleEncoder()).toThrow(/^unsupported:/);
    expect(context.content().webgpu!.notes).toEqual(['query sets', 'render bundles']);
    expect(context.drawn).toBe(true);
  });

  it('refuses an empty, misaligned or out-of-range vertex buffer', async () => {
    const { context, device } = await page(0);
    const buffer = device.createBuffer({ size: 64, usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST });
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    expect(() => pass.setVertexBuffer(0, buffer, 64)).toThrow(/is empty/);
    expect(() => pass.setVertexBuffer(0, buffer, 8, 0)).toThrow(/is empty/);
    expect(() => pass.setVertexBuffer(0, buffer, 2, 8)).toThrow(/multiple of 4/);
    expect(() => pass.setVertexBuffer(0, buffer, 56, 16)).toThrow(/outside/);
    expect(() => pass.setVertexBuffer(0, buffer, 16, 16)).not.toThrow();
  });

  it('refuses an empty, misaligned or out-of-range index buffer, by the size of its format', async () => {
    const { context, device } = await page(0);
    const buffer = device.createBuffer({ size: 64, usage: GPU_BUFFER_USAGE.INDEX | GPU_BUFFER_USAGE.COPY_DST });
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    expect(() => pass.setIndexBuffer(buffer, 'uint16', 64)).toThrow(/is empty/);
    expect(() => pass.setIndexBuffer(buffer, 'uint32', 2)).toThrow(/multiple of 4/);
    expect(() => pass.setIndexBuffer(buffer, 'uint16', 1)).toThrow(/multiple of 2/);
    expect(() => pass.setIndexBuffer(buffer, 'uint16', 60, 8)).toThrow(/outside/);
    expect(() => pass.setIndexBuffer(buffer, 'uint16', 2, 8)).not.toThrow();
  });

  it('refuses a context that is not configured, and a device that is not one', () => {
    const context = createGpuCanvasContext({ size: () => ({ width: 1, height: 1 }) });
    expect(() => context.getCurrentTexture()).toThrow(/not configured/);
    expect(() => context.configure({ device: {} as GPUDeviceShim, format: 'rgba8unorm' })).toThrow(/GPUDevice/);
  });
});
