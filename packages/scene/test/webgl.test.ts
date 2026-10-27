import { describe, expect, it } from 'vitest';
import { createWebGLContext, glslShader, GL, GL2, layerPicture, WebGLUnsupportedError, type WebGLContext } from '../src/index.js';

const VERTEX = 'attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const FRAGMENT = 'precision mediump float; varying vec2 v; uniform float t; uniform vec2 r[2]; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, v) * t; }';

function setup(options: { attributes?: { preserveDrawingBuffer?: boolean } } = {}): { gl: WebGLContext; program: ReturnType<WebGLContext['createProgram']> } {
  const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), ...options });
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

  it('starts a fresh drawing buffer after resetState, so a frame that draws nothing draws nothing', () => {
    const { gl } = setup();
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.resetState();
    expect(gl.drawn).toBe(false);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.content().ops).toHaveLength(2);
  });

  it('getParameter(VERTEX_ARRAY_BINDING) is the bound vertex array or null', () => {
    const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    expect(gl.getParameter(0x85b5)).toBeNull();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    expect(gl.getParameter(0x85b5)).toBe(vao);
    gl.bindVertexArray(null);
    expect(gl.getParameter(0x85b5)).toBeNull();
    expect(gl.getError()).toBe(GL.NO_ERROR);
  });

  it('records a points draw and reports the point size range', () => {
    const { gl } = setup();
    gl.drawArrays(GL.POINTS, 1, 2);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    expect(gl.content().ops[0]).toMatchObject({ op: 'draw', mode: 'points', first: 1, count: 2 });
    expect([...(gl.getParameter(0x846d) as Float32Array)]).toEqual([1, 511]);
    expect(() => gl.drawArrays(GL.LINES, 0, 2)).toThrow(/lines/);
  });

  it('records blitFramebuffer between the canvas and a texture drawn in, keeping the canvas ops a blit reads', () => {
    const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    const texture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(GL.FRAMEBUFFER, null);
    gl.clear(GL.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(0x8ca8, null);
    gl.bindFramebuffer(0x8ca9, framebuffer);
    gl.blitFramebuffer(0, 0, 8, 4, 8, 0, 0, 4, GL.COLOR_BUFFER_BIT, GL.LINEAR);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    gl.bindFramebuffer(0x8ca9, null);
    gl.clear(GL.COLOR_BUFFER_BIT);
    const ops = gl.content().ops;
    expect(ops.map((op) => op.op)).toEqual(['clear', 'blit', 'clear']);
    expect(ops[1]).toMatchObject({ op: 'blit', from: [0, 0, 8, 4], to: [8, 0, 0, 4], linear: true });
    expect((ops[1] as { target?: string }).target).toBeDefined();
    expect((ops[1] as { src?: string }).src).toBeUndefined();
    // Reading and writing the same buffer is refused, as GL refuses it.
    gl.blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, GL.COLOR_BUFFER_BIT, GL.NEAREST);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
  });

  it('records instanced draws with the attributes that advance per instance', () => {
    const { gl, program } = setup();
    const at = gl.getAttribLocation(program, gl.getActiveAttrib(program, 0)!.name);
    gl.vertexAttribDivisor(at, 1);
    gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 5);
    gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 0);
    gl.vertexAttribDivisor(at, 2);
    expect(() => gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 2)).toThrow(/vertexAttribDivisor\(2/);
    const ops = gl.content().ops;
    expect(ops).toHaveLength(1);
    const draw = ops[0] as { instances?: number; attributes: Record<string, { divisor?: number }> };
    expect(draw.instances).toBe(5);
    expect(Object.values(draw.attributes)[0]!.divisor).toBe(1);
  });

  it('starts every frame fresh with preserveDrawingBuffer too (a frame does not depend on the one before)', () => {
    const { gl } = setup({ attributes: { preserveDrawingBuffer: true } });
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.content().ops).toHaveLength(2);
    gl.resetState();
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

  it('uploads an element image with texElementImage2D as it does with texImage2D', () => {
    const { gl, program } = setup();
    gl.bindTexture(GL.TEXTURE_2D, gl.createTexture());
    gl.texElementImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, layerPicture('el', 8, 4));
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const content = gl.content();
    expect(Object.values(content.textures)).toEqual([{ layer: 'el' }]);
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
    gl.enable(GL.STENCIL_TEST);
    expect(refused(() => gl.drawArrays(GL.TRIANGLES, 0, 3))).toMatch(/^unsupported:.*stencil/);
    gl.disable(GL.STENCIL_TEST);
    expect(refused(() => gl.drawArrays(GL.LINES, 0, 2))).toMatch(/^unsupported:.*lines/);
    gl.bindRenderbuffer(GL.RENDERBUFFER, gl.createRenderbuffer());
    expect(refused(() => gl.renderbufferStorage(GL.RENDERBUFFER, GL.RGBA4, 4, 4))).toMatch(/^unsupported:.*colour.*renderbuffer/);
    expect(refused(() => gl.readPixels())).toMatch(/^unsupported:/);
    expect(refused(() => gl.bindTexture(GL.TEXTURE_CUBE_MAP, gl.createTexture()))).toMatch(/cube/);
    expect(refused(() => gl.drawArraysInstanced(GL.POINTS, 0, 3, 4))).toMatch(/instanced points/);
  });

  describe('the depth test', () => {
    const draws = (gl: WebGLContext) => gl.content().ops.flatMap((op) => (op.op === 'draw' ? [op] : []));

    it('draws without a depth test until DEPTH_TEST is on, then records the GL defaults: LESS, mask on, range 0 to 1', () => {
      const { gl } = setup();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.enable(GL.DEPTH_TEST);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const [off, on] = draws(gl);
      expect(off!.depth).toBeUndefined();
      expect(on!.depth).toEqual({ func: 'LESS', mask: true, near: 0, far: 1 });
      expect(gl.isEnabled(GL.DEPTH_TEST)).toBe(true);
      expect(gl.getParameter(GL.DEPTH_FUNC)).toBe(GL.LESS);
      expect(gl.getParameter(GL.DEPTH_WRITEMASK)).toBe(true);
      expect(gl.getParameter(GL.DEPTH_CLEAR_VALUE)).toBe(1);
    });

    it('records depthFunc, depthMask and depthRange with each draw, and refuses a function that is not one', () => {
      const { gl } = setup();
      gl.enable(GL.DEPTH_TEST);
      const names = ['NEVER', 'LESS', 'EQUAL', 'LEQUAL', 'GREATER', 'NOTEQUAL', 'GEQUAL', 'ALWAYS'];
      for (const [i, name] of names.entries()) {
        gl.depthFunc(GL.NEVER + i);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        expect(draws(gl).at(-1)!.depth!.func).toBe(name);
      }
      gl.depthFunc(GL.LEQUAL);
      gl.depthMask(false);
      gl.depthRange(0.25, 3);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl).at(-1)!.depth).toEqual({ func: 'LEQUAL', mask: false, near: 0.25, far: 1 });
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.depthFunc(GL.POINTS);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      expect(gl.getParameter(GL.DEPTH_FUNC)).toBe(GL.LEQUAL);
      gl.depthRange(0.8, 0.2);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('clears the depth buffer to clearDepth with DEPTH_BUFFER_BIT, clamped, only where depthMask lets it be written', () => {
      const { gl } = setup();
      gl.clearDepth(0.5);
      gl.clear(GL.DEPTH_BUFFER_BIT);
      gl.clearDepth(7);
      gl.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
      gl.depthMask(false);
      gl.clear(GL.DEPTH_BUFFER_BIT);
      expect(gl.content().ops).toEqual([{ op: 'clear', color: [0, 0, 0, 0], depth: 1 }]);
      gl.depthMask(true);
      gl.clear(GL.DEPTH_BUFFER_BIT);
      expect(gl.content().ops.at(-1)).toEqual({ op: 'clear', depth: 1 });
    });

    it('keeps the draws before a colour-only clear when they tested depth, since a later draw tests against what they wrote', () => {
      const { gl } = setup();
      gl.enable(GL.DEPTH_TEST);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.content().ops.map((o) => o.op)).toEqual(['draw', 'clear']);
      gl.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
      expect(gl.content().ops.map((o) => o.op)).toEqual(['clear']);
    });

    it('has no depth buffer, so the test passes and nothing is cleared, with the context attribute depth: false', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), attributes: { depth: false } });
      gl.enable(GL.DEPTH_TEST);
      gl.clear(GL.DEPTH_BUFFER_BIT);
      expect(gl.content().ops).toEqual([]);
      expect(gl.getParameter(GL.DEPTH_BITS)).toBe(0);
    });

    it('records polygonOffset with a draw that tests depth, only while POLYGON_OFFSET_FILL is on', () => {
      const { gl } = setup();
      gl.enable(GL.DEPTH_TEST);
      gl.polygonOffset(-1, -2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.enable(GL.POLYGON_OFFSET_FILL);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.disable(GL.POLYGON_OFFSET_FILL);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl).map((d) => d.polygonOffset)).toEqual([undefined, { factor: -1, units: -2 }, undefined]);
    });

    it('gives a framebuffer a depth buffer with a depth renderbuffer, and tests only a framebuffer that has one', () => {
      const { gl } = setup();
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.enable(GL.DEPTH_TEST);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl).at(-1)!.depth).toBeUndefined();
      gl.clear(GL.DEPTH_BUFFER_BIT);
      expect(gl.content().ops.map((o) => o.op)).toEqual(['draw']);

      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, depth);
      gl.renderbufferStorage(GL.RENDERBUFFER, GL.DEPTH_COMPONENT16, 4, 2);
      expect(gl.isRenderbuffer(depth)).toBe(true);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, depth);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl).at(-1)!.depth).toEqual({ func: 'LESS', mask: true, near: 0, far: 1 });
      gl.clear(GL.DEPTH_BUFFER_BIT);
      const clear = gl.content().ops.at(-1)!;
      expect(clear).toMatchObject({ op: 'clear', depth: 1 });
      expect(clear.target).toBeDefined();

      // The canvas is another buffer, with its own.
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(draws(gl).at(-1)!.depth).toBeDefined();
      expect(draws(gl).at(-1)!.target).toBeUndefined();
    });
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
      expect(refused(() => gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, gl.createRenderbuffer()))).toMatch(/renderbuffer/);

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

      // Once drawn in, a texture is not mipmapped from the page.
      specify(GL.RGBA, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      expect(refused(() => gl.generateMipmap(GL.TEXTURE_2D))).toMatch(/generateMipmap/);
    });

    it('records texSubImage2D into a texture drawn in as an upload after the draws, at the offset', () => {
      const { gl } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 2, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 3, 1, 2, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(8));
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      const ops = gl.content().ops;
      expect(ops.map((op) => op.op)).toEqual(['draw', 'upload']);
      expect(ops[1]).toMatchObject({ op: 'upload', x: 1, y: 1, width: 2, height: 1, flipY: true });
      expect((ops[1] as { target: string }).target).toBe((ops[0] as { target: string }).target);
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
