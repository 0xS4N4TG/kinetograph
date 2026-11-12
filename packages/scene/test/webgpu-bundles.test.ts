import { describe, expect, it } from 'vitest';
import { createGpu, createGpuCanvasContext, GPU_BUFFER_USAGE, WebGpuUnsupportedError, type GPUCanvasContextShim, type GPUDeviceShim, type WebGpuPass } from '../src/index.js';

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 4, height: 4 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const TRIANGLE = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
  @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }`;

function pipelineOf(device: GPUDeviceShim, format = 'rgba8unorm') {
  const module = device.createShaderModule({ code: TRIANGLE });
  return device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format }] } });
}

const canvasPass = (device: GPUDeviceShim, context: GPUCanvasContextShim, encoder = device.createCommandEncoder()) => ({
  encoder,
  pass: encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] }),
});

describe('render bundles', () => {
  it('runs the bundle commands in the pass, where executeBundles is', async () => {
    const { device, context } = await setup();
    const pipeline = pipelineOf(device);
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    bundle.setPipeline(pipeline);
    bundle.draw(3);
    const { encoder, pass } = canvasPass(device, context);
    pass.setScissorRect(0, 0, 2, 2);
    pass.executeBundles([bundle.finish()]);
    pass.setScissorRect(0, 0, 4, 4);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    const [pass0] = webgpu.passes as WebGpuPass[];
    expect(pass0!.commands.map((c) => c.c)).toEqual(['scissor', 'pipeline', 'draw', 'scissor']);
    expect(webgpu.notes).toBeUndefined();
  });

  it('runs one bundle in two passes', async () => {
    const { device, context } = await setup();
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    bundle.setPipeline(pipelineOf(device));
    bundle.draw(3);
    const done = bundle.finish();
    const encoder = device.createCommandEncoder();
    for (let n = 0; n < 2; n += 1) {
      const { pass } = canvasPass(device, context, encoder);
      pass.executeBundles([done]);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    const passes = context.content().webgpu!.passes as WebGpuPass[];
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.at(-1)!.commands.map((c) => c.c)).toEqual(['pipeline', 'draw']);
  });

  it('leaves the pass with no pipeline, bind groups or buffers set', async () => {
    const { device, context } = await setup();
    const pipeline = pipelineOf(device);
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    bundle.setPipeline(pipeline);
    bundle.draw(3);
    const { pass } = canvasPass(device, context);
    pass.setPipeline(pipeline);
    pass.executeBundles([bundle.finish()]);
    expect(() => pass.draw(3)).toThrow(/no pipeline is set/);
    pass.setPipeline(pipeline);
    pass.draw(3);
  });

  it('refuses a draw with state not set, in a pass and in a bundle', async () => {
    const { device, context } = await setup();
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    expect(() => bundle.draw(3)).toThrow(/no pipeline is set/);
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<uniform> u: vec4f; @vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0, 1) + u * 0.0; } @fragment fn fs() -> @location(0) vec4f { return vec4f(1); }`,
    });
    const group = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }] });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [group] }),
      vertex: { module, buffers: [{ arrayStride: 8, attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
      fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    });
    bundle.setPipeline(pipeline);
    expect(() => bundle.draw(3)).toThrow(/bind group 0 is not set/);
    const buffer = device.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.INDEX });
    bundle.setBindGroup(0, device.createBindGroup({ layout: group, entries: [{ binding: 0, resource: { buffer } }] }));
    expect(() => bundle.draw(3)).toThrow(/vertex buffer in slot 0 is not set/);
    bundle.setVertexBuffer(0, buffer);
    expect(() => bundle.drawIndexed(3)).toThrow(/no index buffer is set/);
    bundle.draw(3);
    void context;
  });

  it('refuses a bundle the pass cannot run: other colour format, depth format, sample count', async () => {
    const { device, context } = await setup();
    const depth = device.createTexture({ size: [4, 4], format: 'depth24plus', usage: 16 });
    const run = (descriptor: object, pass: ReturnType<typeof canvasPass>['pass']) => pass.executeBundles([device.createRenderBundleEncoder(descriptor as never).finish()]);
    expect(() => run({ colorFormats: ['bgra8unorm'] }, canvasPass(device, context).pass)).toThrow(/the bundle draws bgra8unorm and the pass draws rgba8unorm/);
    expect(() => run({ colorFormats: ['rgba8unorm'], depthStencilFormat: 'depth24plus' }, canvasPass(device, context).pass)).toThrow(/depth format/);
    expect(() => run({ colorFormats: ['rgba8unorm'], sampleCount: 4 }, canvasPass(device, context).pass)).toThrow(/4 samples/);
    const encoder = device.createCommandEncoder();
    const withDepth = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store', depthReadOnly: false },
    });
    expect(() => run({ colorFormats: ['rgba8unorm'], depthStencilFormat: 'depth24plus' }, withDepth)).not.toThrow();
  });

  it('refuses a pipeline the bundle was not made for, and a pass that is not a bundle', async () => {
    const { device, context } = await setup();
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    expect(() => bundle.setPipeline(pipelineOf(device, 'bgra8unorm'))).toThrow(/draws bgra8unorm and the bundle draws rgba8unorm/);
    expect(() => canvasPass(device, context).pass.executeBundles([{} as never])).toThrow(TypeError);
  });

  it('ends at finish, and stencil bundle formats are named as unsupported', async () => {
    const { device } = await setup();
    const bundle = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    bundle.finish();
    expect(() => bundle.finish()).toThrow(/finished/);
    expect(() => bundle.setPipeline(pipelineOf(device))).toThrow(/ended/);
    expect(() => device.createRenderBundleEncoder({ colorFormats: [], depthStencilFormat: 'depth24plus-stencil8' })).toThrow(WebGpuUnsupportedError);
  });
});
