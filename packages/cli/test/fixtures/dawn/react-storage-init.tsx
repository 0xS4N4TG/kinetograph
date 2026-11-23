// A Remotion-style project that draws from a layout effect and keeps two storage buffers of particles it fills when it mounts
// (writeBuffer). Each frame a compute pass reads one and writes the other (a step of a spring) and the dots are drawn from the one it
// wrote: frame N is N steps. No buffer is read before it is written, so a frame drawn alone cannot see by the buffers alone that the
// frames before it are missing (WebGPU through Dawn: KINETOGRAPH_WEBGPU=dawn).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Composition, continueRender, delayRender, registerRoot, useCurrentFrame } from 'remotion';

const SIZE = 64;
const N = 128;

interface Gpu { device: any; context: any; compute: any; dotPipe: any; buf: any[]; binds: any[]; cur: number; drawn: number }

async function start(canvas: HTMLCanvasElement): Promise<Gpu> {
  const device = await (await (navigator as any).gpu.requestAdapter()).requestDevice();
  const context = canvas.getContext('webgpu') as any;
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
  const init = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { const a = i * 2.399963; const r = 0.1 + 0.7 * ((i * 7919) % N) / N; init.set([Math.cos(a) * r, Math.sin(a) * r, -Math.sin(a) * 0.02, Math.cos(a) * 0.02], i * 4); }
  const buf = [0, 1].map(() => device.createBuffer({ size: init.byteLength, usage: 0x80 | 0x20 | 0x08 }));
  for (const b of buf) device.queue.writeBuffer(b, 0, init);
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var<storage, read> src: array<vec4f>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      var v = src[id.x]; let g = -v.xy * 0.05; v.z += g.x; v.w += g.y; v.x += v.z; v.y += v.w; dst[id.x] = v; }` });
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: 4, buffer: { type: 'storage' } }] });
  const compute = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module, entryPoint: 'main' } });
  const binds = [0, 1].map((i) => device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: buf[i] } }, { binding: 1, resource: { buffer: buf[1 - i] } }] }));
  const dots = device.createShaderModule({ code: `
    @vertex fn vs(@location(0) pos: vec4f) -> @builtin(position) vec4f { return vec4f(pos.xy, 0, 1); }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(0.4, 0.8, 1.0, 1); }` });
  const dotPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: dots, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
    fragment: { module: dots, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'point-list' } });
  return { device, context, compute, dotPipe, buf, binds, cur: 0, drawn: -1 };
}

function draw(g: Gpu, frame: number): void {
  if (g.drawn === frame) return;
  g.drawn = frame;
  const encoder = g.device.createCommandEncoder();
  const cp = encoder.beginComputePass(); cp.setPipeline(g.compute); cp.setBindGroup(0, g.binds[g.cur]); cp.dispatchWorkgroups(N / 64); cp.end();
  const sp = encoder.beginRenderPass({ colorAttachments: [{ view: g.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  sp.setPipeline(g.dotPipe); sp.setVertexBuffer(0, g.buf[1 - g.cur]); sp.draw(N); sp.end();
  g.device.queue.submit([encoder.finish()]);
  g.cur = 1 - g.cur;
}

const Scene = () => {
  const frame = useCurrentFrame();
  const canvas = useRef<HTMLCanvasElement>(null);
  const gpu = useRef<Gpu | null>(null);
  const [handle] = useState(() => delayRender('webgpu device'));
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    void start(canvas.current!).then((g) => { gpu.current = g; setReady(true); continueRender(handle); });
  }, [handle]);
  useLayoutEffect(() => {
    if (ready && gpu.current !== null) draw(gpu.current, frame);
  }, [ready, frame]);
  return <canvas ref={canvas} width={SIZE} height={SIZE} style={{ display: 'block' }} />;
};

registerRoot(() => <Composition id="Main" component={Scene} width={SIZE} height={SIZE} fps={30} durationInFrames={12} />);
