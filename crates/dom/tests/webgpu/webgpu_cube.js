// size: 66 44
// A cube texture of six 8 x 8 faces, each face drawn with its own colour by a render pass into that layer, read through a cube view: the canvas is a grid of the six axis directions (+x -x +y / -y +z -z), each cell the face the direction picks.
const faces = device.createTexture({ size: [8, 8, 6], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
const module = device.createShaderModule({ code: `
  @vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[i], 0, 1);
  }
  @group(0) @binding(0) var tex: texture_cube<f32>;
  @group(0) @binding(1) var smp: sampler;
  @fragment fn show(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let cell = u32(p.x / 22.0) + 3u * u32(p.y / 22.0);
    var dirs = array<vec3f, 6>(vec3f(1, 0, 0), vec3f(-1, 0, 0), vec3f(0, 1, 0), vec3f(0, -1, 0), vec3f(0, 0, 1), vec3f(0, 0, -1));
    return textureSample(tex, smp, dirs[cell]);
  }
  @vertex fn small(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0, 0.8));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn mark() -> @location(0) vec4f { return vec4f(1, 1, 1, 1); }` });
const mark = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'small' }, fragment: { module, entryPoint: 'mark', targets: [{ format: 'rgba8unorm' }] } });
const show = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'full' }, fragment: { module, entryPoint: 'show', targets: [{ format }] } });
const colors = [[0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9], [0.9, 0.9, 0.1], [0.1, 0.8, 0.8], [0.8, 0.2, 0.8]];
const encoder = device.createCommandEncoder();
colors.forEach(([r, g, b], layer) => {
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: faces.createView({ dimension: '2d', baseArrayLayer: layer }), loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a: 1 } }] });
  // Face 4 (+z) also gets a white triangle, so a face is not only a flat colour.
  if (layer === 4) { pass.setPipeline(mark); pass.draw(3); }
  pass.end();
});
const group = device.createBindGroup({ layout: show.getBindGroupLayout(0), entries: [
  { binding: 0, resource: faces.createView({ dimension: 'cube' }) },
  { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) }] });
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(show);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
