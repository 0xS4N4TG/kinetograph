import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_BUFFER_USAGE,
  GPU_SHADER_STAGE,
  GPU_TEXTURE_USAGE,
  WebGpuUnsupportedError,
  type GPUBufferShim,
  type GPUCanvasContextShim,
  type GPUDeviceShim,
  type GPUTextureShim,
  type WebGpuCompute,
  type WebGpuContent,
} from '../src/index.js';

const { STORAGE, COPY_DST, COPY_SRC, UNIFORM } = GPU_BUFFER_USAGE;
const { STORAGE_BINDING, TEXTURE_BINDING, RENDER_ATTACHMENT } = GPU_TEXTURE_USAGE;
const { COMPUTE, FRAGMENT, VERTEX } = GPU_SHADER_STAGE;

const KERNEL = `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var out: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  data[id.x] = id.y;
  textureStore(out, vec2i(id.xy), vec4f(1));
}`;

const PRESENT = `
@group(0) @binding(0) var tex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(at.xy), 0); }`;

async function setup(options: Parameters<typeof createGpu>[0] = {}): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const gpu = createGpu(options);
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 8 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

function storageTexture(device: GPUDeviceShim, format = 'rgba8unorm', extra: Partial<Parameters<GPUDeviceShim['createTexture']>[0]> = {}): GPUTextureShim {
  return device.createTexture({ size: [8, 8], format, usage: STORAGE_BINDING | TEXTURE_BINDING | RENDER_ATTACHMENT, ...extra });
}

/** A compute pipeline over `KERNEL` with a layout the page made: a read-write storage buffer and a write-only storage texture. */
function kernel(device: GPUDeviceShim) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: KERNEL }), entryPoint: 'main' },
  });
  return { layout, pipeline };
}

function bindings(device: GPUDeviceShim, layout: ReturnType<typeof kernel>['layout'], buffer: GPUBufferShim, texture: GPUTextureShim) {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer } },
      { binding: 1, resource: texture.createView() },
    ],
  });
}

function dispatch(device: GPUDeviceShim, pipeline: unknown, group: unknown, x = 1, y = 1, z = 1): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline as never);
  pass.setBindGroup(0, group as never);
  pass.dispatchWorkgroups(x, y, z);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

