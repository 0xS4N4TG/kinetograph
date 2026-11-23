import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_BUFFER_USAGE,
  GPU_TEXTURE_USAGE,
  type GPUCanvasContextShim,
  type GPUDeviceShim,
  type WebGpuCompute,
  type WebGpuPass,
} from '../src/index.js';

const { INDIRECT, STORAGE, COPY_DST, INDEX, VERTEX } = GPU_BUFFER_USAGE;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 8 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const TRIANGLE = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
  @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`;
const WRITER = `@group(0) @binding(0) var<storage, read_write> args: array<u32>; @compute @workgroup_size(1) fn write() { args[0] = 3u; args[1] = 1u; args[2] = 0u; args[3] = 0u; args[4] = 0u; }`;
const FILL = `@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>; @compute @workgroup_size(4, 4) fn fill(@builtin(global_invocation_id) id: vec3u) { textureStore(out, vec2i(id.xy), vec4f(1)); }`;

const args = (device: GPUDeviceShim, words: number[], usage = INDIRECT | COPY_DST | STORAGE) => {
  const buffer = device.createBuffer({ size: 64, usage });
  device.queue.writeBuffer(buffer, 0, new Uint32Array(words));
  return buffer;
};

/** A canvas pass with a pipeline, and a draw of `call`; returns the frame's pass. */
function frameWith(device: GPUDeviceShim, context: GPUCanvasContextShim, call: (pass: ReturnType<ReturnType<GPUDeviceShim['createCommandEncoder']>['beginRenderPass']>) => void, before?: () => void): WebGpuPass {
  const module = device.createShaderModule({ code: TRIANGLE });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  call(pass);
  pass.end();
  before?.();
  device.queue.submit([encoder.finish()]);
  return (context.content().webgpu!.passes as WebGpuPass[]).at(-1)!;
}

describe('indirect draws', () => {
  it('records the draw the bytes the queue has describe, as of the submit', async () => {
    const { device, context } = await setup();
    const buffer = args(device, [9, 9, 9, 9]);
    const pass = frameWith(device, context, (p) => p.drawIndirect(buffer, 0), () => device.queue.writeBuffer(buffer, 0, new Uint32Array([3, 2, 1, 0])));
    expect(pass.commands.map((c) => c.c)).toEqual(['pipeline', 'draw']);
    expect(pass.commands[1]).toEqual({ c: 'draw', vertices: 3, instances: 2, first: 1, firstInstance: 0 });
  });

  it('records an indexed draw with its base vertex, and reads the arguments at the offset', async () => {
    const { device, context } = await setup();
    const buffer = args(device, [0, 6, 2, 4, 0xfffffffe, 0]);
    const index = device.createBuffer({ size: 16, usage: INDEX | COPY_DST });
    const pass = frameWith(device, context, (p) => {
      p.setIndexBuffer(index, 'uint16');
      p.drawIndexedIndirect(buffer, 4);
    });
    expect(pass.commands.at(-1)).toEqual({ c: 'drawIndexed', indices: 6, instances: 2, first: 4, base: -2, firstInstance: 0 });
  });

  it('draws nothing when the arguments name a first instance, which needs a feature the device does not have', async () => {
    const { device, context } = await setup();
    const buffer = args(device, [3, 1, 0, 1]);
    const pass = frameWith(device, context, (p) => p.drawIndirect(buffer, 0));
    expect(pass.commands.map((c) => c.c)).toEqual(['pipeline']);
  });

  it('keeps the call when a pass wrote the arguments, and the recording holds the buffer the pass wrote', async () => {
    const { device, context } = await setup();
    const buffer = args(device, [0, 0, 0, 0, 0]);
    const writer = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: WRITER }), entryPoint: 'write' } });
    const encoder = device.createCommandEncoder();
    const compute = encoder.beginComputePass();
    compute.setPipeline(writer);
    compute.setBindGroup(0, device.createBindGroup({ layout: writer.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] }));
    compute.dispatchWorkgroups(1);
    compute.end();
    device.queue.submit([encoder.finish()]);
    const pass = frameWith(device, context, (p) => p.drawIndirect(buffer, 0));
    expect(pass.commands[1]).toEqual({ c: 'drawIndirect', buffer: buffer.key, offset: 0 });
    const webgpu = context.content().webgpu!;
    expect(webgpu.gpuBuffers).toHaveProperty(buffer.key);
    expect(webgpu.passes.map((s) => s.k)).toContain('compute');
  });

  it('refuses arguments that cannot be read: no INDIRECT usage, a misaligned offset, past the end, no pipeline', async () => {
    const { device, context } = await setup();
    const call = (fn: (p: ReturnType<ReturnType<GPUDeviceShim['createCommandEncoder']>['beginRenderPass']>) => void) => () => frameWith(device, context, fn);
    expect(call((p) => p.drawIndirect(args(device, [3, 1, 0, 0], COPY_DST | VERTEX), 0))).toThrow(/without GPUBufferUsage.INDIRECT/);
    expect(call((p) => p.drawIndirect(args(device, [3, 1, 0, 0]), 2))).toThrow(/not a multiple of 4/);
    expect(call((p) => p.drawIndirect(args(device, [3, 1, 0, 0]), 52))).toThrow(/past the end/);
    expect(call((p) => p.drawIndexedIndirect(args(device, [3, 1, 0, 0]), 0))).toThrow(/no index buffer/);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    expect(() => pass.drawIndirect(args(device, [3, 1, 0, 0]), 0)).toThrow(/no pipeline is set/);
  });
});

describe('indirect dispatches', () => {
  function fill(device: GPUDeviceShim, words: number[]): { texture: ReturnType<GPUDeviceShim['createTexture']>; run: () => void } {
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPU_TEXTURE_USAGE.STORAGE_BINDING | GPU_TEXTURE_USAGE.TEXTURE_BINDING });
    const buffer = args(device, words);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: FILL }), entryPoint: 'fill' } });
    const run = () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
      pass.dispatchWorkgroupsIndirect(buffer, 0);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    return { texture, run };
  }
  function show(device: GPUDeviceShim, context: GPUCanvasContextShim, texture: ReturnType<GPUDeviceShim['createTexture']>): WebGpuCompute[] {
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var tex: texture_2d<f32>; @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
        @fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(at.xy), 0); }`,
    });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return context.content().webgpu!.passes.filter((p): p is WebGpuCompute => p.k === 'compute');
  }

  it('records the dispatch the bytes describe', async () => {
    const { device, context } = await setup();
    const { texture, run } = fill(device, [2, 3, 1]);
    run();
    const [step] = show(device, context, texture);
    expect(step!.commands.map((c) => c.c)).toEqual(['pipeline', 'bind', 'dispatch']);
    expect(step!.commands[2]).toEqual({ c: 'dispatch', x: 2, y: 3, z: 1 });
  });

  it('does nothing when a count is over the device limit', async () => {
    const { device, context } = await setup();
    const { texture, run } = fill(device, [65536, 1, 1]);
    run();
    expect(show(device, context, texture)).toEqual([]);
  });

  it('refuses a dispatch with no pipeline, and arguments that cannot be read', async () => {
    const { device } = await setup();
    const pass = device.createCommandEncoder().beginComputePass();
    expect(() => pass.dispatchWorkgroupsIndirect(args(device, [1, 1, 1]), 0)).toThrow(/before setPipeline/);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: FILL }), entryPoint: 'fill' } });
    pass.setPipeline(pipeline);
    const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPU_TEXTURE_USAGE.STORAGE_BINDING });
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    expect(() => pass.dispatchWorkgroupsIndirect(args(device, [1, 1, 1], STORAGE), 0)).toThrow(/without GPUBufferUsage.INDIRECT/);
    expect(() => pass.dispatchWorkgroupsIndirect(args(device, [1, 1, 1]), 56)).toThrow(/past the end/);
  });
});
