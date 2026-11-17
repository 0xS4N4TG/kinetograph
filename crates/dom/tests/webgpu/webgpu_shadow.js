// size: 64 64
// A depth-only pass (no colour attachment) draws an occluder into a depth texture, the depth texture is copied whole into another, and a canvas pass compares it with a reference depth, as a shadow map is read.
const map = device.createTexture({ size: [64, 64], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const copy = device.createTexture({ size: [64, 64], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
const module = device.createShaderModule({ code: `
  @vertex fn occluder(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.6, -0.6), vec2f(0.7, -0.4), vec2f(-0.1, 0.8));
    return vec4f(p[i], 0.3, 1);
  }
  @vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[i], 0, 1);
  }
  @group(0) @binding(0) var shadowMap: texture_depth_2d;
  @group(0) @binding(1) var compareSampler: sampler_comparison;
  @fragment fn lit(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let visible = textureSampleCompare(shadowMap, compareSampler, pos.xy / 64.0, 0.5);
    return vec4f(mix(vec3f(0.05, 0.1, 0.3), vec3f(0.9, 0.6, 0.2), visible), 1);
  }` });
const depthPipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'occluder' },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
});
const litPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'full' }, fragment: { module, entryPoint: 'lit', targets: [{ format }] } });
const group = device.createBindGroup({ layout: litPipeline.getBindGroupLayout(0), entries: [
  { binding: 0, resource: copy.createView() },
  { binding: 1, resource: device.createSampler({ compare: 'less' }) }] });
const encoder = device.createCommandEncoder();
let pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: map.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
pass.setPipeline(depthPipeline);
pass.draw(3);
pass.end();
encoder.copyTextureToTexture({ texture: map }, { texture: copy }, [64, 64]);
pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(litPipeline);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
