// size: 64 64
// One render bundle (a pipeline, a bind group with a colour, a vertex buffer, a draw) runs twice in one pass, in the left and the right half (the viewport is not reset by executeBundles); after it the pass sets its own pipeline and draws a small triangle.
const module = device.createShaderModule({ code: `
  struct Tint { color: vec4f }
  @group(0) @binding(0) var<uniform> tint: Tint;
  @vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0, 1); }
  @fragment fn fs() -> @location(0) vec4f { return tint.color; }
  @vertex fn corner(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(-0.4, -1), vec2f(-1, -0.4));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn white() -> @location(0) vec4f { return vec4f(1, 1, 1, 1); }` });
const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
const shape = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
  fragment: { module, entryPoint: 'fs', targets: [{ format }] },
});
const corner = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'corner' }, fragment: { module, entryPoint: 'white', targets: [{ format }] } });
const vertices = device.createBuffer({ size: 24, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(vertices, 0, new Float32Array([-0.8, -0.8, 0.8, -0.6, -0.1, 0.8]));
const tint = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(tint, 0, new Float32Array([0.9, 0.4, 0.1, 1]));
const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: tint } }] });
const bundleEncoder = device.createRenderBundleEncoder({ colorFormats: [format] });
bundleEncoder.setPipeline(shape);
bundleEncoder.setBindGroup(0, group);
bundleEncoder.setVertexBuffer(0, vertices);
bundleEncoder.draw(3);
const bundle = bundleEncoder.finish();
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.2, b: 0.5, a: 1 } }] });
pass.setViewport(0, 0, 32, 64, 0, 1);
pass.executeBundles([bundle]);
pass.setViewport(32, 0, 32, 64, 0, 1);
pass.executeBundles([bundle]);
pass.setViewport(0, 0, 64, 64, 0, 1);
pass.setPipeline(corner);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