/** A render pass into the canvas that samples `texture`, so that the frame depends on it. */
function present(device: GPUDeviceShim, context: GPUCanvasContextShim, texture: GPUTextureShim): void {
  const module = device.createShaderModule({ code: PRESENT });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

const computeSteps = (content: WebGpuContent): WebGpuCompute[] => content.passes.filter((p): p is WebGpuCompute => p.k === 'compute');

describe('compute pipelines and passes', () => {
  it('records a pass with its pipeline, bind group and dispatch, and the storage layout entries', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 256, usage: STORAGE | COPY_DST });
    const texture = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, buffer, texture), 2, 3, 1);
    present(device, context, texture);
    const webgpu = context.content().webgpu!;
    const [step] = computeSteps(webgpu);
    expect(step!.commands.map((c) => c.c)).toEqual(['pipeline', 'bind', 'dispatch']);
    expect(step!.commands[2]).toEqual({ c: 'dispatch', x: 2, y: 3, z: 1 });
    const pipelineId = (step!.commands[0] as { id: string }).id;
    expect(webgpu.computePipelines![pipelineId]).toMatchObject({ entryPoint: 'main', layout: expect.any(Array) });
    expect(Object.values(webgpu.layouts)[0]).toEqual([
      { binding: 0, visibility: COMPUTE, type: 'storage' },
      { binding: 1, visibility: COMPUTE, type: 'storage-texture', format: 'rgba8unorm' },
    ]);
    // The buffer is written by the GPU now: it travels by id, not by its bytes.
    expect(Object.keys(webgpu.gpuBuffers!)).toHaveLength(1);
    expect(webgpu.buffers).toEqual({});
    expect(webgpu.textures![texture.id]).toMatchObject({ format: 'rgba8unorm' });
  });

  it('has automatic layouts: getBindGroupLayout names the pipeline, and the group is made with it', async () => {
    const { device, context } = await setup();
    const module = device.createShaderModule({ code: KERNEL });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
    const layout = pipeline.getBindGroupLayout(0);
    expect(layout.id).toBe(`auto:${pipeline.id}:0`);
    const buffer = device.createBuffer({ size: 256, usage: STORAGE });
    const texture = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    present(device, context, texture);
    const webgpu = context.content().webgpu!;
    const group = Object.values(webgpu.bindGroups).find((g) => g.layout.startsWith('auto:c'))!;
    expect(group.entries).toHaveLength(2);
    // The WGSL says which bindings are written, so the buffer is a GPU buffer although no layout said so.
    expect(Object.keys(webgpu.gpuBuffers!)).toHaveLength(1);
    expect(Object.keys(webgpu.computePipelines!)).toEqual([pipeline.id]);
    expect(pipeline.getBindGroupLayout(0)).not.toBe(layout);
    expect(() => pipeline.getBindGroupLayout(4)).toThrow(/no bind group 4/);
  });

  it('has createComputePipelineAsync, which rejects where the sync call throws', async () => {
    const { device } = await setup();
    const module = device.createShaderModule({ code: KERNEL });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
    expect(pipeline.id).toMatch(/^c/);
    await expect(device.createComputePipelineAsync({ layout: 'auto', compute: { module: {} as never } })).rejects.toThrow(/not a GPUShaderModule/);
  });

  it('keeps the order of compute passes, render passes and copies', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 256, usage: STORAGE | COPY_DST | COPY_SRC });
    const texture = storageTexture(device, 'rgba8unorm', { usage: STORAGE_BINDING | TEXTURE_BINDING | RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC | GPU_TEXTURE_USAGE.COPY_DST });
    const copy = storageTexture(device, 'rgba8unorm', { usage: TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST });
    const group = bindings(device, layout, buffer, texture);
    dispatch(device, pipeline, group);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture }, { texture: copy }, [8, 8]);
    device.queue.submit([encoder.finish()]);
    dispatch(device, pipeline, group, 2);
    present(device, context, copy);
    expect(context.content().webgpu!.passes.map((p) => p.k)).toEqual(['compute', 'copy', 'render']);
  });

  it('records a compute pass of a dispatch only, and drops one that dispatches nothing', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const texture = storageTexture(device);
    const group = bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), texture);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.end();
    device.queue.submit([encoder.finish()]);
    present(device, context, texture);
    expect(computeSteps(context.content().webgpu!)).toHaveLength(0);
  });

  it('says what is not drawn: indirect dispatches, timestamp writes', async () => {
    const { device } = await setup();
    const pass = device.createCommandEncoder().beginComputePass();
    expect(() => pass.dispatchWorkgroupsIndirect()).toThrow(WebGpuUnsupportedError);
    expect(() => device.createCommandEncoder().beginComputePass({ timestampWrites: {} })).toThrow(/query sets/);
    expect(() => device.createQuerySet()).toThrow(WebGpuUnsupportedError);
  });
});

