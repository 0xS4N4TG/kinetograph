// Effects for the tests and the golden scenes: the shapes of Remotion's own effects (a definition with a backend, a
// setup, an apply that draws `source` onto `target`), small enough to read.

import { createEffect } from '../src/index.js';
import { bindQuad, useProgram, type ShaderGL } from '../src/gl-recording.js';

/** The parts of a 2D context the fixtures use. */
interface Draw {
  filter: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** 2D: the source with a CSS filter. */
export const filtered = createEffect<{ filter: string }, object>({
  type: 'test/filtered',
  label: 'Filtered',
  documentationLink: null,
  backend: '2d',
  calculateKey: ({ filter }) => `filtered-${filter}`,
  setup: () => ({}),
  apply: ({ source, target, params, width, height }) => {
    const ctx = target.getContext('2d') as unknown as Draw;
    ctx.filter = params.filter;
    ctx.drawImage(source as never, 0, 0, width, height);
  },
  cleanup: () => undefined,
  schema: { filter: { type: 'string', default: 'invert(1)', description: 'Filter' } },
  validateParams: ({ filter }) => {
    if (typeof filter !== 'string' || filter === '') throw new Error('filtered: `filter` is required and must be a CSS filter');
  },
});

/** 2D: the source, then a colour over what it covers. */
export const tinted = createEffect<{ color: string; amount?: number }, object>({
  type: 'test/tinted',
  label: 'Tinted',
  documentationLink: null,
  backend: '2d',
  calculateKey: ({ color, amount }) => `tinted-${color}-${amount ?? 1}`,
  setup: () => ({}),
  apply: ({ source, target, params, width, height }) => {
    const ctx = target.getContext('2d') as unknown as Draw;
    ctx.drawImage(source as never, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = params.amount ?? 1;
    ctx.fillStyle = params.color;
    ctx.fillRect(0, 0, width, height);
  },
  cleanup: () => undefined,
  schema: { color: { type: 'color', default: '#ff0000', description: 'Colour' }, amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, description: 'Amount' } },
  validateParams: ({ color, amount }) => {
    if (typeof color !== 'string') throw new Error('tinted: `color` is required');
    if (amount !== undefined && !(typeof amount === 'number' && amount >= 0 && amount <= 1)) throw new Error('tinted: `amount` must be a number from 0 to 1');
  },
});

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec3 mult;
uniform float mode;
in vec2 uv;
out vec4 color;
void main() {
  vec4 c = texture(tex, uv);
  // The picture arrives premultiplied (UNPACK_PREMULTIPLY_ALPHA_WEBGL), as an effect of Remotion's pool gets it.
  vec3 rgb = mode > 0.5 ? c.aaa - c.rgb : c.rgb * mult;
  color = vec4(rgb, c.a);
}`;

interface ShaderState {
  gl: ShaderGL;
  program: ReturnType<ShaderGL['createProgram']>;
  texture: ReturnType<ShaderGL['createTexture']>;
}

/** WebGL 2: the source through a fragment shader that multiplies it by a colour, or inverts it. */
export const shaded = createEffect<{ mult?: [number, number, number]; invert?: boolean }, ShaderState>({
  type: 'test/shaded',
  label: 'Shaded',
  documentationLink: null,
  backend: 'webgl2',
  calculateKey: ({ mult, invert }) => `shaded-${(mult ?? [1, 1, 1]).join(',')}-${invert ?? false}`,
  setup: (target) => {
    const gl = target.getContext('webgl2') as ShaderGL;
    const program = useProgram(gl, VERTEX, FRAGMENT);
    bindQuad(gl, program, 'position');
    return { gl, program, texture: gl.createTexture() };
  },
  apply: ({ source, state, params, width, height, flipSourceY }) => {
    const { gl, program, texture } = state;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipSourceY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as never);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    const [r, g, b] = params.mult ?? [1, 1, 1];
    gl.uniform3f(gl.getUniformLocation(program, 'mult'), r, g, b);
    gl.uniform1f(gl.getUniformLocation(program, 'mode'), params.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  },
  cleanup: () => undefined,
  schema: { invert: { type: 'boolean', default: false, description: 'Invert' } },
  validateParams: ({ mult }) => {
    if (mult !== undefined && !(Array.isArray(mult) && mult.length === 3 && mult.every((v) => typeof v === 'number'))) throw new Error('shaded: `mult` must be three numbers');
  },
});

const GPU_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let c = textureSample(src, smp, at.xy / vec2f(textureDimensions(src)));
  return vec4f(c.bgr, c.a);
}`;

/** WebGPU: the layer before it is copied into a texture and sampled by a pipeline that swaps red and blue. */
export const gpu = createEffect<object, object>({
  type: 'test/gpu',
  label: 'Gpu',
  documentationLink: null,
  backend: 'webgpu',
  calculateKey: () => 'gpu',
  setup: () => ({}),
  apply: ({ source, target, gpuDevice, width, height }) => {
    const device = gpuDevice as any;
    const context = target.getContext('webgpu');
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
    const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: 4 | 2 | 16 });
    device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
    const module = device.createShaderModule({ code: GPU_WGSL });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: device.createSampler() }],
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
  validateParams: () => undefined,
});

/** WebGPU that asks for something that is not drawn. */
export const gpuCompute = createEffect<object, object>({
  type: 'test/gpu-compute',
  label: 'GpuCompute',
  documentationLink: null,
  backend: 'webgpu',
  calculateKey: () => 'gpu-compute',
  setup: () => ({}),
  apply: ({ gpuDevice }) => {
    (gpuDevice as any).createComputePipeline();
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: () => undefined,
});
