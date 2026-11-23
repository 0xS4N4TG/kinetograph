import { describe, expect, it } from 'vitest';
import { createGpu, createGpuCanvasContext, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE, WebGpuUnsupportedError, type GPUCanvasContextShim, type GPUDeviceShim, type WebGpuPass } from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING, STORAGE_BINDING, COPY_DST, COPY_SRC } = GPU_TEXTURE_USAGE;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 4, height: 4 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const volume = (device: GPUDeviceShim, size: number[] = [4, 4, 4], extra: object = {}) =>
  device.createTexture({ size, dimension: '3d', format: 'rgba8unorm', usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST | COPY_SRC, mipLevelCount: 2, ...extra } as never);

const FULL = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }`;
const SOLID = `${FULL} @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`;
const LOAD = `${FULL} @group(0) @binding(0) var t: texture_3d<f32>; @fragment fn fs() -> @location(0) vec4f { return textureLoad(t, vec3i(0, 0, 1), 0); }`;

describe('3d textures', () => {
  it('makes a 3d texture, whose levels halve in depth, and says so in the recording', async () => {
    const { device, context } = await setup();
    const texture = volume(device);
    expect(texture).toMatchObject({ dimension: '3d', depthOrArrayLayers: 4 });
    expect(texture.depthAt(0)).toBe(4);
    expect(texture.depthAt(1)).toBe(2);
    const module = device.createShaderModule({ code: LOAD });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const encoder = device.createCommandEncoder();
    const into = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), depthSlice: 1, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] } as never);
    into.end();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    expect(webgpu.textures![texture.id]).toMatchObject({ width: 4, height: 4, layers: 4, dimension: '3d', mips: 2 });
    const passes = webgpu.passes as WebGpuPass[];
    expect(passes[0]).toMatchObject({ k: 'render', target: { texture: texture.id, mip: 0, layer: 1 } });
    expect(Object.values(webgpu.bindGroups!)[0]!.entries[0]).toMatchObject({ texture: { dimension: '3d' } });
  });

  it('refuses the sizes, formats and views a 3d texture cannot have', async () => {
    const { device } = await setup();
    expect(() => volume(device, [4, 4, 2049])).toThrow(/2049 slices/);
    expect(() => volume(device, [4, 4, 4], { mipLevelCount: 4 })).toThrow(/at most 3/);
    expect(() => volume(device, [4, 4, 4], { format: 'depth24plus' })).toThrow(/depth format/);
    expect(() => volume(device, [4, 4, 4], { sampleCount: 4 })).toThrow(/one sample/);
    expect(() => volume(device).createView({ dimension: '2d' })).toThrow(/3d views/);
    expect(() => volume(device).createView({ dimension: '3d', baseArrayLayer: 1 })).toThrow(/baseArrayLayer 0/);
    expect(() => device.createTexture({ size: [4, 4, 1], dimension: '3d', format: 'rgba8unorm', usage: TEXTURE_BINDING }).createView({ dimension: '2d-array' })).toThrow(/3d views/);
    expect(() => device.createTexture({ size: [4, 4, 1], dimension: '1d', format: 'rgba8unorm', usage: TEXTURE_BINDING } as never)).toThrow(WebGpuUnsupportedError);
    expect(() => device.createTexture({ size: [4, 4, 1], format: 'rgba8unorm', usage: TEXTURE_BINDING }).createView({ dimension: '3d' })).toThrow(/3d view of a 2d texture/);
  });

  it('draws into one slice, named by depthSlice, of a level that has it', async () => {
    const { device } = await setup();
    const texture = volume(device);
    const draw = (view: object, depthSlice?: number) => device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view, depthSlice, loadOp: 'clear', storeOp: 'store' }] } as never);
    expect(() => draw(texture.createView({ mipLevelCount: 1 }))).toThrow(/depthSlice undefined/);
    expect(() => draw(texture.createView({ mipLevelCount: 1 }), 4)).toThrow(/depthSlice 4/);
    expect(() => draw(texture.createView({ baseMipLevel: 1, mipLevelCount: 1 }), 2)).toThrow(/depthSlice 2 of a 3d texture with 2 slices/);
    expect(() => draw(texture.createView({ baseMipLevel: 1, mipLevelCount: 1 }), 1)).not.toThrow();
    const flat = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: RENDER_ATTACHMENT });
    expect(() => draw(flat.createView(), 0)).toThrow(/depthSlice is for the view of a 3d texture/);
  });

  it('binds a 3d view to a 3d layout entry, as a sampled or a storage texture', async () => {
    const { device } = await setup();
    const texture = device.createTexture({ size: [4, 4, 4], dimension: '3d', format: 'rgba8unorm', usage: TEXTURE_BINDING | STORAGE_BINDING });
    const view = texture.createView();
    const sampled = (viewDimension?: string) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, texture: { viewDimension } }] } as never);
    expect(() => device.createBindGroup({ layout: sampled(), entries: [{ binding: 0, resource: view }] })).toThrow(/2d texture in the layout and the view is a 3d view/);
    expect(() => device.createBindGroup({ layout: sampled('3d'), entries: [{ binding: 0, resource: view }] })).not.toThrow();
    const storage = (viewDimension?: string) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension } }] } as never);
    expect(storage('3d').entries[0]).toMatchObject({ type: 'storage-texture', viewDimension: '3d' });
    expect(() => device.createBindGroup({ layout: storage(), entries: [{ binding: 0, resource: view }] })).toThrow(/2d view dimension in the layout and its view is a 3d view/);
    expect(() => device.createBindGroup({ layout: storage('3d'), entries: [{ binding: 0, resource: view }] })).not.toThrow();
    expect(() => storage('2d-array')).toThrow(WebGpuUnsupportedError);
  });

  it('writes and copies slices: origin z is the slice, and a level has half as many', async () => {
    const { device } = await setup();
    const texture = volume(device);
    const data = new Uint8Array(4 * 4 * 4);
    expect(() => device.queue.writeTexture({ texture, origin: [0, 0, 3] }, data, { bytesPerRow: 16 }, [4, 4, 1])).not.toThrow();
    expect(() => device.queue.writeTexture({ texture, origin: [0, 0, 4] }, data, { bytesPerRow: 16 }, [4, 4, 1])).toThrow(/outside the 4 slices/);
    expect(() => device.queue.writeTexture({ texture, mipLevel: 1, origin: [0, 0, 2] }, data, { bytesPerRow: 8 }, [2, 2, 1])).toThrow(/outside the 2 slices/);
  });
});