describe('the checks a compute call gets on the page side', () => {
  it('refuses a dispatch that is not whole, over the device limit, or before a pipeline and groups', async () => {
    const { device } = await setup();
    const { layout, pipeline } = kernel(device);
    const group = bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), storageTexture(device));
    const pass = device.createCommandEncoder().beginComputePass();
    expect(() => pass.dispatchWorkgroups(1)).toThrow(/before setPipeline/);
    pass.setPipeline(pipeline);
    expect(() => pass.dispatchWorkgroups(1)).toThrow(/bind group 0 is not set/);
    pass.setBindGroup(0, group);
    expect(() => pass.dispatchWorkgroups(1.5)).toThrow(/not a whole number/);
    expect(() => pass.dispatchWorkgroups(-1)).toThrow(/not a whole number/);
    expect(() => pass.dispatchWorkgroups(65536)).toThrow(/maxComputeWorkgroupsPerDimension 65535/);
    expect(() => pass.dispatchWorkgroups(1, 1, 70000)).toThrow(/maxComputeWorkgroupsPerDimension/);
    expect(() => pass.dispatchWorkgroups(65535, 65535, 65535)).not.toThrow();
    expect(() => pass.dispatchWorkgroups(0, 0, 0)).not.toThrow();
    expect(() => pass.setBindGroup(4, group)).toThrow(/not from 0 to 3/);
    expect(() => pass.setBindGroup(0, {} as never)).toThrow(/not a GPUBindGroup/);
    expect(() => pass.setPipeline({} as never)).toThrow(/not a GPUComputePipeline/);
    pass.end();
    expect(() => pass.setPipeline(pipeline)).toThrow(/has ended/);
  });

  it('refuses a group made with another layout than the pipeline has, and the automatic layout of another pipeline', async () => {
    const { device } = await setup();
    const { layout, pipeline } = kernel(device);
    const other = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, buffer: { type: 'storage' } }] });
    const wrong = device.createBindGroup({ layout: other, entries: [{ binding: 0, resource: { buffer: device.createBuffer({ size: 64, usage: STORAGE }) } }] });
    const pass = device.createCommandEncoder().beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, wrong);
    expect(() => pass.dispatchWorkgroups(1)).toThrow(/different layout/);
    const module = device.createShaderModule({ code: KERNEL });
    const a = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const b = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: `${KERNEL}\n// b` }), entryPoint: 'main' } });
    const bufferB = device.createBuffer({ size: 64, usage: STORAGE });
    const fromB = device.createBindGroup({ layout: b.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bufferB } }, { binding: 1, resource: storageTexture(device).createView() }] });
    const second = device.createCommandEncoder().beginComputePass();
    second.setPipeline(a);
    second.setBindGroup(0, fromB);
    expect(() => second.dispatchWorkgroups(1)).toThrow(/automatic layout of another pipeline/);
    expect(layout).toBeDefined();
  });

  it('refuses a texture or buffer that a dispatch writes and uses again', async () => {
    const { device } = await setup();
    const module = device.createShaderModule({ code: KERNEL });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
    const buffer = device.createBuffer({ size: 1024, usage: STORAGE });
    const texture = storageTexture(device);
    const layout = pipeline.getBindGroupLayout(0);
    const ok = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer, offset: 0, size: 64 } }, { binding: 1, resource: texture.createView() }] });
    const pass = device.createCommandEncoder().beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, ok);
    expect(() => pass.dispatchWorkgroups(1)).not.toThrow();
    // Group 1 is not one the pipeline uses: it is not part of the dispatch, whatever it holds.
    pass.setBindGroup(1, device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] }));
    expect(() => pass.dispatchWorkgroups(1)).not.toThrow();
    // A group made for index 0 does not go in slot 1.
    pass.setBindGroup(1, ok);
    expect(() => pass.dispatchWorkgroups(1)).toThrow(/automatic layout of another pipeline/);
    pass.setBindGroup(1, null);
    const dual = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const overlap = (offset: number) =>
      device.createBindGroup({ layout: dual, entries: [{ binding: 0, resource: { buffer, offset: 0, size: 64 } }, { binding: 1, resource: { buffer, offset, size: 64 } }] });
    const shader = device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
    const explicit = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [dual] }), compute: { module: shader } });
    const check = (offset: number) => {
      const p = device.createCommandEncoder().beginComputePass();
      p.setPipeline(explicit);
      p.setBindGroup(0, overlap(offset));
      return () => p.dispatchWorkgroups(1);
    };
    expect(check(256)).not.toThrow();
    expect(check(0)).toThrow(/written as a storage buffer and bound again/);
    // A texture level written as a storage texture and bound again as a sampled one.
    const rw = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, storageTexture: { format: 'rgba8unorm' } },
        { binding: 1, visibility: COMPUTE, texture: {} },
      ],
    });
    const twice = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [rw] }), compute: { module: shader } });
    const both = device.createBindGroup({ layout: rw, entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: texture.createView() }] });
    const p = device.createCommandEncoder().beginComputePass();
    p.setPipeline(twice);
    p.setBindGroup(0, both);
    expect(() => p.dispatchWorkgroups(1)).toThrow(/texture level .* written as a storage texture and bound again/);
  });

  it('checks a workgroup size against the device, when the WGSL writes it with numbers', async () => {
    const { device } = await setup();
    const make = (size: string, entryPoint?: string) => () =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: `@compute @workgroup_size(${size}) fn main() {}` }), ...(entryPoint ? { entryPoint } : {}) },
      });
    expect(make('256')).not.toThrow();
    expect(make('16, 16')).not.toThrow();
    expect(make('8u, 8i, 4')).not.toThrow();
    expect(make('257')).toThrow(/over the device's 256 x 256 x 64/);
    expect(make('1, 1, 65')).toThrow(/over the device's/);
    expect(make('16, 32')).toThrow(/512 invocations; the device allows 256/);
    expect(make('4, 4, 64')).toThrow(/1024 invocations/);
    // A constant or an override is the renderer's to check.
    expect(make('size')).not.toThrow();
    expect(make('256', 'main')).not.toThrow();
    // Attributes in the other order, and a second entry point that is named.
    const two = device.createShaderModule({ code: '@workgroup_size(1) @compute fn a() {} @compute @workgroup_size(512) fn b() {}' });
    expect(() => device.createComputePipeline({ layout: 'auto', compute: { module: two, entryPoint: 'a' } })).not.toThrow();
    expect(() => device.createComputePipeline({ layout: 'auto', compute: { module: two, entryPoint: 'b' } })).toThrow(/workgroup_size\(512, 1, 1\) is over the device's/);
  });

  it('refuses overridable constants and a module or layout that is not one', async () => {
    const { device } = await setup();
    const module = device.createShaderModule({ code: KERNEL });
    expect(() => device.createComputePipeline({ layout: 'auto', compute: { module, constants: { x: 1 } } })).toThrow(/^unsupported: pipeline-overridable constants/);
    expect(() => device.createComputePipeline({ layout: 'auto', compute: { module: {} as never } })).toThrow(/not a GPUShaderModule/);
    expect(() => device.createComputePipeline({ layout: {} as never, compute: { module } })).toThrow(/not 'auto' or a GPUPipelineLayout/);
    expect(() => device.createComputePipeline({ layout: 'auto' } as never)).toThrow(/not a GPUShaderModule/);
  });

  it('checks dynamic offsets: the count, the alignment and the buffer', async () => {
    const { device } = await setup();
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, buffer: { type: 'read-only-storage', hasDynamicOffset: true } }] });
    const buffer = device.createBuffer({ size: 1024, usage: STORAGE });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer, offset: 0, size: 256 } }] });
    const pass = device.createCommandEncoder().beginComputePass();
    expect(() => pass.setBindGroup(0, group)).toThrow(/1 dynamic offsets and 0 were given/);
    expect(() => pass.setBindGroup(0, group, [0, 256])).toThrow(/1 dynamic offsets and 2/);
    expect(() => pass.setBindGroup(0, group, [100])).toThrow(/not a multiple of 256/);
    expect(() => pass.setBindGroup(0, group, [1024])).toThrow(/past the end/);
    expect(() => pass.setBindGroup(0, group, [768])).not.toThrow();
    expect(() => pass.setBindGroup(0, group, new Uint32Array([0, 512]), 1, 1)).not.toThrow();
  });
});

