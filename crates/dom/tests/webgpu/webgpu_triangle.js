// size: 64 64
const module = device.createShaderModule({ code: `
  struct V { @builtin(position) p: vec4f, @location(0) c: vec3f }
  @vertex fn vs(@location(0) pos: vec2f, @location(1) c: vec3f) -> V { var v: V; v.p = vec4f(pos, 0, 1); v.c = c; return v; }
  @fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(v.c, 1); }` });
const vertices = new Float32Array([-0.8, -0.8, 1, 0, 0, 0.8, -0.8, 0, 1, 0, 0, 0.8, 0, 0, 1]);
const buffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(buffer, 0, vertices);
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x3' }] }] },
  fragment: { module, entryPoint: 'fs', targets: [{ format }] },
});
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }] });
pass.setPipeline(pipeline);
pass.setVertexBuffer(0, buffer);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
