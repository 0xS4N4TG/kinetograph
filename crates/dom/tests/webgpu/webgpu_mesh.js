// size: 96 96
// A textured cube, depth tested, indexed, with a uniform buffer and a bind group; the angle is the frame number.
const frame = 4;
const module = device.createShaderModule({ code: `
  struct U { mvp: mat4x4f, tint: vec4f }
  @group(0) @binding(0) var<uniform> u: U;
  @group(0) @binding(1) var tex: texture_2d<f32>;
  @group(0) @binding(2) var smp: sampler;
  struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) shade: f32 }
  @vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) n: vec3f) -> V {
    var v: V; v.p = u.mvp * vec4f(pos, 1); v.uv = uv; v.shade = 0.55 + 0.45 * max(dot(n, normalize(vec3f(0.3, 0.8, 0.6))), 0.0); return v;
  }
  @fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(textureSample(tex, smp, v.uv).rgb * v.shade * u.tint.rgb, 1); }` });
// 6 faces: normal, u axis, v axis.
const faces = [[1, 0, 0, 0, 0, -1, 0, 1, 0], [-1, 0, 0, 0, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 0, 0, 0, -1], [0, -1, 0, 1, 0, 0, 0, 0, 1], [0, 0, 1, 1, 0, 0, 0, 1, 0], [0, 0, -1, -1, 0, 0, 0, 1, 0]];
const verts = [];
const indices = [];
faces.forEach((f, i) => {
  const n = f.slice(0, 3), a = f.slice(3, 6), b = f.slice(6, 9);
  for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    verts.push(n[0] + a[0] * s + b[0] * t, n[1] + a[1] * s + b[1] * t, n[2] + a[2] * s + b[2] * t, (s + 1) / 2, (1 - t) / 2, ...n);
  }
  indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
});
const vertexData = new Float32Array(verts);
const indexData = new Uint16Array(indices);
const vertexBuffer = device.createBuffer({ size: vertexData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(vertexBuffer, 0, vertexData);
const indexBuffer = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(indexBuffer, 0, indexData);
// An 8 x 8 checker.
const pixels = new Uint8Array(8 * 8 * 4);
for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
  const on = (x + y) % 2 === 0;
  pixels.set(on ? [240, 200, 60, 255] : [40, 90, 200, 255], (y * 8 + x) * 4);
}
const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
device.queue.writeTexture({ texture }, pixels, { bytesPerRow: 32 }, [8, 8]);
const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
// mvp = perspective (z 0..1) * translate * rotate y * rotate x.
const f = 1 / Math.tan(0.5), near = 0.5, far = 10;
const proj = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0];
const mul = (p, q) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) o[c * 4 + r] += p[k * 4 + r] * q[c * 4 + k]; return o; };
const ay = frame * 0.2, ax = 0.5;
const ry = [Math.cos(ay), 0, -Math.sin(ay), 0, 0, 1, 0, 0, Math.sin(ay), 0, Math.cos(ay), 0, 0, 0, 0, 1];
const rx = [1, 0, 0, 0, 0, Math.cos(ax), Math.sin(ax), 0, 0, -Math.sin(ax), Math.cos(ax), 0, 0, 0, 0, 1];
const move = [0.55, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0.55, 0, 0, 0, -3, 1];
const uniforms = new Float32Array([...mul(proj, mul(move, mul(ry, rx))), 1, 1, 1, 1]);
const uniformBuffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(uniformBuffer, 0, uniforms);
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }, { shaderLocation: 2, offset: 20, format: 'float32x3' }] }] },
  fragment: { module, entryPoint: 'fs', targets: [{ format }] },
  primitive: { cullMode: 'none' },
  depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
});
const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
  { binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: sampler }] });
const depth = device.createTexture({ size: [W, H], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }],
  depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
});
pass.setPipeline(pipeline);
pass.setBindGroup(0, group);
pass.setVertexBuffer(0, vertexBuffer);
pass.setIndexBuffer(indexBuffer, 'uint16');
pass.drawIndexed(36);
pass.end();
device.queue.submit([encoder.finish()]);
