// size: 64 64
// A pass with an occlusion query set and a query around a draw, resolved into a buffer: the picture is the triangle, as it would be without them.
const module = device.createShaderModule({ code: `
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0, 0.8));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn fs() -> @location(0) vec4f { return vec4f(0.9, 0.5, 0.1, 1); }` });
const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
const queries = device.createQuerySet({ type: 'occlusion', count: 2 });
const results = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }], occlusionQuerySet: queries });
pass.setPipeline(pipeline);
pass.beginOcclusionQuery(0);
pass.draw(3);
pass.endOcclusionQuery();
pass.end();
encoder.resolveQuerySet(queries, 0, 2, results, 0);
device.queue.submit([encoder.finish()]);
