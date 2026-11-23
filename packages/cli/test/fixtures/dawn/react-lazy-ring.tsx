// A Remotion-style project that draws from a layout effect and keeps a ring of three textures made when it mounts and never written
// there: frame k fades texture (k-1) % 3 into texture k % 3 and adds a dot where `useCurrentFrame` says, so frame N is N steps of it.
// A frame drawn alone shows nothing of that until a third frame has run: the first writes a texture nothing wrote, the second the
// next one, and only the third writes a texture that holds something and reads one an earlier frame wrote (a jump lands on frame
// N, which reads texture (N-1) % 3 as the mount's frame 0 left it, and the frames after it show it).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Composition, continueRender, delayRender, registerRoot, useCurrentFrame } from 'remotion';

const SIZE = 64;
const SHADERS = `
  struct U { step: f32, pad: vec3f }
  @group(0) @binding(0) var src: texture_2d<f32>; @group(0) @binding(1) var smp: sampler; @group(0) @binding(2) var<uniform> u: U;
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); }
  @fragment fn fade(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let uv = pos.xy / ${SIZE}.0; let prev = textureSample(src, smp, uv);
    let c = vec2f(0.5 + 0.3 * cos(u.step * 0.4), 0.5 + 0.3 * sin(u.step * 0.4));
    return vec4f(prev.rgb * 0.97 + vec3f(1.0, 0.5, 0.2) * smoothstep(0.12, 0.0, distance(uv, c)), 1.0); }
  @fragment fn show(@builtin(position) pos: vec4f) -> @location(0) vec4f { return vec4f(textureSample(src, smp, pos.xy / ${SIZE}.0).rgb, 1.0); }`;

interface Gpu { device: any; context: any; fade: any; show: any; tex: any[]; binds: any[]; blank: any; step: any; drawn: number }

async function start(canvas: HTMLCanvasElement): Promise<Gpu> {
  const device = await (await (navigator as any).gpu.requestAdapter()).requestDevice();
  const context = canvas.getContext('webgpu') as any;
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
  const module = device.createShaderModule({ code: SHADERS });
  const entries = [0, 1, 2].map((binding) => ({ binding, visibility: 2, ...[{ texture: {} }, { sampler: {} }, { buffer: {} }][binding] }));
  const bindLayout = device.createBindGroupLayout({ entries });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const pipeline = (entryPoint: string) => device.createRenderPipeline({ layout, vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint, targets: [{ format: 'rgba8unorm' }] } });
  const tex = [0, 1, 2].map(() => device.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: 0x10 | 0x04 }));
  const blankTexture = device.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: 0x04 | 0x02 });
  device.queue.writeTexture({ texture: blankTexture }, new Uint8Array(SIZE * SIZE * 4).fill(40), { bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  const step = device.createBuffer({ size: 32, usage: 0x40 | 0x08 });
  const bind = (t: any) => device.createBindGroup({ layout: bindLayout, entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: sampler }, { binding: 2, resource: { buffer: step } }] });
  return { device, context, fade: pipeline('fade'), show: pipeline('show'), tex, binds: tex.map(bind), blank: bind(blankTexture), step, drawn: -1 };
}

function draw(g: Gpu, frame: number): void {
  if (g.drawn === frame) return;
  g.drawn = frame;
  g.device.queue.writeBuffer(g.step, 0, new Float32Array([frame, 0, 0, 0]));
  const encoder = g.device.createCommandEncoder();
  const fade = encoder.beginRenderPass({ colorAttachments: [{ view: g.tex[frame % 3].createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  fade.setPipeline(g.fade); fade.setBindGroup(0, frame === 0 ? g.blank : g.binds[(frame + 2) % 3]); fade.draw(3); fade.end();
  const show = encoder.beginRenderPass({ colorAttachments: [{ view: g.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  show.setPipeline(g.show); show.setBindGroup(0, g.binds[frame % 3]); show.draw(3); show.end();
  g.device.queue.submit([encoder.finish()]);
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
  // The draw is made by an effect, once for each frame the composition is rendered at.
  useLayoutEffect(() => {
    if (ready && gpu.current !== null) draw(gpu.current, frame);
  }, [ready, frame]);
  return <canvas ref={canvas} width={SIZE} height={SIZE} style={{ display: 'block' }} />;
};

registerRoot(() => <Composition id="Main" component={Scene} width={SIZE} height={SIZE} fps={30} durationInFrames={12} />);