describe('storage layouts, textures and bind groups', () => {
  it('has storage texture bindings of the formats and accesses WebGPU allows', async () => {
    const { device } = await setup();
    const make = (storageTexture: object, visibility = COMPUTE) => () => device.createBindGroupLayout({ entries: [{ binding: 0, visibility, storageTexture }] });
    for (const format of ['rgba32float', 'rgba16float', 'rgba8unorm', 'r32float', 'rg32float', 'rgba32uint', 'rgba8sint', 'r32uint']) {
      expect(make({ format })).not.toThrow();
    }
    expect(make({ format: 'r32float', access: 'read-write' })).not.toThrow();
    expect(make({ format: 'r32uint', access: 'read-only' })).not.toThrow();
    expect(make({ format: 'rgba8unorm', access: 'read-write' })).toThrow(/needs an optional feature/);
    expect(make({ format: 'rgba8unorm-srgb' })).toThrow(/cannot be a storage texture/);
    expect(make({ format: 'bgra8unorm' })).toThrow(/cannot be a storage texture/);
    expect(make({ format: 'r8unorm' })).toThrow(/cannot be a storage texture/);
    expect(make({ format: 'depth24plus' })).toThrow(/is not one of/);
    expect(make({})).toThrow(/is not one of/);
    expect(make({ format: 'rgba8unorm', access: 'sideways' })).toThrow(/access sideways/);
    expect(make({ format: 'rgba8unorm', viewDimension: '2d-array' })).toThrow(WebGpuUnsupportedError);
    expect(make({ format: 'rgba8unorm' }, VERTEX | COMPUTE)).toThrow(/not visible to the vertex stage/);
    expect(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VERTEX, buffer: { type: 'storage' } }] })).toThrow(/not visible to the vertex stage/);
    expect(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: FRAGMENT, buffer: {}, texture: {} }] })).toThrow(/exactly one/);
    expect(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 9, buffer: {} }] })).toThrow(/visibility 9/);
    expect(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, buffer: {} }, { binding: 0, visibility: COMPUTE, buffer: {} }] })).toThrow(/binding 0 twice/);
  });

  it('counts storage buffers and storage textures a stage may have against the device', async () => {
    const { device } = await setup();
    const buffers = (n: number) => () =>
      device.createBindGroupLayout({ entries: Array.from({ length: n }, (_, binding) => ({ binding, visibility: COMPUTE, buffer: { type: 'read-only-storage' } })) });
    expect(buffers(8)).not.toThrow();
    expect(buffers(9)).toThrow(/9 storage buffers in the compute stage; the device allows 8/);
    const images = (n: number) => () =>
      device.createBindGroupLayout({ entries: Array.from({ length: n }, (_, binding) => ({ binding, visibility: COMPUTE, storageTexture: { format: 'rgba8unorm' } })) });
    expect(images(4)).not.toThrow();
    expect(images(5)).toThrow(/5 storage textures in the compute stage; the device allows 4/);
  });

  it('makes storage textures, and refuses the usage on a format that cannot have it', async () => {
    const { device } = await setup();
    for (const format of ['rgba32float', 'rgba16float', 'rgba8unorm', 'r32float', 'r32uint', 'rgba32uint', 'rg32float']) {
      expect(storageTexture(device, format)).toMatchObject({ format, usage: STORAGE_BINDING | TEXTURE_BINDING | RENDER_ATTACHMENT });
    }
    expect(() => storageTexture(device, 'rgba8unorm-srgb')).toThrow(/cannot have GPUTextureUsage.STORAGE_BINDING/);
    expect(() => storageTexture(device, 'r8unorm')).toThrow(/cannot have GPUTextureUsage.STORAGE_BINDING/);
    expect(() => storageTexture(device, 'bgra8unorm')).toThrow(/STORAGE_BINDING/);
    expect(() => storageTexture(device, 'depth24plus')).toThrow(WebGpuUnsupportedError);
    // A 4 x 4 rgba32float texture is 16 bytes a texel.
    expect(storageTexture(device, 'rgba32float', { size: [4, 4] })).toMatchObject({ bytes: 256 });
  });

  it('checks a bind group against its layout: the usage, the format, one level, the sample type', async () => {
    const { device } = await setup();
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, storageTexture: { format: 'rgba8unorm' } }] });
    const group = (texture: GPUTextureShim, view = texture.createView()) => () => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }] });
    expect(group(storageTexture(device))).not.toThrow();
    expect(group(device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: TEXTURE_BINDING }))).toThrow(/without GPUTextureUsage.STORAGE_BINDING/);
    expect(group(storageTexture(device, 'rgba16float'))).toThrow(/storage texture of rgba8unorm and the view is of a rgba16float/);
    const mips = storageTexture(device, 'rgba8unorm', { mipLevelCount: 2 });
    expect(group(mips, mips.createView())).toThrow(/its view has 2 levels; it takes one/);
    expect(group(mips, mips.createView({ baseMipLevel: 1, mipLevelCount: 1 }))).not.toThrow();

    const sampled = (sampleType: string | undefined) =>
      device.createBindGroupLayout({ entries: [{ binding: 0, visibility: FRAGMENT, texture: sampleType ? { sampleType } : {} }] });
    const bind = (sampleType: string | undefined, texture: GPUTextureShim) => () => device.createBindGroup({ layout: sampled(sampleType), entries: [{ binding: 0, resource: texture.createView() }] });
    const f32 = storageTexture(device, 'rgba32float');
    expect(bind('unfilterable-float', f32)).not.toThrow();
    expect(bind('unfilterable-float', storageTexture(device, 'rgba8unorm'))).not.toThrow();
    expect(bind(undefined, storageTexture(device, 'rgba8unorm'))).not.toThrow();
    // A device made without float32-filterable cannot read it as filterable float.
    expect(bind(undefined, f32)).toThrow(/rgba32float texture as float.*unfilterable-float/);
    expect(bind('uint', storageTexture(device, 'rgba8unorm'))).toThrow(/as uint/);
    expect(bind('uint', storageTexture(device, 'rgba32uint'))).not.toThrow();
    expect(bind('sint', storageTexture(device, 'rgba32uint'))).toThrow(/as sint/);
  });

  it('has float32-filterable only when the device has it, and a texture of it may then be read as float', async () => {
    const gpu = createGpu({ info: () => ({ features: ['float32-filterable', 'timestamp-query', 'shader-f16'], limits: {} }) });
    const adapter = await gpu.requestAdapter();
    // Only what the recorder draws is offered, whatever the device has.
    expect([...adapter.features]).toEqual(['float32-filterable']);
    const without = await createGpu({ info: () => ({ features: [], limits: {} }) }).requestAdapter();
    expect([...without.features]).toEqual([]);
    const device = await adapter.requestDevice({ requiredFeatures: ['float32-filterable'] });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: FRAGMENT, texture: {} }] });
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: storageTexture(device, 'rgba32float').createView() }] })).not.toThrow();
    await expect(without.requestDevice({ requiredFeatures: ['float32-filterable'] })).rejects.toThrow(/not supported/);
  });

  it('checks a buffer binding: its usage, alignment, range and the size the device allows', async () => {
    const { device } = await setup();
    const make = (type: string, buffer: GPUBufferShim, offset = 0, size?: number) => () => {
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, buffer: { type } }] });
      return device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer, offset, ...(size === undefined ? {} : { size }) } }] });
    };
    const storage = device.createBuffer({ size: 1024, usage: STORAGE });
    const uniform = device.createBuffer({ size: 1024, usage: UNIFORM });
    expect(make('storage', storage)).not.toThrow();
    expect(make('storage', storage, 256, 512)).not.toThrow();
    expect(make('uniform', uniform, 0, 64)).not.toThrow();
    expect(make('storage', uniform)).toThrow(/without GPUBufferUsage.STORAGE/);
    expect(make('uniform', storage)).toThrow(/without GPUBufferUsage.UNIFORM/);
    expect(make('storage', storage, 4)).toThrow(/not a multiple of 256/);
    expect(make('storage', storage, 0, 2048)).toThrow(/names the bytes 0..2048 of a buffer of 1024/);
    expect(make('storage', storage, 1024, 4)).toThrow(/of a buffer of 1024/);
    expect(make('storage', storage, 0, 0)).toThrow(/of a buffer of 1024/);
    const large = device.createBuffer({ size: 200 * 1024 * 1024, usage: STORAGE });
    expect(make('storage', large, 0, 128 * 1024 * 1024)).not.toThrow();
    expect(make('storage', large, 0, 128 * 1024 * 1024 + 4)).toThrow(/the device allows 134217728/);
    const wide = device.createBuffer({ size: 1 << 20, usage: UNIFORM });
    expect(make('uniform', wide, 0, 65536)).not.toThrow();
    expect(make('uniform', wide, 0, 65540)).toThrow(/the device allows 65536/);
  });
});

