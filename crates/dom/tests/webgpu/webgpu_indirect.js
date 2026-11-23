// size: 64 32
// Indirect draws. Left half: a draw whose arguments a compute pass wrote (three instances of a triangle, each its own colour), then one whose arguments name a first instance (not drawn without the indirect-first-instance feature). Right half: an indexed draw whose arguments the queue wrote, with a base vertex that picks the second triangle of the vertex buffer.
const module = device.createShaderModule({ code: `
  struct Out { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) n: u32 }
  @vertex fn vs(@location(0) p: vec2f, @builtin(instance_index) n: u32) -> Out {
    return Out(vec4f(p + vec2f((f32(n) - 1.0) * 0.6, 0), 0, 1), n);
  }
  @fragment fn fs(o: Out) -> @location(0) vec4f {
    var c = array<vec3f, 4>(vec3f(0.9, 0.2, 0.2), vec3f(0.2, 0.8, 0.3), vec3f(0.2, 0.3, 0.9), vec3f(1, 1, 1));
    return vec4f(c[min(o.n, 3u)], 1);
  }
  @group(0) @binding(0) var<storage, read_write> args: array<u32>;
  @compute @workgroup_size(1) fn write() { args[0] = 3u; args[1] = 3u; args[2] = 0u; args[3] = 0u; }` });
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
  fragment: { module, entryPoint: 'fs', targets: [{ format }] },
});
const writer = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'write' } });
const vertices = device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(vertices, 0, new Float32Array([-0.2, -0.5, 0.2, -0.5, 0, 0.5, -0.5, -0.8, 0.5, -0.8, 0, 0.8]));
const indices = device.createBuffer({ size: 8, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0]));
const gpuArgs = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
const indexedArgs = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(indexedArgs, 0, new Uint32Array([3, 1, 0, 3, 0]));
const skipArgs = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(skipArgs, 0, new Uint32Array([3, 1, 0, 3]));
const encoder = device.createCommandEncoder();
const compute = encoder.beginComputePass();
compute.setPipeline(writer);
compute.setBindGroup(0, device.createBindGroup({ layout: writer.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: gpuArgs } }] }));
compute.dispatchWorkgroups(1);
compute.end();
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1 } }] });
pass.setPipeline(pipeline);
pass.setVertexBuffer(0, vertices);
pass.setViewport(0, 0, 32, 32, 0, 1);
pass.drawIndirect(gpuArgs, 0);
pass.drawIndirect(skipArgs, 0);
pass.setViewport(32, 0, 32, 32, 0, 1);
pass.setIndexBuffer(indices, 'uint16');
pass.drawIndexedIndirect(indexedArgs, 0);
pass.end();
device.queue.submit([encoder.finish()]);
