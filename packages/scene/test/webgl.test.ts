import { describe, expect, it } from 'vitest';
import { createWebGLContext, glslShader, GL, GL2, layerPicture, WebGLUnsupportedError, type WebGLContext } from '../src/index.js';

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

  it('names every texture unit it has, as gl.TEXTURE1 is used by multi-texture pages', () => {
    const { gl } = setup();
    const constants = gl as unknown as Record<string, number>;
    for (let unit = 0; unit < 16; unit += 1) expect(constants[`TEXTURE${unit}`]).toBe(GL.TEXTURE0 + unit);
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
    expect(refused(() => gl.bindRenderbuffer(GL.RENDERBUFFER, gl.createRenderbuffer()))).toMatch(/^unsupported:.*renderbuffers/);
    expect(refused(() => gl.readPixels())).toMatch(/^unsupported:/);
    expect(refused(() => (gl as any).blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, 0x4000, 0x2600))).toMatch(/^unsupported:/);
    expect(refused(() => gl.bindTexture(GL.TEXTURE_CUBE_MAP, gl.createTexture()))).toMatch(/cube/);
    expect(refused(() => gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 4))).toMatch(/instanced/);
  });

  describe('framebuffers', () => {
    /** A texture of this size allocated as a render target, and a framebuffer with it attached (and bound). */
    function attach(gl: WebGLContext, width: number, height: number) {
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      // Left bound on its unit, the program's sampler would read what it draws.
      gl.bindTexture(GL.TEXTURE_2D, null);
      return { texture, framebuffer };
    }
    function draws(gl: WebGLContext) {
      return gl.content().ops.flatMap((op) => (op.op === 'draw' ? [op] : []));
    }
    function refused(fn: () => void): string {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(WebGLUnsupportedError);
        return (e as Error).message;
      }
      throw new Error('did not throw');
    }

    it('records clears and draws with the texture they go to, and a later draw samples it', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
      gl.viewport(0, 0, 4, 2);
      gl.clearColor(0, 0, 1, 1);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.uniform1f(gl.getUniformLocation(program, 't'), 1);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.viewport(0, 0, 8, 4);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);

      const content = gl.content();
      const [clear, inside, outside] = content.ops;
      if (clear?.op !== 'clear' || inside?.op !== 'draw' || outside?.op !== 'draw') throw new Error('unexpected ops');
      const id = clear.target!;
      expect(id).toBeTypeOf('string');
      expect(inside.target).toBe(id);
      expect(inside.viewport).toEqual([0, 0, 4, 2]);
      expect(outside.target).toBeUndefined();
      expect(outside.viewport).toEqual([0, 0, 8, 4]);
      expect(content.textures[id]).toEqual({ target: true, width: 4, height: 2 });
      // The canvas's draw reads the texture the framebuffer drew in, by the same id.
      expect(outside.units['0']).toMatchObject({ texture: id, min: 'LINEAR' });
      expect(texture.drawnAt).toBe(texture.version);
    });

    it('keeps what went to textures when the canvas is cleared, and drops what went to the canvas', () => {
      const { gl } = setup();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const { framebuffer } = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.content().ops.map((op) => [op.op, op.target !== undefined])).toEqual([
        ['draw', true],
        ['clear', false],
      ]);
      expect(framebuffer.bound).toBe(true);
    });

    it('draws alternately into two textures and gives each specification of a texture its own id', () => {
      const { gl } = setup();
      const a = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const b = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindFramebuffer(GL.FRAMEBUFFER, a.framebuffer);
      gl.activeTexture(GL.TEXTURE0);
      gl.bindTexture(GL.TEXTURE_2D, b.texture);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const [first, second, third] = draws(gl);
      expect(new Set([first!.target, second!.target]).size).toBe(2);
      expect(third!.target).toBe(first!.target);
      expect(third!.units['0']!.texture).toBe(second!.target);
      // Specified again, a texture is a new, empty one.
      gl.bindTexture(GL.TEXTURE_2D, a.texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl)[3]!.target).not.toBe(first!.target);
    });

    it('starts each frame with its textures empty', () => {
      const { gl } = setup();
      attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      expect(content.ops).toHaveLength(1);
      expect(Object.keys(content.textures)).toEqual([draws(gl)[0]!.target]);
    });

    it('reports an incomplete framebuffer and draws nothing into it', () => {
      const { gl } = setup();
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_FRAMEBUFFER_OPERATION);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.getError()).toBe(GL.INVALID_FRAMEBUFFER_OPERATION);

      // A texture nothing specified, then one of a format colour cannot be drawn in.
      const texture = gl.createTexture();
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 2, 2, 0, GL.LUMINANCE, GL.UNSIGNED_BYTE, null);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_FRAMEBUFFER_OPERATION);
      expect(gl.content().ops).toHaveLength(0);

      // The canvas is always complete.
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
    });

    it('refuses a draw that reads the texture it draws into', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.activeTexture(GL.TEXTURE0 + 1);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 1);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      expect(gl.content().ops).toHaveLength(0);
      // On another unit nothing reads it.
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      expect(draws(gl)).toHaveLength(1);
    });

    it('binds framebuffers as WebGL does', () => {
      const { gl } = setup();
      const framebuffer = gl.createFramebuffer();
      expect(gl.isFramebuffer(framebuffer)).toBe(false);
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      expect(gl.isFramebuffer(framebuffer)).toBe(true);
      expect(gl.getParameter(GL.FRAMEBUFFER_BINDING)).toBe(framebuffer);
      gl.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, framebuffer);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      gl.deleteFramebuffer(framebuffer);
      expect(gl.getParameter(GL.FRAMEBUFFER_BINDING)).toBeNull();
      expect(gl.isFramebuffer(framebuffer)).toBe(false);
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      // Attaching needs a framebuffer.
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, null, 0);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);

      const gl2 = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const other = gl2.createFramebuffer();
      gl2.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, other);
      expect(gl2.getParameter(GL2.DRAW_FRAMEBUFFER_BINDING)).toBe(other);
      expect(gl2.getParameter(GL2.READ_FRAMEBUFFER_BINDING)).toBeNull();
      gl2.bindFramebuffer(GL2.READ_FRAMEBUFFER, other);
      expect(gl2.getParameter(GL2.READ_FRAMEBUFFER_BINDING)).toBe(other);
    });

    it('says unsupported for what a render target here cannot be', () => {
      const { gl } = setup();
      const { framebuffer, texture } = attach(gl, 4, 2);
      expect(refused(() => gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, texture, 0))).toMatch(/^unsupported:.*depth/);
      expect(refused(() => gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 1))).toMatch(/level/);
      expect(refused(() => gl.bindRenderbuffer(GL.RENDERBUFFER, gl.createRenderbuffer()))).toMatch(/renderbuffers/);

      // Pixels from the page, or a format other than RGBA, cannot be drawn over.
      const specify = (internalformat: number, data: Uint8Array | null) => {
        gl.bindTexture(GL.TEXTURE_2D, texture);
        gl.texImage2D(GL.TEXTURE_2D, 0, internalformat, 1, 1, 0, internalformat, GL.UNSIGNED_BYTE, data);
        gl.bindTexture(GL.TEXTURE_2D, null);
      };
      specify(GL.RGBA, new Uint8Array([1, 2, 3, 4]));
      expect(refused(() => gl.drawArrays(GL.TRIANGLES, 0, 3))).toMatch(/uploaded pixels/);
      specify(GL.RGB, null);
      expect(refused(() => gl.clear(GL.COLOR_BUFFER_BIT))).toMatch(/RGBA/);
      expect(framebuffer.color).toBe(texture);

      // Once drawn in, a texture is not edited from the page.
      specify(GL.RGBA, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      expect(refused(() => gl.generateMipmap(GL.TEXTURE_2D))).toMatch(/generateMipmap/);
      expect(refused(() => gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4)))).toMatch(/texSubImage2D/);
    });
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