describe('buffers the GPU writes', () => {
  it('turns a buffer into a log of steps once a pass writes it: what it held first, then the pass', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 64, usage: STORAGE | COPY_DST });
    device.queue.writeBuffer(buffer, 0, new Uint32Array([1, 2, 3, 4]));
    const texture = storageTexture(device);
    expect(buffer.gpu).toBe(false);
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    expect(buffer.gpu).toBe(true);
    // A write after that is a step too, in the order the queue ran it.
    device.queue.writeBuffer(buffer, 16, new Uint32Array([9, 9]));
    present(device, context, texture);
    const webgpu = context.content().webgpu!;
    expect(webgpu.passes.map((p) => p.k)).toEqual(['writeBuffer', 'compute', 'render']);
    const [first] = webgpu.passes;
    if (first!.k !== 'writeBuffer') throw new Error('not a write');
    expect(Buffer.from(webgpu.blobs![first!.data]!, 'base64').readUInt32LE(4)).toBe(2);
    expect(webgpu.gpuBuffers).toEqual({ [buffer.key]: { size: 64 } });
  });

  it('keeps a write after the pass: a write of part of the buffer is a step that the picture reads', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 64, usage: STORAGE | COPY_DST });
    const texture = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    device.queue.writeBuffer(buffer, 16, new Uint32Array([9, 9]));
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    present(device, context, texture);
    expect(context.content().webgpu!.passes.map((p) => p.k)).toEqual(['compute', 'writeBuffer', 'compute', 'render']);
  });

  it('reads a buffer a pass wrote by its id in a later render pass, as a vertex buffer, and says it was read', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 64, usage: STORAGE | GPU_BUFFER_USAGE.VERTEX });
    const texture = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    const module = device.createShaderModule({ code: PRESENT });
    const draw = device.createRenderPipeline({ layout: 'auto', vertex: { module, buffers: [{ arrayStride: 4, attributes: [{ format: 'float32', offset: 0, shaderLocation: 0 }] }] }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(draw);
    pass.setVertexBuffer(0, buffer);
    pass.setBindGroup(0, device.createBindGroup({ layout: draw.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    const render = webgpu.passes.find((p) => p.k === 'render')!;
    if (render.k !== 'render') throw new Error('not a render pass');
    const vertex = render.commands.find((c) => c.c === 'vertex')!;
    expect(vertex).toMatchObject({ buffer: buffer.key });
    expect(Object.keys(webgpu.buffers)).toEqual([]);
  });

  it('copies between buffers the GPU writes, from one it did not write, and clears them', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const a = device.createBuffer({ size: 64, usage: STORAGE | COPY_SRC | COPY_DST });
    const b = device.createBuffer({ size: 64, usage: STORAGE | COPY_SRC | COPY_DST });
    const c = device.createBuffer({ size: 64, usage: COPY_SRC | COPY_DST });
    device.queue.writeBuffer(c, 0, new Uint32Array([7, 7, 7, 7]));
    const texture = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, a, texture));
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(a, 0, b, 0, 32);
    encoder.copyBufferToBuffer(c, 0, a, 32, 16);
    encoder.clearBuffer(a, 0, 16);
    device.queue.submit([encoder.finish()]);
    expect(a.gpu && b.gpu).toBe(true);
    expect(c.gpu).toBe(false);
    // Nothing is drawn yet, so every step is kept (a picture that read the buffers would keep these too).
    const steps = context.content().webgpu!.passes.map((p) => p.k);
    expect(steps).toEqual(['compute', 'copyBuffer', 'writeBuffer', 'clearBuffer']);
  });

  it('refuses a copy of a buffer the GPU wrote into a texture: it cannot be recorded', async () => {
    const { device } = await setup();
    const { layout, pipeline } = kernel(device);
    const buffer = device.createBuffer({ size: 1024, usage: STORAGE | COPY_SRC });
    const texture = storageTexture(device, 'rgba8unorm', { usage: STORAGE_BINDING | TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST });
    dispatch(device, pipeline, bindings(device, layout, buffer, texture));
    const encoder = device.createCommandEncoder();
    expect(() => encoder.copyBufferToTexture({ buffer, bytesPerRow: 256 }, { texture }, [4, 2])).toThrow(/^unsupported: copyBufferToTexture from a buffer a pass wrote/);
  });

  it('refuses a buffer of a size the device does not hold and a usage that is not one', async () => {
    const { device } = await setup();
    expect(() => device.createBuffer({ size: 256 * 1024 * 1024 + 4, usage: STORAGE })).toThrow(/at most 268435456 bytes/);
    expect(() => device.createBuffer({ size: 4, usage: 0 })).toThrow(/usage 0/);
    expect(() => device.createBuffer({ size: 4, usage: 4096 })).toThrow(/usage 4096/);
    expect(() => device.createBuffer({ size: 4, usage: STORAGE })).not.toThrow();
  });
});

