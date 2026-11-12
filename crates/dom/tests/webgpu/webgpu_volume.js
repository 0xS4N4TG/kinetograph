// size: 64 32
// Two 3d textures of 8 x 8 x 4 texels. A: a render pass into each slice (depthSlice), slice 2 with a white triangle. B: a compute pass writes it through a 3d storage binding (red by x, green by y, blue by slice). The canvas shows A in its left half and B in its right half, four slices across, read with textureLoad.
const A = device.createTexture({ size: [8, 8, 4], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
const B = device.createTexture({ size: [8, 8, 4], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
const module = device.createShaderModule({ code: `
  @vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[i], 0, 1);
  }
  @vertex fn small(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-0.8, -0.8), vec2f(0.8, -0.8), vec2f(0, 0.8));
    return vec4f(p[i], 0, 1);
  }
  @fragment fn mark() -> @location(0) vec4f { return vec4f(1, 1, 1, 1); }
  @group(0) @binding(0) var volumeA: texture_3d<f32>;
  @group(0) @binding(1) var volumeB: texture_3d<f32>;
  @fragment fn show(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let x = u32(p.x);
    let y = u32(p.y) / 4u;
    let half = x % 32u;
    let at = vec3i(i32(half / 4u % 8u), i32(y), i32(half / 8u));
    if (x < 32u) { return textureLoad(volumeA, at, 0); }
    return textureLoad(volumeB, at, 0);
  }
  @group(0) @binding(0) var out: texture_storage_3d<rgba8unorm, write>;
  @compute @workgroup_size(8, 8, 1) fn fill(@builtin(global_invocation_id) id: vec3u) {
    textureStore(out, vec3i(id), vec4f(f32(id.x) / 8.0, f32(id.y) / 8.0, f32(id.z) / 3.0, 1.0));
  }` });
const mark = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'small' }, fragment: { module, entryPoint: 'mark', targets: [{ format: 'rgba8unorm' }] } });
const show = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'full' }, fragment: { module, entryPoint: 'show', targets: [{ format }] } });
const storageLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } }] });
const fill = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [storageLayout] }), compute: { module, entryPoint: 'fill' } });
const colors = [[0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9], [0.9, 0.9, 0.1]];
const encoder = device.createCommandEncoder();
colors.forEach(([r, g, b], slice) => {
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: A.createView(), depthSlice: slice, loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a: 1 } }] });
  if (slice === 2) { pass.setPipeline(mark); pass.draw(3); }
  pass.end();
});
const compute = encoder.beginComputePass();
compute.setPipeline(fill);
compute.setBindGroup(0, device.createBindGroup({ layout: storageLayout, entries: [{ binding: 0, resource: B.createView() }] }));
compute.dispatchWorkgroups(1, 1, 4);
compute.end();
const group = device.createBindGroup({ layout: show.getBindGroupLayout(0), entries: [
  { binding: 0, resource: A.createView() },
  { binding: 1, resource: B.createView() }] });
const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
pass.setPipeline(show);
pass.setBindGroup(0, group);
pass.draw(3);
pass.end();
device.queue.submit([encoder.finish()]);
