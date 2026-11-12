import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_TEXTURE_USAGE,
  type GPUDeviceShim,
  type GPUCanvasContextShim,
  type WebGpuPass,
} from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING, COPY_SRC, COPY_DST } = GPU_TEXTURE_USAGE;

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

const depthTexture = (device: GPUDeviceShim, format = 'depth32float', usage = RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC | COPY_DST) =>
  device.createTexture({ size: [8, 8], format, usage } as never);

/** A pipeline that writes depth and draws no colour: `fragment` left out, or its targets empty. */
function depthPipeline(device: GPUDeviceShim, fragment?: object) {
  const module = device.createShaderModule({ code: WGSL });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    ...(fragment ? { fragment: { module, entryPoint: 'fs', ...fragment } } : {}),
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  } as never);
}

const depthOnlyPass = (device: GPUDeviceShim, texture = depthTexture(device)) => {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: { view: texture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  } as never);
  return { encoder, pass, texture };
};

describe('depth-only render passes', () => {
  it('records a pass with no colour attachment as depthOnly, kept when a later pass reads what it wrote', async () => {
    const { device, context } = await setup();
    const { encoder, pass, texture } = depthOnlyPass(device);
    pass.setPipeline(depthPipeline(device));
    pass.draw(3);
    pass.end();
    // A canvas pass that samples the depth texture, so the depth-only pass is something the frame depends on.
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var map: texture_depth_2d;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
        @fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(map, vec2i(q.xy), 0), 0, 0, 1); }`,
    });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const canvasPass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    canvasPass.setPipeline(pipeline);
    canvasPass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    canvasPass.draw(3);
    canvasPass.end();
    device.queue.submit([encoder.finish()]);
    const webgpu = context.content().webgpu!;
    expect(webgpu.notes).toBeUndefined();
    const [first, second] = webgpu.passes as WebGpuPass[];
    expect(first).toMatchObject({ k: 'render', depthOnly: true, clear: null, depth: { clear: 1 } });
    expect(first!.target).toBeUndefined();
    expect(second!.depthOnly).toBeUndefined();
  });

  it('refuses a depth-only pass that has no depth attachment, or a pipeline that draws colour into it', async () => {
    const { device } = await setup();
    expect(() => device.createCommandEncoder().beginRenderPass({ colorAttachments: [] } as never)).toThrow(/attachment/);
    const { pass } = depthOnlyPass(device);
    expect(() => pass.setPipeline(depthPipeline(device, { targets: [{ format: 'rgba8unorm' }] }))).toThrow(/colour/);
    expect(() => pass.setPipeline(depthPipeline(device, { targets: [] }))).not.toThrow();
    expect(() => pass.setPipeline(depthPipeline(device))).not.toThrow();
  });

  it('keeps the pass inside the depth texture it writes: the scissor is checked against it', async () => {
    const { device } = await setup();
    const { pass } = depthOnlyPass(device);
    expect(() => pass.setScissorRect(0, 0, 8, 8)).not.toThrow();
    expect(() => pass.setScissorRect(4, 4, 8, 8)).toThrow(/outside/);
  });
});

describe('copies of depth textures', () => {
  it('records the copy of a whole depth level and keeps the pass that wrote the source', async () => {
    const { device, context } = await setup();
    const from = depthTexture(device);
    const to = depthTexture(device);
    const { encoder, pass } = depthOnlyPass(device, from);
    pass.setPipeline(depthPipeline(device));
    pass.draw(3);
    pass.end();
    encoder.copyTextureToTexture({ texture: from }, { texture: to }, [8, 8]);
    device.queue.submit([encoder.finish()]);
    // Nothing reads `to` yet: sample it, as a shadow pass would.
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var map: texture_depth_2d;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
        @fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(map, vec2i(q.xy), 0), 0, 0, 1); }`,
    });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const read = device.createCommandEncoder();
    const canvasPass = read.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    canvasPass.setPipeline(pipeline);
    canvasPass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: to.createView() }] }));
    canvasPass.draw(3);
    canvasPass.end();
    device.queue.submit([read.finish()]);
    const steps = context.content().webgpu!.passes;
    expect(steps.map((s) => s.k)).toEqual(['render', 'copy', 'render']);
    expect(context.content().webgpu!.notes).toBeUndefined();
  });

  it('refuses a partial copy of a depth texture, a copy between formats, and an upload into one', async () => {
    const { device } = await setup();
    const from = depthTexture(device);
    const encoder = device.createCommandEncoder();
    expect(() => encoder.copyTextureToTexture({ texture: from }, { texture: depthTexture(device) }, [4, 4])).toThrow(/whole/);
    expect(() => encoder.copyTextureToTexture({ texture: from }, { texture: depthTexture(device, 'depth16unorm') }, [8, 8])).toThrow(/format/);
    expect(() => encoder.copyTextureToTexture({ texture: from, origin: [1, 0] }, { texture: depthTexture(device) }, [7, 8])).toThrow(/whole/);
    expect(() => device.queue.writeTexture({ texture: from }, new Float32Array(64), { bytesPerRow: 32 }, [8, 8])).toThrow(/unsupported/);
  });
});
