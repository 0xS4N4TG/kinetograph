import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_SHADER_STAGE,
  GPU_TEXTURE_USAGE,
  WebGpuUnsupportedError,
  type GPUCanvasContextShim,
  type GPUDeviceShim,
  type WebGpuPass,
  type WebGpuStep,
} from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING, COPY_SRC, COPY_DST } = GPU_TEXTURE_USAGE;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 4, height: 4 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const layers = (device: GPUDeviceShim, count = 3, extra: object = {}) =>
  device.createTexture({ size: [4, 4, count], format: 'rgba8unorm', usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC | COPY_DST, ...extra } as never);

const FULL = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }`;
const SOLID = `${FULL} @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`;
const SAMPLE = `${FULL}
  @group(0) @binding(0) var tex: texture_2d_array<f32>;
  @fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(q.xy), 1, 0); }`;

/** Draws one full-screen triangle into the layer `layer` of `texture` (`clear`ed first). */
function drawInto(device: GPUDeviceShim, texture: ReturnType<typeof layers>, layer: number, encoder = device.createCommandEncoder()) {
  const module = device.createShaderModule({ code: SOLID });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: texture.createView({ dimension: '2d', baseArrayLayer: layer }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
  } as never);
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  return encoder;
}

/** A canvas pass that samples layer `layer` of `texture` as a 2d view. */
function sample(device: GPUDeviceShim, context: GPUCanvasContextShim, texture: ReturnType<typeof layers>, layer: number, encoder = device.createCommandEncoder()) {
  const module = device.createShaderModule({
    code: `${FULL} @group(0) @binding(0) var tex: texture_2d<f32>; @fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(q.xy), 0); }`,
  });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView({ dimension: '2d', baseArrayLayer: layer }) }] }));
  pass.draw(3);
  pass.end();
  return encoder;
}

describe('textures with array layers', () => {
  it('makes an array of 2d textures and says so in the recording', async () => {
    const { device, context } = await setup();
    const texture = layers(device);
    expect(texture).toMatchObject({ dimension: '2d', depthOrArrayLayers: 3 });
    const encoder = drawInto(device, texture, 1);
    sample(device, context, texture, 1, encoder);
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    expect(webgpu.textures![texture.id]).toMatchObject({ width: 4, height: 4, layers: 3, format: 'rgba8unorm' });
    expect(webgpu.notes).toBeUndefined();
  });

  it('gives a view the dimension and layers the spec defaults to', async () => {
    const { device } = await setup();
    const texture = layers(device, 4);
    expect(texture.createView()).toMatchObject({ dimension: '2d-array', baseLayer: 0, layers: 4 });
    expect(texture.createView({ baseArrayLayer: 1 })).toMatchObject({ dimension: '2d-array', baseLayer: 1, layers: 3 });
    expect(texture.createView({ dimension: '2d', baseArrayLayer: 2 })).toMatchObject({ dimension: '2d', baseLayer: 2, layers: 1 });
    expect(texture.createView({ dimension: '2d-array', baseArrayLayer: 1, arrayLayerCount: 2 })).toMatchObject({ baseLayer: 1, layers: 2 });
    expect(device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: TEXTURE_BINDING }).createView()).toMatchObject({ dimension: '2d', layers: 1 });
    expect(device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: TEXTURE_BINDING }).createView({ dimension: '2d-array' })).toMatchObject({ dimension: '2d-array', layers: 1 });
    expect(() => texture.createView({ dimension: '2d', arrayLayerCount: 2 })).toThrow(/one layer/);
    expect(() => texture.createView({ baseArrayLayer: 4 })).toThrow(/baseArrayLayer 4/);
    expect(() => texture.createView({ baseArrayLayer: 3, arrayLayerCount: 2 })).toThrow(/layers 3..5/);
    expect(() => texture.createView({ dimension: '1d' })).toThrow(WebGpuUnsupportedError);
  });

  it('records a pass into one layer, and keeps it only when that layer is read', async () => {
    const { device, context } = await setup();
    const texture = layers(device);
    const encoder = drawInto(device, texture, 2);
    drawInto(device, texture, 0, encoder);
    sample(device, context, texture, 0, encoder);
    device.queue.submit([encoder.finish()]);
    const steps = context.content().webgpu!.passes as WebGpuPass[];
    // The pass into layer 2 wrote something nothing reads: left out.
    expect(steps.map((s) => s.target)).toEqual([{ texture: texture.id, mip: 0 }, undefined]);
    context.resetState();
    const layer1 = layers(device);
    const second = drawInto(device, layer1, 1);
    sample(device, context, layer1, 1, second);
    device.queue.submit([second.finish()]);
    const [pass] = context.content().webgpu!.passes as WebGpuPass[];
    expect(pass!.target).toEqual({ texture: layer1.id, mip: 0, layer: 1 });
  });

  it('refuses a colour or depth attachment of more than one layer', async () => {
    const { device } = await setup();
    const texture = layers(device);
    const begin = (view: unknown) => () => device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] } as never);
    expect(begin(texture.createView({ dimension: '2d-array', baseArrayLayer: 1, arrayLayerCount: 1 }))).not.toThrow();
    expect(begin(texture.createView())).toThrow(/one array layer/);
    const depth = device.createTexture({ size: [4, 4, 2], format: 'depth24plus', usage: RENDER_ATTACHMENT });
    const colour = layers(device, 1);
    const withDepth = (view: unknown) => () =>
      device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: colour.createView(), loadOp: 'clear', storeOp: 'store' }], depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } } as never);
    expect(withDepth(depth.createView({ dimension: '2d', baseArrayLayer: 1 }))).not.toThrow();
    expect(withDepth(depth.createView())).toThrow(/one array layer/);
  });

  it('writes layers one at a time, from the origin or as a run of layers', async () => {
    const { device, context } = await setup();
    const texture = layers(device);
    const rows = new Uint8Array(4 * 4 * 4 * 2).map((_, i) => i);
    device.queue.writeTexture({ texture, origin: [0, 0, 1] }, rows, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 2]);
    const encoder = sample(device, context, texture, 1);
    sample(device, context, texture, 2, encoder);
    device.queue.submit([encoder.finish()]);
    const uploads = (context.content().webgpu!.passes as WebGpuStep[]).filter((s) => s.k === 'upload');
    expect(uploads.map((u) => (u as { layer?: number }).layer)).toEqual([1, 2]);
    const blob = (u: WebGpuStep) => Buffer.from(context.content().webgpu!.blobs![(u as { source: { raw: string } }).source.raw]!, 'base64');
    expect([...blob(uploads[0]!).subarray(0, 3)]).toEqual([0, 1, 2]);
    expect([...blob(uploads[1]!).subarray(0, 3)]).toEqual([64, 65, 66]);
    expect(() => device.queue.writeTexture({ texture }, rows, { bytesPerRow: 16 }, [4, 4, 2])).toThrow(/rowsPerImage is needed/);
    expect(() => device.queue.writeTexture({ texture }, rows, { bytesPerRow: 16, rowsPerImage: 3 }, [4, 4, 2])).toThrow(/rowsPerImage 3 is less/);
    expect(() => device.queue.writeTexture({ texture, origin: [0, 0, 2] }, rows, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 2])).toThrow(/outside the 3 layers/);
    expect(() => device.queue.writeTexture({ texture }, rows.subarray(0, 100), { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 2])).toThrow(/reads past/);
  });

  it('copies between layers, a layer at a time, and refuses overlapping layers of one texture', async () => {
    const { device, context } = await setup();
    const texture = layers(device, 4);
    const other = layers(device, 2);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture, origin: [0, 0, 1] }, { texture: other }, [4, 4, 2]);
    sample(device, context, other, 1, encoder);
    device.queue.submit([encoder.finish()]);
    const copies = (context.content().webgpu!.passes as WebGpuStep[]).filter((s) => s.k === 'copy') as { from: { layer?: number }; to: { layer?: number } }[];
    // The copy into layer 0 of `other` is not read (the pass samples layer 1), so only the second one is a step of the frame.
    expect(copies.map((c) => [c.from.layer, c.to.layer])).toEqual([[2, 1]]);
    const bad = device.createCommandEncoder();
    expect(() => bad.copyTextureToTexture({ texture, origin: [0, 0, 0] }, { texture, origin: [0, 0, 1] }, [4, 4, 2])).toThrow(/share a level and a layer/);
    expect(() => bad.copyTextureToTexture({ texture, origin: [0, 0, 0] }, { texture, origin: [0, 0, 2] }, [4, 4, 2])).not.toThrow();
    expect(() => bad.copyTextureToTexture({ texture, origin: [0, 0, 3] }, { texture: other }, [4, 4, 2])).toThrow(/outside the 4 layers/);
  });

  it('copies an image into a layer, and only one layer at a time', async () => {
    const { device } = await setup();
    const texture = layers(device);
    const source = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    const imageData = { width: 4, height: 4, data: source.data, colorSpace: 'srgb' };
    expect(() => device.queue.copyExternalImageToTexture({ source: imageData as never }, { texture, origin: [0, 0, 1] }, [4, 4, 2])).toThrow(/one, the layer being the origin/);
  });
});

describe('binding a texture array', () => {
  it('accepts a 2d-array binding for a 2d-array view, records the view, and refuses the other combinations', async () => {
    const { device, context } = await setup();
    const texture = layers(device, 2);
    const module = device.createShaderModule({ code: SAMPLE });
    const bindGroupLayout = (viewDimension?: string) =>
      device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, texture: { ...(viewDimension ? { viewDimension } : {}) } }] });
    const array = bindGroupLayout('2d-array');
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [array] }),
      vertex: { module },
      fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    });
    const group = (layout: ReturnType<typeof bindGroupLayout>, view: unknown) => () => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view as never }] });
    expect(group(array, texture.createView())).not.toThrow();
    expect(group(array, texture.createView({ dimension: '2d', baseArrayLayer: 1 }))).toThrow(/2d-array texture in the layout and the view is a 2d view/);
    expect(group(bindGroupLayout(), texture.createView())).toThrow(/2d texture in the layout and the view is a 2d-array view/);
    expect(group(bindGroupLayout(), texture.createView({ dimension: '2d' }))).not.toThrow();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group(array, texture.createView({ baseArrayLayer: 1, arrayLayerCount: 1 }))());
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    expect(Object.values(webgpu.layouts)[0]).toEqual([expect.objectContaining({ type: 'texture', viewDimension: '2d-array' })]);
    expect(Object.values(webgpu.bindGroups)[0]!.entries[0]).toMatchObject({ texture: { id: texture.id, baseMip: 0, mips: 1, baseLayer: 1, dimension: '2d-array' } });
  });

  it('keeps a storage texture to one layer seen as 2d, and says layouts of other dimensions are not drawn', async () => {
    const { device } = await setup();
    const texture = device.createTexture({ size: [4, 4, 2], format: 'rgba8unorm', usage: GPU_TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_BINDING });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.COMPUTE, storageTexture: { format: 'rgba8unorm' } }] });
    const bind = (view: unknown) => () => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view as never }] });
    expect(bind(texture.createView({ dimension: '2d', baseArrayLayer: 1 }))).not.toThrow();
    expect(bind(texture.createView())).toThrow(/2d one/);
    expect(() => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { viewDimension: '1d' } }] })).toThrow(WebGpuUnsupportedError);
  });
});
