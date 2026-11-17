// size: 64 64
// One pass with two colour attachments (rgba8unorm and rgba16float), each with its own clear colour; a canvas pass shows the first on the left half and the second on the right.
const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const first = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage });
const second = device.createTexture({ size: [8, 8], format: 'rgba16float', usage });
const module = device.createShaderModule({ code: `
  struct Out { @location(0) c0: vec4f, @location(1) c1: vec4f }
  @vertex fn small(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.6), vec2f(0.0, 0.9));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn both(@builtin(position) p: vec4f) -> Out {
    let uv = p.xy / 8.0;
    return Out(vec4f(uv, 0.2, 1), vec4f(1.0 - uv.y, 0.5, uv.x, 1));
  }
  @vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[i], 0, 1);
  }
  @group(0) @binding(0) var left: texture_2d<f32>;
  @group(0) @binding(1) var right: texture_2d<f32>;
  @group(0) @binding(2) var smp: sampler;
  @fragment fn show(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let uv = vec2f(fract(p.x / 32.0), p.y / 64.0);
    return select(textureSample(left, smp, uv), textureSample(right, smp, uv), p.x > 32.0);
  }` });
const draw = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'small' }, fragment: { module, entryPoint: 'both', targets: [{ format: 'rgba8unorm' }, { format: 'rgba16float' }] } });
const show = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'full' }, fragment: { module, entryPoint: 'show', targets: [{ format }] } });
const group = device.createBindGroup({ layout: show.getBindGroupLayout(0), entries: [
  { binding: 0, resource: first.createView() }, { binding: 1, resource: second.createView() }, { binding: 2, resource: device.createSampler() }] });
const encoder = device.createCommandEncoder();
let pass = encoder.beginRenderPass({ colorAttachments: [
  { view: first.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
  { view: second.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.3, g: 0, b: 0.3, a: 1 } }] });
pass.setPipeline(draw);
pass.draw(3);
pass.end();
pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(show);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
