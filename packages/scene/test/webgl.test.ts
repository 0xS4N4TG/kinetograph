import { describe, expect, it } from 'vitest';
import { createWebGLContext, glslShader, GL, layerPicture, WebGLUnsupportedError, type WebGLContext } from '../src/index.js';

const VERTEX = 'attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const FRAGMENT = 'precision mediump float; varying vec2 v; uniform float t; uniform vec2 r[2]; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, v) * t; }';

function setup(): { gl: WebGLContext; program: ReturnType<WebGLContext['createProgram']> } {
  const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
  const program = gl.createProgram();
  for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
  gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, GL.FLOAT, false, 0, 0);
  return { gl, program };
}

describe('the recording WebGL context', () => {
  it('records a draw with its program, vertex data, uniforms and state', () => {
    const { gl, program } = setup();
    expect(gl.getProgramParameter(program, GL.LINK_STATUS)).toBe(true);
    gl.uniform1f(gl.getUniformLocation(program, 't'), 0.5);
    gl.uniform2fv(gl.getUniformLocation(program, 'r[1]'), [3, 4]);
    gl.viewport(0, 0, 8, 4);
    gl.clearColor(0, 0, 1, 1);
    gl.clear(GL.COLOR_BUFFER_BIT);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const content = gl.content();
    expect(content.ops.map((o) => o.op)).toEqual(['clear', 'draw']);
    const draw = content.ops[1]!;
    if (draw.op !== 'draw') throw new Error('not a draw');
    expect(draw.mode).toBe('triangles');
    expect(draw.viewport).toEqual([0, 0, 8, 4]);
    expect(draw.uniforms.t).toEqual([{ kind: 'f', value: [0.5] }]);
    expect(draw.uniforms.r).toEqual([{ kind: 'f', value: [3, 4], index: 1 }]);
    expect(draw.attributes.p).toMatchObject({ size: 2, type: 'f32', stride: 0, offset: 0 });
    expect(Object.keys(content.programs)).toHaveLength(1);
    expect(content.programs[draw.program]!.attributes).toEqual({ p: 0 });
    expect(Buffer.from(content.buffers[draw.attributes.p!.buffer]!, 'base64')).toHaveLength(24);
  });

  it('keeps one program and one buffer for draws that share them, and drops all at a clear', () => {
    const { gl } = setup();
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(Object.keys(gl.content().buffers)).toHaveLength(1);
    gl.clear(GL.COLOR_BUFFER_BIT);
    expect(gl.content().ops).toHaveLength(1);
  });

  it('starts a fresh drawing buffer on the first draw after resetState, and keeps the picture if nothing draws', () => {
    const { gl } = setup();
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.resetState();
    expect(gl.content().ops).toHaveLength(1);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.content().ops).toHaveLength(1);
  });

  it('records the texture bound to the unit a sampler names, with its sampling state', () => {
    const { gl, program } = setup();
    const texture = gl.createTexture();
    gl.activeTexture(GL.TEXTURE0 + 2);
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGB, 2, 1, 0, GL.RGB, GL.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 0, 255, 0]));
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 2);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const content = gl.content();
    const draw = content.ops[0]!;
    if (draw.op !== 'draw') throw new Error('not a draw');
    const unit = draw.units['2']!;
    expect(unit).toMatchObject({ min: 'LINEAR', mag: 'LINEAR', wrapS: 'CLAMP_TO_EDGE', wrapT: 'REPEAT' });
    const stored = content.textures[unit.texture]!;
    expect(stored).toMatchObject({ width: 2, height: 1, flipY: true });
    // RGB became RGBA with opaque alpha.
    expect([...Buffer.from(stored.pixels!, 'base64')]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('records a picture of a layer as a texture that names the layer, until pixels replace it', () => {
    const { gl, program } = setup();
    const texture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, layerPicture('scene-a', 8, 4));
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const content = gl.content();
    const [first, second] = content.ops.map((op) => (op.op === 'draw' ? content.textures[op.units['0']!.texture]! : null));
    expect(first).toEqual({ layer: 'scene-a' });
    expect(second).toMatchObject({ width: 1, height: 1 });
    expect(second).not.toHaveProperty('layer');
  });

  it('says unsupported, naming what to do, for what it does not draw', () => {
    const { gl } = setup();
    const refused = (fn: () => void): string => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(WebGLUnsupportedError);
        return (e as Error).message;
      }
      throw new Error('did not throw');
    };
    gl.enable(GL.DEPTH_TEST);
    expect(refused(() => gl.drawArrays(GL.TRIANGLES, 0, 3))).toMatch(/^unsupported:.*depth/);
    gl.disable(GL.DEPTH_TEST);
    expect(refused(() => gl.drawArrays(GL.POINTS, 0, 3))).toMatch(/^unsupported:.*points/);
    expect(refused(() => gl.bindFramebuffer(GL.FRAMEBUFFER, gl.createFramebuffer()))).toMatch(/^unsupported:.*framebuffer/);
    expect(refused(() => gl.readPixels())).toMatch(/^unsupported:/);
    expect(refused(() => gl.bindTexture(GL.TEXTURE_CUBE_MAP, gl.createTexture()))).toMatch(/cube/);
    expect(refused(() => gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 4))).toMatch(/instanced/);
  });

  it('builds a full-screen shader layer with typed uniforms', () => {
    const content = glslShader({
      width: 16,
      height: 16,
      fragment: 'precision mediump float; uniform float t; uniform vec2 res; uniform int n; uniform mat2 m; void main() { gl_FragColor = vec4(t, res / 16.0, float(n) + m[0][0]); }',
      uniforms: { t: 0.25, res: [16, 16], n: 3, m: [1, 0, 0, 1] },
    });
    const draw = content.ops[0]!;
    if (draw.op !== 'draw') throw new Error('not a draw');
    expect(draw.count).toBe(6);
    expect(draw.uniforms.n).toEqual([{ kind: 'i', value: [3] }]);
    expect(draw.uniforms.m).toEqual([{ kind: 'm', value: [1, 0, 0, 1] }]);
    expect(draw.uniforms.res).toEqual([{ kind: 'f', value: [16, 16] }]);
    expect(() => glslShader({ width: 1, height: 1, fragment: 'void main() {}', uniforms: { nope: 1 } })).toThrow(/no uniform "nope"/);
  });
});
