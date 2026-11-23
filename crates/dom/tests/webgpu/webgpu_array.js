// size: 64 64
// A texture array of two 8 x 8 layers: a render pass draws into layer 0, writeTexture fills layer 1, and one canvas pass reads the array through a 2d-array view, layer 0 on the left half and layer 1 on the right.
const layers = device.createTexture({ size: [8, 8, 2], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
const module = device.createShaderModule({ code: `
  @vertex fn small(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.7, -0.7), vec2f(0.7, -0.5), vec2f(-0.2, 0.8));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn fill() -> @location(0) vec4f { return vec4f(0.9, 0.3, 0.1, 1); }
  @vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[i], 0, 1);
  }
  @group(0) @binding(0) var tex: texture_2d_array<f32>;
  @group(0) @binding(1) var smp: sampler;
  @fragment fn show(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let uv = p.xy / 64.0;
    return textureSample(tex, smp, uv, select(0, 1, uv.x > 0.5));
  }` });
const draw = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'small' }, fragment: { module, entryPoint: 'fill', targets: [{ format: 'rgba8unorm' }] } });
const show = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'full' }, fragment: { module, entryPoint: 'show', targets: [{ format }] } });
const checker = new Uint8Array(8 * 8 * 4);
for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) checker.set((x + y) % 2 ? [30, 160, 90, 255] : [240, 240, 200, 255], (y * 8 + x) * 4);
device.queue.writeTexture({ texture: layers, origin: [0, 0, 1] }, checker, { bytesPerRow: 32 }, [8, 8]);
const group = device.createBindGroup({ layout: show.getBindGroupLayout(0), entries: [
  { binding: 0, resource: layers.createView({ dimension: '2d-array' }) },
  { binding: 1, resource: device.createSampler() }] });
const encoder = device.createCommandEncoder();
let pass = encoder.beginRenderPass({ colorAttachments: [{ view: layers.createView({ dimension: '2d', baseArrayLayer: 0 }), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.2, b: 0.5, a: 1 } }] });
pass.setPipeline(draw);
pass.draw(3);
pass.end();
pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(show);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
