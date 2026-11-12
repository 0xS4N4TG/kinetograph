import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_TEXTURE_USAGE,
  WebGpuUnsupportedError,
  type GPUDeviceShim,
  type GPUCanvasContextShim,
  type GlslContent,
  type WebGpuPass,
} from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING, COPY_DST } = GPU_TEXTURE_USAGE;

const WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0.5, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 8 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

function pipeline(device: GPUDeviceShim, depthStencil?: object) {
  const module = device.createShaderModule({ code: WGSL });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    ...(depthStencil ? { depthStencil } : {}),
  } as never);
}

const LESS = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

function draw(device: GPUDeviceShim, context: GPUCanvasContextShim, depth: unknown, state: object | null = LESS): GlslContent {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    ...(depth === undefined ? {} : { depthStencilAttachment: depth }),
  } as never);
  pass.setPipeline(pipeline(device, state ?? undefined));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return context.content();
}

function depthTexture(device: GPUDeviceShim, extra: object = {}) {
  return device.createTexture({ size: [8, 8], format: 'depth24plus', usage: RENDER_ATTACHMENT | TEXTURE_BINDING, ...extra } as never);
}

const attachment = (device: GPUDeviceShim) => ({ view: depthTexture(device).createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' });

describe('depth attachments', () => {
  it('records the depth state of the pipeline and the depth attachment of the pass', async () => {
    const { device, context } = await setup();
    const content = draw(device, context, attachment(device));
    const webgpu = content.webgpu!;
    const pass = webgpu.passes[0] as WebGpuPass;
    expect(pass.depth).toEqual({ texture: expect.stringMatching(/^t\d+$/), mip: 0, clear: 1 });
    expect(Object.values(webgpu.pipelines)[0]!.depth).toEqual({ format: 'depth24plus', write: true, compare: 'less' });
    expect(webgpu.textures![pass.depth!.texture]).toMatchObject({ format: 'depth24plus', width: 8, height: 8 });
  });

  it('records loadOp load as no clear and a read-only attachment as readOnly', async () => {
    const { device, context } = await setup();
    const view = depthTexture(device).createView();
    const loaded = draw(device, context, { view, depthLoadOp: 'load', depthStoreOp: 'store' });
    expect((loaded.webgpu!.passes.at(-1) as WebGpuPass).depth).toMatchObject({ clear: null });
    const readOnly = draw(device, context, { view, depthReadOnly: true }, { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' });
    expect((readOnly.webgpu!.passes.at(-1) as WebGpuPass).depth).toMatchObject({ readOnly: true });
  });

  it('refuses a pipeline whose depth state does not match the pass, at setPipeline', async () => {
    const { device, context } = await setup();
    expect(() => draw(device, context, undefined, LESS)).toThrow(/a depth24plus depth state and the pass has no depth attachment/);
    expect(() => draw(device, context, attachment(device), null)).toThrow(/no depth state and the pass has a depth24plus depth attachment/);
    const other = { format: 'depth16unorm', depthWriteEnabled: true, depthCompare: 'less' };
    expect(() => draw(device, context, attachment(device), other)).toThrow(/depth16unorm depth state and the pass has a depth24plus/);
    const readOnly = { view: depthTexture(device).createView(), depthReadOnly: true };
    expect(() => draw(device, context, readOnly, LESS)).toThrow(/writes depth and the pass depth attachment is read-only/);
  });

  it('refuses a depth attachment of the wrong size, samples, format, usage or clear value', async () => {
    const { device, context } = await setup();
    const make = (extra: object) => ({ ...attachment(device), view: depthTexture(device, extra).createView() });
    expect(() => draw(device, context, make({ size: [4, 4] }))).toThrow(/4 x 4 and the colour attachment 8 x 8/);
    expect(() => draw(device, context, make({ sampleCount: 4 }))).toThrow(/4 samples and the colour attachment 1/);
    expect(() => draw(device, context, make({ usage: TEXTURE_BINDING }))).toThrow(/RENDER_ATTACHMENT/);
    expect(() => draw(device, context, { ...attachment(device), depthClearValue: 2 })).toThrow(/not from 0 to 1/);
    expect(() => draw(device, context, { ...attachment(device), depthLoadOp: undefined })).toThrow(/needs depthLoadOp and depthStoreOp/);
    const colour = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: RENDER_ATTACHMENT });
    expect(() => draw(device, context, { ...attachment(device), view: colour.createView() })).toThrow(WebGpuUnsupportedError);
  });

  it('refuses the stencil, which is not drawn, and a stencil format', async () => {
    const { device } = await setup();
    expect(() => pipeline(device, { ...LESS, stencilFront: { compare: 'equal' } })).toThrow(WebGpuUnsupportedError);
    expect(() => pipeline(device, { ...LESS, stencilBack: { passOp: 'replace' } })).toThrow(/stencil state/);
    expect(() => pipeline(device, { ...LESS, format: 'depth24plus-stencil8' })).toThrow(WebGpuUnsupportedError);
    expect(() => pipeline(device, { ...LESS, depthCompare: 'sometimes' })).toThrow(/depthCompare/);
  });

  it('refuses to write a depth texture from the queue', async () => {
    const { device } = await setup();
    const texture = depthTexture(device, { usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST });
    expect(() => device.queue.writeTexture({ texture } as never, new Uint8Array(256), { bytesPerRow: 32 }, [8, 8])).toThrow(WebGpuUnsupportedError);
  });
});

describe('depth textures and comparison samplers', () => {
  it('lets a layout bind a depth texture with a comparison sampler, and checks the pairing', async () => {
    const { device } = await setup();
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: 2, sampler: { type: 'comparison' } },
      ],
    } as never);
    const view = depthTexture(device).createView();
    const comparing = device.createSampler({ compare: 'less-equal' });
    const plain = device.createSampler({});
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: comparing }] } as never)).not.toThrow();
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: plain }] } as never)).toThrow(/comparison sampler in the layout and the sampler does not compare/);
    const colour = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: TEXTURE_BINDING }).createView();
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: colour }, { binding: 1, resource: comparing }] } as never)).toThrow(/samples a rgba8unorm texture as depth/);
    expect(() => device.createSampler({ compare: 'sometimes' } as never)).toThrow(/compare/);
  });

  it('records the compare function in the sampler so that samplers differing in it are two', async () => {
    const { device } = await setup();
    expect(device.createSampler({ compare: 'less' }).descriptor).toEqual({ compare: 'less' });
    expect(device.createSampler({ compare: 'less' }).id).not.toBe(device.createSampler({ compare: 'greater' }).id);
  });

  it('lets a depth texture be bound as unfilterable-float but not as float', async () => {
    const { device } = await setup();
    const view = depthTexture(device).createView();
    const as = (sampleType: string) =>
      device.createBindGroup({ layout: device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { sampleType } }] } as never), entries: [{ binding: 0, resource: view }] } as never);
    expect(() => as('unfilterable-float')).not.toThrow();
    expect(() => as('float')).toThrow(/as float/);
  });
});