describe('the log of a frame: what it depends on', () => {
  it('drops a pass whose result nothing in the picture reads', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const used = storageTexture(device);
    const unused = storageTexture(device);
    dispatch(device, pipeline, bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), unused));
    dispatch(device, pipeline, bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), used));
    present(device, context, used);
    const webgpu = context.content().webgpu!;
    // Both passes write a buffer each; the one that wrote `unused` and its buffer is not read by anything.
    expect(computeSteps(webgpu)).toHaveLength(1);
    expect(Object.keys(webgpu.textures!)).toEqual([used.id]);
  });

  it('keeps the earlier frames\' compute passes a texture still depends on, and says the frame is not pure', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const state = storageTexture(device);
    const group = bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), state);
    // Each frame runs a pass that may leave part of `state` as it was. The first frame's is the page's setup.
    for (let frame = 0; frame < 3; frame += 1) {
      context.resetState();
      dispatch(device, pipeline, group);
      present(device, context, state);
      const webgpu = context.content().webgpu!;
      expect(computeSteps(webgpu)).toHaveLength(frame + 1);
      if (frame < 2) expect(webgpu.impure).toBeUndefined();
      else expect(webgpu.impure).toEqual([expect.stringMatching(/reads state made in earlier frames \(1 compute pass\)/)]);
    }
  });

  it('forgets earlier frames once a whole write covers what they made, so the frame is the same alone', async () => {
    const { device, context } = await setup();
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, storageTexture: { format: 'rgba8unorm' } }] });
    const module = device.createShaderModule({ code: '@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>; @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, vec2i(id.xy), vec4f(1)); }' });
    const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module } });
    const state = storageTexture(device, 'rgba8unorm', { usage: STORAGE_BINDING | TEXTURE_BINDING | RENDER_ATTACHMENT });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: state.createView() }] });
    const frame = (): string => {
      context.resetState();
      // A render pass that clears the whole texture, then the compute pass writes into it, then the canvas reads it.
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: state.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
      device.queue.submit([encoder.finish()]);
      dispatch(device, pipeline, group);
      present(device, context, state);
      return JSON.stringify(context.content());
    };
    const first = frame();
    const second = frame();
    const third = frame();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(context.content().webgpu!.impure).toBeUndefined();
  });

  it('is the same whichever frames were drawn before it, for a page that redraws what it reads', async () => {
    const draw = async (frames: number): Promise<string> => {
      const { device, context } = await setup();
      const { layout, pipeline } = kernel(device);
      const state = storageTexture(device);
      const buffer = device.createBuffer({ size: 64, usage: STORAGE | COPY_DST });
      const group = bindings(device, layout, buffer, state);
      for (let n = 0; n < frames; n += 1) {
        context.resetState();
        device.queue.writeBuffer(buffer, 0, new Uint32Array([n]));
        dispatch(device, pipeline, group, n + 1);
        present(device, context, state);
      }
      return JSON.stringify(context.content().webgpu!.passes.slice(-1));
    };
    expect(await draw(4)).toBe(await draw(4));
  });
});

