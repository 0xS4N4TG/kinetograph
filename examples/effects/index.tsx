// Canvas effects and HTML in canvas, run on recording canvases: `<Solid>` and `<CanvasImage>` with 2D and WebGL 2
// effects, a chain of both kinds, and `<HtmlInCanvas>` with an `onPaint` that draws the HTML and an overlay.
// `kinetograph still examples/effects/index.tsx --comp fx-solid --frame 0 -o solid.png`

import React from 'react';
import { AbsoluteFill, CanvasImage, Composition, HtmlInCanvas, Solid, createEffect, registerRoot, staticFile } from 'remotion';

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

// A 2D effect: the picture through a CSS filter.
const filter = createEffect<{ filter: string }, object>({
  type: 'example/filter',
  label: 'Filter',
  documentationLink: null,
  backend: '2d',
  calculateKey: (p) => `filter-${p.filter}`,
  setup: () => ({}),
  apply: ({ source, target, params, width, height }) => {
    const ctx = target.getContext('2d')!;
    ctx.filter = params.filter;
    ctx.drawImage(source, 0, 0, width, height);
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: (p) => {
    if (typeof p.filter !== 'string') throw new Error('filter is required');
  },
});

// A 2D effect: the picture, then a colour over what it covers.
const tint = createEffect<{ color: string }, object>({
  type: 'example/tint',
  label: 'Tint',
  documentationLink: null,
  backend: '2d',
  calculateKey: (p) => `tint-${p.color}`,
  setup: () => ({}),
  apply: ({ source, target, params, width, height }) => {
    const ctx = target.getContext('2d')!;
    ctx.drawImage(source, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = params.color;
    ctx.fillRect(0, 0, width, height);
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: (p) => {
    if (typeof p.color !== 'string') throw new Error('color is required');
  },
});

// A WebGL 2 effect: a vertical wave and a colour shift, with the picture uploaded as Remotion's effects do it.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform float amount;
in vec2 uv;
out vec4 color;
void main() {
  vec2 p = vec2(uv.x + sin(uv.y * 18.0) * 0.02 * amount, uv.y);
  vec4 c = texture(tex, p);
  color = vec4(c.bgr, c.a);
}`;

interface WaveState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
}

const wave = createEffect<{ amount: number }, WaveState>({
  type: 'example/wave',
  label: 'Wave',
  documentationLink: null,
  backend: 'webgl2',
  calculateKey: (p) => `wave-${p.amount}`,
  setup: (target) => {
    const gl = target.getContext('webgl2', { premultipliedAlpha: true, alpha: true })!;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    return { gl, program, texture: gl.createTexture()! };
  },
  apply: ({ source, state, params, width, height, flipSourceY }) => {
    const { gl, program, texture } = state;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipSourceY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'amount'), params.amount);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: (p) => {
    if (typeof p.amount !== 'number') throw new Error('amount is required');
  },
});

// A WebGPU effect: the picture is copied into a texture and a pipeline of its own samples it with a vertical wave. The
// device and the canvas are recording ones, so the pass is replayed on the engine's device with this WGSL.
const WAVE_WGSL = `
struct Params { amount: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  var uv = at.xy / vec2f(textureDimensions(src));
  uv.x += sin(uv.y * 12.0) * 0.03 * params.amount;
  return textureSample(src, smp, uv);
}`;

const waveGpu = createEffect<{ amount: number }, object>({
  type: 'example/wave-gpu',
  label: 'WaveGpu',
  documentationLink: null,
  backend: 'webgpu',
  calculateKey: (p) => `wave-gpu-${p.amount}`,
  setup: () => ({}),
  apply: ({ source, target, params, gpuDevice, width, height }) => {
    const device = gpuDevice as GPUDevice;
    const context = target.getContext('webgpu') as GPUCanvasContext;
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
    const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    device.queue.copyExternalImageToTexture({ source: source as unknown as ImageBitmap }, { texture }, [width, height]);
    const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniforms, 0, new Float32Array([params.amount, 0, 0, 0]));
    const module = device.createShaderModule({ code: WAVE_WGSL });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: { buffer: uniforms } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: (p) => {
    if (typeof p.amount !== 'number') throw new Error('amount is required');
  },
});

const W = 320;
const H = 180;
const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => <AbsoluteFill style={{ background: '#20242c' }}>{children}</AbsoluteFill>;

const SolidDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 20, top: 20 }}>
      <Solid width={120} height={140} color="#2ec4b6" effects={[filter({ filter: 'invert(1)' })]} />
    </div>
    <div style={{ position: 'absolute', left: 180, top: 20 }}>
      <Solid width={120} height={140} color="#2ec4b6" />
    </div>
  </Backdrop>
);

const ImageDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 10, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={192} height={144} effects={[wave({ amount: 1 })]} />
    </div>
    <div style={{ position: 'absolute', left: 220, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={64} height={64} />
    </div>
  </Backdrop>
);

const ChainDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 10, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={192} height={144} effects={[wave({ amount: 1 }), tint({ color: '#ff3366' }), filter({ filter: 'invert(1)' })]} />
    </div>
  </Backdrop>
);

const GpuDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 10, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={192} height={144} effects={[waveGpu({ amount: 1 })]} />
    </div>
    <div style={{ position: 'absolute', left: 220, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={64} height={64} />
    </div>
  </Backdrop>
);

const HtmlDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 10, top: 10 }}>
      <HtmlInCanvas
        width={300}
        height={150}
        onPaint={({ canvas, elementImage }) => {
          const ctx = canvas.getContext('2d')!;
          ctx.reset();
          ctx.drawElementImage(elementImage, 0, 0);
          ctx.fillStyle = 'rgba(255, 220, 0, 0.5)';
          ctx.fillRect(150, 75, 140, 65);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 3;
          ctx.strokeRect(150, 75, 140, 65);
        }}
      >
        <div style={{ position: 'relative', width: 300, height: 150, background: 'linear-gradient(135deg, #7b2ff7, #f107a3)' }}>
          <div style={{ position: 'absolute', left: 16, top: 16, width: 90, height: 50, borderRadius: 12, background: '#fff', opacity: 0.9 }} />
          <div style={{ position: 'absolute', left: 30, top: 90, width: 60, height: 40, borderRadius: 20, background: '#101820' }} />
        </div>
      </HtmlInCanvas>
    </div>
  </Backdrop>
);

// The canvases of the chain at another size than the box: the picture is made 64 x 32 pixels and shown stretched.
const SizeDemo: React.FC = () => (
  <Backdrop>
    <div style={{ position: 'absolute', left: 10, top: 10 }}>
      <CanvasImage src={staticFile('checker.png')} width={128} height={128} effects={[wave({ amount: 1 })]} effectsOutputSize={{ width: 64, height: 32 }} />
    </div>
    <div style={{ position: 'absolute', left: 160, top: 10 }}>
      <Solid width={100} height={100} color="#ffd166" pixelDensity={2} effects={[filter({ filter: 'blur(3px)' })]} style={{ borderRadius: 24 }} />
    </div>
  </Backdrop>
);

registerRoot(() => (
  <>
    <Composition id="fx-solid" component={SolidDemo} width={W} height={H} fps={30} durationInFrames={30} />
    <Composition id="fx-image" component={ImageDemo} width={W} height={H} fps={30} durationInFrames={30} />
    <Composition id="fx-chain" component={ChainDemo} width={W} height={H} fps={30} durationInFrames={30} />
    <Composition id="fx-size" component={SizeDemo} width={W} height={H} fps={30} durationInFrames={30} />
    <Composition id="fx-webgpu" component={GpuDemo} width={W} height={H} fps={30} durationInFrames={30} />
    <Composition id="fx-html" component={HtmlDemo} width={W} height={H} fps={30} durationInFrames={30} />
  </>
));
