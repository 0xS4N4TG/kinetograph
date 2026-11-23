// size: 64 64
// A pass into an offscreen texture, then a second pass that samples it (linear, magnified) onto the canvas.
const offscreen = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
const module = device.createShaderModule({ code: `
  struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
  @vertex fn first(@builtin(vertex_index) i: u32) -> V {
    var p = array<vec2f, 3>(vec2f(-0.75, -0.75), vec2f(0.75, -0.75), vec2f(0, 0.8));
    var v: V; v.p = vec4f(p[i], 0, 1); v.uv = vec2f(0); return v;
  }
  @fragment fn firstFs() -> @location(0) vec4f { return vec4f(1, 0.4, 0.1, 1); }
  @vertex fn second(@builtin(vertex_index) i: u32) -> V {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    var v: V; v.p = vec4f(p[i], 0, 1); v.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5); return v;
  }
  @group(0) @binding(0) var tex: texture_2d<f32>;
  @group(0) @binding(1) var smp: sampler;
  @fragment fn secondFs(v: V) -> @location(0) vec4f { return textureSample(tex, smp, v.uv); }` });
const one = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'first' }, fragment: { module, entryPoint: 'firstFs', targets: [{ format: 'rgba8unorm' }] } });
const two = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'second' }, fragment: { module, entryPoint: 'secondFs', targets: [{ format }] } });
const group = device.createBindGroup({ layout: two.getBindGroupLayout(0), entries: [
  { binding: 0, resource: offscreen.createView() }, { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
const encoder = device.createCommandEncoder();
let pass = encoder.beginRenderPass({ colorAttachments: [{ view: offscreen.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.05, g: 0.2, b: 0.4, a: 1 } }] });
pass.setPipeline(one);
pass.draw(3);
pass.end();
pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(two);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