describe('limits from the device', () => {
  it('reports the limits the engine\'s device has, and the adapter\'s are the same', async () => {
    const gpu = createGpu({ info: () => ({ features: [], limits: { maxComputeInvocationsPerWorkgroup: 128, maxComputeWorkgroupSizeX: 128, maxStorageTexturesPerShaderStage: 8 } }) });
    const adapter = await gpu.requestAdapter();
    expect(adapter.limits.maxComputeInvocationsPerWorkgroup).toBe(128);
    expect(adapter.limits.maxComputeWorkgroupsPerDimension).toBe(65535);
    const device = await adapter.requestDevice();
    expect(device.limits).toMatchObject({ maxComputeInvocationsPerWorkgroup: 128, maxComputeWorkgroupSizeX: 128, maxStorageTexturesPerShaderStage: 8 });
    expect(device.limits).toEqual(adapter.limits);
    // They are enforced: a pipeline over 128 invocations, a layout of 8 storage textures.
    const module = device.createShaderModule({ code: '@compute @workgroup_size(16, 16) fn main() {}' });
    expect(() => device.createComputePipeline({ layout: 'auto', compute: { module } })).toThrow(/256 invocations; the device allows 128/);
    expect(() => device.createBindGroupLayout({ entries: Array.from({ length: 8 }, (_, binding) => ({ binding, visibility: COMPUTE, storageTexture: { format: 'rgba8unorm' } })) })).not.toThrow();
  });

  it('is the WebGPU defaults without an engine device to ask', async () => {
    const { device } = await setup();
    expect(device.limits).toMatchObject({
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 8,
      maxStorageTexturesPerShaderStage: 4,
      maxStorageBufferBindingSize: 134217728,
    });
  });

  it('refuses a device that asks for more than the engine\'s, and for a limit that is not one', async () => {
    const adapter = await createGpu().requestAdapter();
    await expect(adapter.requestDevice({ requiredLimits: { maxComputeInvocationsPerWorkgroup: 1024 } })).rejects.toThrow(/better than the engine's device has \(256\)/);
    await expect(adapter.requestDevice({ requiredLimits: { maxStorageTexturesPerShaderStage: 5 } })).rejects.toThrow(/maxStorageTexturesPerShaderStage 5/);
    // A smaller alignment is better; a larger one is not.
    await expect(adapter.requestDevice({ requiredLimits: { minStorageBufferOffsetAlignment: 64 } })).rejects.toThrow(/minStorageBufferOffsetAlignment/);
    await expect(adapter.requestDevice({ requiredLimits: { minStorageBufferOffsetAlignment: 256 } })).resolves.toBeDefined();
    await expect(adapter.requestDevice({ requiredLimits: { maxComputeInvocationsPerWorkgroup: 128 } })).resolves.toBeDefined();
    await expect(adapter.requestDevice({ requiredLimits: { maxNoSuchThing: 1 } })).rejects.toThrow(/not a limit/);
    await expect(adapter.requestDevice({ requiredLimits: { maxBindGroups: undefined } })).resolves.toBeDefined();
  });
});

describe('caps on the work a frame holds', () => {
  it('refuses more dispatches than a frame may hold, and more workgroups, when they are all still needed', async () => {
    const { device, context } = await setup();
    const { layout, pipeline } = kernel(device);
    const state = storageTexture(device);
    const group = bindings(device, layout, device.createBuffer({ size: 64, usage: STORAGE }), state);
    const heavy = (x: number) => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, x);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    // 4096 x 4096 is 2^24 workgroups: four are the cap of 2^26, a fifth is over.
    for (let n = 0; n < 4; n += 1) heavy(4096);
    expect(() => heavy(4096)).toThrow(/5 dispatches and 83886080 workgroups; a frame may hold 4096 and 67108864/);
    present(device, context, state);
    expect(context.content().webgpu!.passes.length).toBeGreaterThan(0);
  });
});
