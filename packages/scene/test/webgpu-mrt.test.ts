import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_TEXTURE_USAGE,
  WebGpuUnsupportedError,
  type GPUCanvasContextShim,
  type GPUDeviceShim,
  type WebGpuPass,
} from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING } = GPU_TEXTURE_USAGE;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 4, height: 4 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const target = (device: GPUDeviceShim, format = 'rgba8unorm', size = [4, 4]) => device.createTexture({ size, format, usage: RENDER_ATTACHMENT | TEXTURE_BINDING } as never);

const WGSL = `
struct Out { @location(0) a: vec4f, @location(1) b: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
@fragment fn fs() -> Out { var o: Out; o.a = vec4f(1, 0, 0, 1); o.b = vec4f(0, 1, 0, 1); return o; }`;

function pipeline(device: GPUDeviceShim, formats: (string | null)[]) {
  const module = device.createShaderModule({ code: WGSL });
  return device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: formats.map((format) => (format === null ? null : { format })) } } as never);
}

const attachment = (texture: ReturnType<typeof target>, extra: object = {}) => ({ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1], ...extra });

/** A canvas pass that samples `texture`, so that the passes that drew it are steps of the frame. */
function reads(device: GPUDeviceShim, context: GPUCanvasContextShim, texture: ReturnType<typeof target>, encoder: ReturnType<GPUDeviceShim['createCommandEncoder']>): void {
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var tex: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
      @fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(q.xy), 0); }`,
  });
  const read = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const canvas = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  canvas.setPipeline(read);
  canvas.setBindGroup(0, device.createBindGroup({ layout: read.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
  canvas.draw(3);
  canvas.end();
}

describe('several colour attachments', () => {
  it('records the first as the pass target and the others as `more`, each with its own clear or load', async () => {
    const { device, context } = await setup();
    const [a, b] = [target(device), target(device, 'rgba16float')];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [attachment(a), attachment(b, { loadOp: 'load' })] } as never);
    pass.setPipeline(pipeline(device, ['rgba8unorm', 'rgba16float']));
    pass.draw(3);
    pass.end();
    reads(device, context, a, encoder);
    device.queue.submit([encoder.finish()]);
    const [first] = context.content().webgpu!.passes as WebGpuPass[];
    expect(first).toMatchObject({ target: { texture: a.id, mip: 0 }, clear: [0, 0, 0, 1], more: [{ texture: b.id, mip: 0, clear: null }] });
    expect(context.content().webgpu!.notes).toBeUndefined();
  });

  it('keeps the pass for a frame that samples any one of its attachments', async () => {
    const { device, context } = await setup();
    const [a, b] = [target(device), target(device)];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [attachment(a), attachment(b, { clearValue: [0.5, 0, 0, 1] })] } as never);
    pass.setPipeline(pipeline(device, ['rgba8unorm', 'rgba8unorm']));
    pass.draw(3);
    pass.end();
    reads(device, context, b, encoder);
    device.queue.submit([encoder.finish()]);
    const [first] = context.content().webgpu!.passes as WebGpuPass[];
    expect(first).toMatchObject({ k: 'render', target: { texture: a.id, mip: 0 }, clear: [0, 0, 0, 1], more: [{ texture: b.id, mip: 0, clear: [0.5, 0, 0, 1] }] });
    expect(context.content().webgpu!.notes).toBeUndefined();
  });

  it('records the resolve target of each multisampled attachment', async () => {
    const { device, context } = await setup();
    const multi = (device: GPUDeviceShim) => device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: RENDER_ATTACHMENT, sampleCount: 4 });
    const [m0, m1, r0, r1] = [multi(device), multi(device), target(device), target(device)];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [attachment(m0, { resolveTarget: r0.createView() }), attachment(m1, { resolveTarget: r1.createView() })],
    } as never);
    pass.end();
    reads(device, context, r1, encoder);
    device.queue.submit([encoder.finish()]);
    const [first] = context.content().webgpu!.passes as WebGpuPass[];
    expect(first).toMatchObject({ target: { texture: m0.id }, resolve: { texture: r0.id }, more: [{ texture: m1.id, resolve: { texture: r1.id, mip: 0 } }] });
  });

  it('checks the pipeline against all the attachments, slot for slot', async () => {
    const { device } = await setup();
    const [a, b] = [target(device), target(device, 'rgba16float')];
    const pass = () => device.createCommandEncoder().beginRenderPass({ colorAttachments: [attachment(a), attachment(b)] } as never);
    expect(() => pass().setPipeline(pipeline(device, ['rgba8unorm', 'rgba16float']))).not.toThrow();
    expect(() => pass().setPipeline(pipeline(device, ['rgba8unorm', 'rgba8unorm']))).toThrow(/draws rgba8unorm, rgba8unorm and the pass draws into rgba8unorm, rgba16float/);
    expect(() => pass().setPipeline(pipeline(device, ['rgba8unorm']))).toThrow(/pass draws into/);
  });

  it('refuses attachments that differ in size or samples, repeat a level, or sample what the pass draws', async () => {
    const { device } = await setup();
    const a = target(device);
    const begin = (...attachments: unknown[]) => () => device.createCommandEncoder().beginRenderPass({ colorAttachments: attachments } as never);
    expect(begin(attachment(a), attachment(target(device, 'rgba8unorm', [8, 4])))).toThrow(/another size or sample count/);
    expect(begin(attachment(a), attachment(a))).toThrow(/another attachment draws into/);
    const levels = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: RENDER_ATTACHMENT | TEXTURE_BINDING, mipLevelCount: 2 });
    expect(begin(attachment(a), { ...attachment(levels), view: levels.createView({ baseMipLevel: 0, mipLevelCount: 1 }) })).not.toThrow();
    expect(begin(...Array.from({ length: 9 }, () => attachment(target(device))))).toThrow(/9 colour attachments; the device allows 8/);
    // A pass that samples one of the textures it writes.
    const b = target(device);
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [attachment(a), attachment(b)] } as never);
    const module = device.createShaderModule({ code: `@group(0) @binding(0) var t: texture_2d<f32>; @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }` });
    const sampler = device.createRenderPipeline({ layout: 'auto', vertex: { module } });
    expect(() => pass.setBindGroup(0, device.createBindGroup({ layout: sampler.getBindGroupLayout(0), entries: [{ binding: 0, resource: b.createView() }] }))).toThrow(/samples the level of the texture it draws into/);
  });

  it("says the canvas's texture cannot be one of several attachments", async () => {
    const { device, context } = await setup();
    const canvas = { view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' };
    expect(() => device.createCommandEncoder().beginRenderPass({ colorAttachments: [attachment(target(device)), canvas] } as never)).toThrow(WebGpuUnsupportedError);
    expect(context.content().webgpu!.notes).toEqual([expect.stringContaining('canvas')]);
  });
});
