import { describe, expect, it } from 'vitest';
import { createWebGLContext, glslShader, GL, GL2, layerPicture, VideoFramePicture, WebGLUnsupportedError, type WebGLContext } from '../src/index.js';

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
    const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2, attributes: { antialias: false } });
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

    // An antialiased canvas is multisampled, as in Chrome: it takes no blit, and gives one only of its own bounds.
    const aa = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    const fb = aa.createFramebuffer();
    aa.bindFramebuffer(GL.FRAMEBUFFER, fb);
    aa.bindTexture(GL.TEXTURE_2D, aa.createTexture());
    aa.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    aa.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, aa.getParameter(GL.TEXTURE_BINDING_2D) as never, 0);
    aa.bindFramebuffer(GL2.READ_FRAMEBUFFER, null);
    aa.blitFramebuffer(0, 0, 8, 4, 8, 0, 0, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST);
    expect(aa.getError()).toBe(GL.INVALID_OPERATION);
    aa.blitFramebuffer(0, 0, 8, 4, 0, 0, 8, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST);
    expect(aa.getError()).toBe(GL.NO_ERROR);
    aa.bindFramebuffer(GL2.READ_FRAMEBUFFER, fb);
    aa.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, null);
    aa.blitFramebuffer(0, 0, 8, 4, 0, 0, 8, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST);
    expect(aa.getError()).toBe(GL.INVALID_OPERATION);
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

  it('uploads a video frame (onVideoFrame) with texImage2D as the pixels the addon reads of it', () => {
    const asked: unknown[] = [];
    const gl = createWebGLContext({
      size: () => ({ width: 8, height: 4 }),
      rasterize: (canvas) => {
        asked.push(canvas);
        return new Uint8Array(4 * 2 * 4).fill(9);
      },
    });
    const program = gl.createProgram();
    for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindTexture(GL.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, new VideoFramePicture('/p/clip.mp4', 0.5, 4, 2));
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    // The frame was asked for as a canvas of its own size that draws it 1:1.
    expect(asked).toEqual([
      { kind: 'canvas', width: 4, height: 2, commands: [{ op: 'image', source: { kind: 'video', src: '/p/clip.mp4', time: 0.5 }, dx: 0, dy: 0, dw: 4, dh: 2 }] },
    ]);
    const content = gl.content();
    expect(Object.values(content.textures)).toMatchObject([{ width: 4, height: 2 }]);
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
    expect(refused(() => gl.drawArrays(GL.LINES, 0, 2))).toMatch(/^unsupported:.*lines/);
    const gl2 = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    gl2.bindRenderbuffer(GL.RENDERBUFFER, gl2.createRenderbuffer());
    expect(refused(() => gl2.renderbufferStorageMultisample(GL.RENDERBUFFER, 4, GL2.RGBA8, 4, 4))).toMatch(/^unsupported:.*multisampled/);
    expect(refused(() => gl.readPixels())).toMatch(/^unsupported:/);
    expect(refused(() => gl.bindTexture(0x8d65, gl.createTexture()))).toMatch(/textures other than.*0x8d65/);
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
      // A colour texture is not a depth buffer; WebGL 1 attaches level 0 only.
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, texture, 0);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 1);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);

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

  describe('stencil, several outputs, depth textures and renderbuffers', () => {
    /** A WebGL 2 context like `setup`'s, with these context attributes. */
    function setup2(attributes: { stencil?: boolean; depth?: boolean; antialias?: boolean } = {}) {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2, attributes });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.bindBuffer(GL.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
      return { gl, program };
    }
    const draws = (gl: WebGLContext) => gl.content().ops.flatMap((op) => (op.op === 'draw' ? [op] : []));
    function texture(gl: WebGLContext, internalformat: number, format: number, type: number, width = 4, height = 2) {
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.texImage2D(GL.TEXTURE_2D, 0, internalformat, width, height, 0, format, type, null);
      gl.bindTexture(GL.TEXTURE_2D, null);
      return t;
    }
    function renderbuffer(gl: WebGLContext, format: number, width = 4, height = 2) {
      const r = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, r);
      gl.renderbufferStorage(GL.RENDERBUFFER, format, width, height);
      return r;
    }

    it('records the stencil test with each draw where the buffer drawn into has a stencil buffer', () => {
      const { gl } = setup2({ stencil: true });
      expect(gl.content().stencil).toBe(true);
      gl.enable(GL.STENCIL_TEST);
      gl.stencilFunc(GL.EQUAL, 3, 0xff);
      gl.stencilOpSeparate(GL.BACK, GL.KEEP, GL.INCR, GL.DECR_WRAP);
      gl.stencilOpSeparate(GL.FRONT, GL.ZERO, GL.KEEP, GL.REPLACE);
      gl.clearStencil(2);
      gl.clear(GL.COLOR_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.content().ops[0]).toMatchObject({ op: 'clear', stencil: 2 });
      expect(draws(gl)[0]!.stencil).toEqual({
        ref: 3,
        valueMask: 0xff,
        writeMask: 0xff,
        front: { func: 'EQUAL', fail: 'ZERO', zfail: 'KEEP', zpass: 'REPLACE' },
        back: { func: 'EQUAL', fail: 'KEEP', zfail: 'INCR', zpass: 'DECR_WRAP' },
      });
      expect(gl.getParameter(GL.STENCIL_BACK_PASS_DEPTH_PASS)).toBe(GL.DECR_WRAP);

      // Faces that differ in the reference or a mask: WebGL refuses the draw.
      gl.stencilFuncSeparate(GL.BACK, GL.EQUAL, 4, 0xff);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      expect(draws(gl)).toHaveLength(1);

      // Without a stencil buffer the test passes and nothing is recorded.
      const plain = setup2().gl;
      plain.enable(GL.STENCIL_TEST);
      plain.clear(GL.STENCIL_BUFFER_BIT);
      plain.drawArrays(GL.TRIANGLES, 0, 3);
      expect(plain.content().ops.map((o) => o.op)).toEqual(['draw']);
      expect(draws(plain)[0]!.stencil).toBeUndefined();
    });

    it('gives a framebuffer a depth and stencil buffer that ops name, shared by framebuffers that attach it', () => {
      const { gl } = setup2();
      const colour = texture(gl, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE);
      const ds = renderbuffer(gl, GL2.DEPTH24_STENCIL8);
      const a = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, a);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, ds);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
      gl.enable(GL.DEPTH_TEST);
      gl.enable(GL.STENCIL_TEST);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const [draw] = draws(gl);
      expect(draw!.depthStencil).toMatch(/^r/);
      expect(gl.content().textures[draw!.depthStencil!]).toEqual({ target: true, width: 4, height: 2, format: 'depthStencil' });
      expect(draw!.depth).toBeDefined();
      expect(draw!.stencil).toBeDefined();

      // A colour-only clear leaves it out; a depth clear names it.
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.clear(GL.DEPTH_BUFFER_BIT);
      const [colorClear, depthClear] = gl.content().ops.slice(1);
      expect(colorClear).not.toHaveProperty('depthStencil');
      expect(depthClear).toMatchObject({ op: 'clear', depth: 1, depthStencil: draw!.depthStencil });

      // A depth renderbuffer and a stencil one are two images: unsupported, as in WebGL.
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, renderbuffer(gl, GL.DEPTH_COMPONENT16));
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.STENCIL_ATTACHMENT, GL.RENDERBUFFER, renderbuffer(gl, GL.STENCIL_INDEX8));
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_UNSUPPORTED);
    });

    it('maps the outputs of a fragment shader to colour attachments with drawBuffers', () => {
      const { gl } = setup2();
      const [a, b] = [texture(gl, GL2.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE), texture(gl, GL2.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE)];
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, a, 0);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL2.COLOR_ATTACHMENT1, GL.TEXTURE_2D, b, 0);
      // Output 0 alone, by default.
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.drawBuffers([GL.COLOR_ATTACHMENT0, GL2.COLOR_ATTACHMENT1]);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.drawBuffers([GL.NONE, GL2.COLOR_ATTACHMENT1]);
      gl.clear(GL.COLOR_BUFFER_BIT);
      const [one, both, clear] = gl.content().ops as Array<{ target?: string; outputs?: unknown[] }>;
      expect(one!.target).toBeDefined();
      expect(one!.outputs).toBeUndefined();
      expect(both!.outputs).toEqual([{ target: one!.target }, { target: expect.stringMatching(/^f/) }]);
      expect(clear!.outputs).toEqual([null, (both!.outputs as unknown[])[1]]);
      expect(gl.getParameter(GL2.DRAW_BUFFER0 + 1)).toBe(GL2.COLOR_ATTACHMENT1);
      // Output i goes to COLOR_ATTACHMENTi or nowhere.
      gl.drawBuffers([GL2.COLOR_ATTACHMENT1]);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      // clearBuffer clears one draw buffer.
      gl.clearBufferfv(GL2.COLOR, 1, [1, 0, 0, 1]);
      expect(gl.content().ops.at(-1)).toEqual({ op: 'clear', color: [1, 0, 0, 1], target: (both!.outputs as Array<{ target: string }>)[1]!.target });
    });

    it('draws into a depth texture, and a later draw samples it as a target', () => {
      const { gl, program } = setup2();
      const colour = texture(gl, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE);
      const depth = texture(gl, GL2.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, depth, 0);
      gl.enable(GL.DEPTH_TEST);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      // Sampling it while it is attached is a feedback loop.
      gl.bindTexture(GL.TEXTURE_2D, depth);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const [into, onCanvas] = draws(gl);
      expect(into!.depthStencil).toBe(onCanvas!.units['0']!.texture);
      expect(gl.content().textures[into!.depthStencil!]).toMatchObject({ target: true, format: 'depth' });
      // A depth texture has no pixels to give.
      gl.bindTexture(GL.TEXTURE_2D, depth);
      expect(() => gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
    });

    it('draws into a colour renderbuffer and into a level of a texture', () => {
      const { gl } = setup2();
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, renderbuffer(gl, GL.RGBA4));
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const t = texture(gl, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, 8, 8);
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.texImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      expect(() => gl.texImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 3, 3, 0, GL.RGBA, GL.UNSIGNED_BYTE, null)).toThrow(/level 2/);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 1);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const [rb, level] = draws(gl);
      expect(rb!.target).toMatch(/^r/);
      expect(gl.content().textures[rb!.target!]).toEqual({ target: true, width: 4, height: 2 });
      expect(level!.level).toBe(1);
      expect(gl.content().textures[level!.target!]).toEqual({ target: true, width: 8, height: 8, levels: 2 });
      // A level that has no storage is an incomplete attachment.
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 2);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
    });

    it('blits depth and stencil between buffers of one format, texel for texel', () => {
      const { gl } = setup2({ stencil: true, antialias: false });
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, renderbuffer(gl, GL2.RGBA8, 8, 4));
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, renderbuffer(gl, GL2.DEPTH24_STENCIL8, 8, 4));
      gl.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, null);
      // LINEAR is refused for depth and stencil.
      gl.blitFramebuffer(0, 0, 8, 4, 0, 0, 8, 4, GL.DEPTH_BUFFER_BIT, GL.LINEAR);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.blitFramebuffer(0, 0, 8, 4, 0, 0, 8, 4, GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT, GL.NEAREST);
      const [colour, ds] = gl.content().ops as Array<{ op: string; aspect?: string; src?: string; target?: string }>;
      expect(colour).toMatchObject({ op: 'blit', src: expect.stringMatching(/^r/) });
      expect(colour!.aspect).toBeUndefined();
      expect(ds).toMatchObject({ op: 'blit', aspect: 'depthStencil', src: expect.stringMatching(/^r/) });
      expect(ds!.target).toBeUndefined();
      // A canvas without stencil has another format: refused.
      const { gl: other } = setup2({ antialias: false });
      other.bindFramebuffer(GL.FRAMEBUFFER, other.createFramebuffer());
      other.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, renderbuffer(other, GL2.DEPTH24_STENCIL8, 8, 4));
      other.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, null);
      other.blitFramebuffer(0, 0, 8, 4, 0, 0, 8, 4, GL.DEPTH_BUFFER_BIT, GL.NEAREST);
      expect(other.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('lays texSubImage2D of a picture file or a layer over a texture as a patch, and into a target as an upload', () => {
      const { gl, program } = setup2();
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.textureFromSource(t, 'base.png');
      t.width = 8;
      t.height = 8;
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, layerPicture('child', 4, 4));
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const stored = gl.content().textures[draws(gl)[0]!.units['0']!.texture]!;
      expect(stored.src).toBe('base.png');
      expect(stored.patches).toEqual([
        { x: 2, y: 2, width: 4, height: 4, layer: 'child' },
        { x: 0, y: 0, width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 4]).toString('base64') },
      ]);

      // Into a texture a framebuffer drew in: an op after the draws.
      const target = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, target);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(GL.FRAMEBUFFER, gl.createFramebuffer());
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, target, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, GL.RGBA, GL.UNSIGNED_BYTE, layerPicture('child', 4, 4));
      expect(gl.content().ops.at(-1)).toMatchObject({ op: 'upload', x: 0, y: 0, width: 4, height: 4, layer: 'child', flipY: true });
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

  describe('3D textures and textures in the vertex shader', () => {
    const VERTEX_3 = '#version 300 es\nin vec2 p; uniform sampler2D height; void main() { gl_Position = vec4(p, texelFetch(height, ivec2(0), 0).r, 1.0); }';
    const FRAGMENT_3 = '#version 300 es\nprecision highp float; precision highp sampler3D; uniform sampler3D lut; uniform int n; out vec4 o; void main() { o = texelFetch(lut, ivec3(n), 0); }';

    function volumeContext() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX_3], [GL.FRAGMENT_SHADER, FRAGMENT_3]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
      return { gl, program };
    }

    it('reports the limits a vertex texture and a 3D texture need', () => {
      const { gl } = volumeContext();
      expect(gl.getParameter(GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS)).toBeGreaterThanOrEqual(16);
      expect(gl.getParameter(GL2.MAX_3D_TEXTURE_SIZE)).toBeGreaterThanOrEqual(256);
      expect(gl.getActiveUniform(volumeContext().program, 0)).not.toBeNull();
    });

    it('records a texImage3D of half floats and the draw that samples it, and a vertex texture, by unit', () => {
      const { gl, program } = volumeContext();
      const height = gl.createTexture();
      gl.activeTexture(GL.TEXTURE0);
      gl.bindTexture(GL.TEXTURE_2D, height);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
      const lut = gl.createTexture();
      gl.activeTexture(GL.TEXTURE1);
      gl.bindTexture(GL2.TEXTURE_3D, lut);
      gl.texParameteri(GL2.TEXTURE_3D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
      gl.texParameteri(GL2.TEXTURE_3D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
      gl.texParameteri(GL2.TEXTURE_3D, GL.TEXTURE_WRAP_R, GL.CLAMP_TO_EDGE);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA16F, 2, 2, 2, 0, GL.RGBA, GL.FLOAT, new Float32Array(32).fill(0.5));
      gl.uniform1i(gl.getUniformLocation(program, 'height'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'lut'), 1);
      gl.uniform1i(gl.getUniformLocation(program, 'n'), 1);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(Object.keys(draw.units).sort()).toEqual(['0', '1']);
      expect(draw.units['1']).toMatchObject({ min: 'NEAREST', mag: 'NEAREST', wrapR: 'CLAMP_TO_EDGE' });
      expect(draw.units['0']!.wrapR).toBeUndefined();
      const volume = content.textures[draw.units['1']!.texture]!;
      expect(volume).toMatchObject({ width: 2, height: 2, depth: 2 });
      expect(Buffer.from(volume.floats!, 'base64')).toHaveLength(32 * 4);
      expect(volume.pixels).toBeUndefined();
      expect(content.textures[draw.units['0']!.texture]!.depth).toBeUndefined();
    });

    it('stores the bytes of an RGBA8 3D texture and edits them with texSubImage3D', () => {
      const { gl, program } = volumeContext();
      const lut = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_3D, lut);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA8, 2, 1, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(16));
      gl.texSubImage3D(GL2.TEXTURE_3D, 0, 1, 0, 1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.uniform1i(gl.getUniformLocation(program, 'height'), 1);
      gl.uniform1i(gl.getUniformLocation(program, 'lut'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const volume = content.textures[draw.units['0']!.texture]!;
      const bytes = Buffer.from(volume.pixels!, 'base64');
      expect([...bytes.subarray(12, 16)]).toEqual([1, 2, 3, 4]);
      expect(bytes.subarray(0, 12).every((b) => b === 0)).toBe(true);
    });

    it('follows WebGL on the errors of a 3D upload and of binding', () => {
      const { gl } = volumeContext();
      const lut = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_3D, lut);
      // Flip and premultiply are refused for 3D textures.
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA8, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
      // Too little data, a bad border, a type that does not go with the format.
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA8, 2, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA8, 1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA16F, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      // A texture keeps the type it was first bound to.
      gl.bindTexture(GL.TEXTURE_2D, lut);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      // What is not drawn says so.
      expect(() => gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.SRGB8_ALPHA8, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
      gl.texImage3D(GL2.TEXTURE_3D, 0, GL2.RGBA8, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(() => gl.generateMipmap(GL2.TEXTURE_3D)).toThrow(/3D/);
      // A WebGL 1 context has no 3D textures.
      const one = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 1 });
      expect(() => one.bindTexture(GL2.TEXTURE_3D, one.createTexture())).toThrow(WebGLUnsupportedError);
    });

    it('refuses a draw that reads one unit as a 2D and a 3D texture', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [
        [GL.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'],
        [GL.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; uniform sampler2D a; uniform sampler3D b; out vec4 o; void main() { o = texelFetch(a, ivec2(0), 0) + texelFetch(b, ivec3(0), 0); }'],
      ] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
      gl.uniform1i(gl.getUniformLocation(program, 'a'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'b'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      expect(gl.content().ops).toHaveLength(0);
    });
  });

  describe('float textures', () => {
    function floatContext() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [
        [GL.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'],
        [GL.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; uniform highp sampler2D curve; out vec4 o; void main() { o = vec4(texelFetch(curve, ivec2(1, 0), 0).r); }'],
      ] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      return { gl, program };
    }

    it('records an R32F upload as RGBA floats, 32-bit, and the draw that samples it', () => {
      const { gl, program } = floatContext();
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 3, 1, 0, GL2.RED, GL.FLOAT, new Float32Array([0.25, 2, -1]));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
      gl.uniform1i(gl.getUniformLocation(program, 'curve'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture).toMatchObject({ width: 3, height: 1, float32: true });
      expect(texture.depth).toBeUndefined();
      expect([...new Float32Array(new Uint8Array(Buffer.from(texture.floats!, 'base64')).buffer)]).toEqual([0.25, 0, 0, 1, 2, 0, 0, 1, -1, 0, 0, 1]);
    });

    it('keeps 16-bit formats as half floats, reads half-float data, and flips the rows', () => {
      const { gl } = floatContext();
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
      // 0x3c00 is 1.0, 0x4000 is 2.0.
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.RG16F, 1, 2, 0, GL2.RG, GL.HALF_FLOAT, new Uint16Array([0x3c00, 0x4000, 0x4000, 0x3c00]));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture.float32).toBeUndefined();
      expect([...new Float32Array(new Uint8Array(Buffer.from(texture.floats!, 'base64')).buffer)]).toEqual([2, 1, 0, 1, 1, 2, 0, 1]);
    });

    it('follows WebGL on the errors of a float upload', () => {
      const { gl } = floatContext();
      // The format must go with the internal format, the type with both.
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 1, 1, 0, GL.RGBA, GL.FLOAT, new Float32Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 1, 1, 0, GL2.RED, GL.HALF_FLOAT, new Uint16Array(1));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 2, 1, 0, GL2.RED, GL.FLOAT, new Float32Array(1));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 1, 1, 0, GL2.RED, GL.FLOAT, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      // What cannot be drawn says so.
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.R32F, 1, 1, 0, GL2.RED, GL.FLOAT, new Float32Array(1));
      expect(() => gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL2.RED, GL.FLOAT, new Float32Array(1))).toThrow(WebGLUnsupportedError);
      expect(() => gl.generateMipmap(GL.TEXTURE_2D)).toThrow(/float/);
      expect(() => gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.FLOAT, new Float32Array(4))).toThrow(WebGLUnsupportedError);
    });
  });

  describe('cube maps', () => {
    const FRAGMENT_CUBE = 'precision mediump float; varying vec2 v; uniform samplerCube env; void main() { gl_FragColor = textureCube(env, vec3(v, 1.0)); }';

    function cubeContext() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT_CUBE]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
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

    function upload(gl: WebGLContext, side: number, faces = 6): void {
      for (let f = 0; f < faces; f += 1) {
        const pixels = new Uint8Array(side * side * 4).fill(10 * (f + 1));
        gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, GL.RGBA, side, side, 0, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
      }
    }

    it('records six faces of a complete cube map in GL order', () => {
      const { gl, program } = cubeContext();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      expect(gl.getParameter(GL.TEXTURE_BINDING_CUBE_MAP)).toBe(cube);
      upload(gl, 2);
      gl.texParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture.cube).toBe(true);
      expect(texture.width).toBe(2);
      expect(texture.faces).toHaveLength(6);
      expect(Buffer.from(texture.faces![3]!.pixels!, 'base64')[0]).toBe(40);
    });

    it('is incomplete, and records no faces, until all six are uploaded', () => {
      const { gl, program } = cubeContext();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      upload(gl, 2, 5);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(content.textures[draw.units['0']!.texture]).toEqual({ cube: true, faces: [] });
      gl.generateMipmap(GL.TEXTURE_CUBE_MAP);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('marks mipmaps and keeps a texture to the target it was bound to first', () => {
      const { gl } = cubeContext();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      upload(gl, 4);
      gl.generateMipmap(GL.TEXTURE_CUBE_MAP);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.bindTexture(GL.TEXTURE_2D, cube);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('accepts the empty 1 x 1 cube map three.js binds at start-up, and refuses what it cannot draw', () => {
      const { gl } = cubeContext();
      const empty = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, empty);
      for (let f = 0; f < 6; f += 1) gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      expect(() => gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
      expect(() => gl.texSubImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
    });
  });

  describe('2D array textures', () => {
    const FRAGMENT_ARRAY = '#version 300 es\nprecision highp float; precision highp sampler2DArray; in vec2 v; uniform sampler2DArray layers; out vec4 o; void main() { o = texture(layers, vec3(v, 1.0)); }';
    const VERTEX_ES3 = '#version 300 es\nin vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';

    function arrayContext() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX_ES3], [GL.FRAGMENT_SHADER, FRAGMENT_ARRAY]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
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
      gl.uniform1i(gl.getUniformLocation(program, 'layers'), 0);
      return { gl, program };
    }

    function drawn(gl: WebGLContext) {
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      const draw = content.ops.at(-1)!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      return { content, draw };
    }

    it('binds per target, so a unit holds a 3D texture and an array at once', () => {
      const { gl } = arrayContext();
      const array = gl.createTexture();
      const volume = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, array);
      gl.bindTexture(GL2.TEXTURE_3D, volume);
      expect(gl.getParameter(GL2.TEXTURE_BINDING_2D_ARRAY)).toBe(array);
      expect(gl.getParameter(GL2.TEXTURE_BINDING_3D)).toBe(volume);
      expect(gl.getParameter(GL2.MAX_ARRAY_TEXTURE_LAYERS)).toBe(256);
      gl.bindTexture(GL2.TEXTURE_3D, array);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('is a WebGL 2 target only', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      expect(() => gl.bindTexture(GL2.TEXTURE_2D_ARRAY, gl.createTexture())).toThrow(WebGLUnsupportedError);
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, null);
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });

    it('records layers from texImage3D and texSubImage3D as an array texture', () => {
      const { gl } = arrayContext();
      const array = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, array);
      gl.texImage3D(GL2.TEXTURE_2D_ARRAY, 0, GL2.RGBA8, 2, 1, 3, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(24).fill(1));
      gl.texSubImage3D(GL2.TEXTURE_2D_ARRAY, 0, 1, 0, 2, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([9, 9, 9, 9]));
      gl.texParameteri(GL2.TEXTURE_2D_ARRAY, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const { content, draw } = drawn(gl);
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture).toMatchObject({ width: 2, height: 1, depth: 3, array: true });
      expect(draw.units['0']!.wrapR).toBeUndefined();
      const pixels = Buffer.from(texture.pixels!, 'base64');
      expect(Array.from(pixels.subarray(20, 24))).toEqual([9, 9, 9, 9]);
      expect(Array.from(pixels.subarray(16, 20))).toEqual([1, 1, 1, 1]);
    });

    it('is zeros after texStorage3D, in 8-bit and float formats, and refuses more than one level', () => {
      const { gl } = arrayContext();
      const array = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, array);
      gl.texStorage3D(GL2.TEXTURE_2D_ARRAY, 1, GL2.RGBA32F, 2, 2, 4);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.texSubImage3D(GL2.TEXTURE_2D_ARRAY, 0, 0, 0, 3, 2, 2, 1, GL.RGBA, GL.FLOAT, new Float32Array(16).fill(0.5));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const { content, draw } = drawn(gl);
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture).toMatchObject({ width: 2, height: 2, depth: 4, array: true, float32: true });
      const bytes = Buffer.from(texture.floats!, 'base64');
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      expect(floats).toHaveLength(64);
      expect(floats[47]).toBe(0);
      expect(floats[48]).toBe(0.5);
      const other = gl.createTexture();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, other);
      expect(() => gl.texStorage3D(GL2.TEXTURE_2D_ARRAY, 3, GL2.RGBA8, 4, 4, 2)).toThrow(/^unsupported:.*more than one level/);
    });

    it('checks its sizes and targets as WebGL does', () => {
      const { gl } = arrayContext();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, gl.createTexture());
      gl.texImage3D(GL2.TEXTURE_2D_ARRAY, 0, GL2.RGBA8, 1, 1, 257, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.texStorage3D(GL2.TEXTURE_2D_ARRAY, 1, GL2.RGBA8, 1, 1, 0);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.texStorage3D(GL.TEXTURE_2D, 1, GL2.RGBA8, 1, 1, 1);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      gl.texSubImage3D(GL2.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.generateMipmap(GL2.TEXTURE_2D_ARRAY);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('refuses mipmaps for an array texture it holds', () => {
      const { gl } = arrayContext();
      gl.bindTexture(GL2.TEXTURE_2D_ARRAY, gl.createTexture());
      gl.texStorage3D(GL2.TEXTURE_2D_ARRAY, 1, GL2.RGBA8, 4, 4, 2);
      expect(() => gl.generateMipmap(GL2.TEXTURE_2D_ARRAY)).toThrow(/^unsupported:.*array texture/);
    });

    it('refuses a draw that reads one unit as two sampler types', () => {
      const { gl } = arrayContext();
      const fragment = gl.createShader(GL.FRAGMENT_SHADER)!;
      gl.shaderSource(fragment, '#version 300 es\nprecision highp float; precision highp sampler3D; precision highp sampler2DArray; in vec2 v; uniform sampler2DArray layers; uniform sampler3D volume; out vec4 o; void main() { o = texture(layers, vec3(v, 0.0)) + texture(volume, vec3(v, 0.0)); }');
      const program = gl.createProgram();
      const vertex = gl.createShader(GL.VERTEX_SHADER)!;
      gl.shaderSource(vertex, VERTEX_ES3);
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'layers'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'volume'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });
  });

  describe('array uniforms whose length is a macro', () => {
    function linked(vertex: string) {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }']] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      return { gl, program };
    }
    const BODY = 'void main() { gl_Position = vec4(p, morphTargetInfluences[0], 1.0); }';

    it('reads the length from a #define, as three.js writes morphTargetInfluences', () => {
      const { gl, program } = linked(`#version 300 es\nin vec2 p;\n#define MORPHTARGETS_COUNT 4\n#ifdef USE_MORPHTARGETS\n#endif\nuniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];\n${BODY}`);
      const info = gl.getActiveUniform(program, 0)!;
      expect(info.name).toBe('morphTargetInfluences[0]');
      expect(info.size).toBe(4);
      const at = gl.getUniformLocation(program, 'morphTargetInfluences[3]');
      expect(at).not.toBeNull();
      expect(gl.getUniformLocation(program, 'morphTargetInfluences[4]')).toBeNull();
      gl.uniform1fv(gl.getUniformLocation(program, 'morphTargetInfluences')!, [1, 2, 3, 4]);
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });

    it('follows a macro defined as another macro or in parentheses', () => {
      const { gl, program } = linked(`#version 300 es\nin vec2 p;\n#define A (2)\n#define B A\nuniform float morphTargetInfluences[B];\n${BODY}`);
      expect(gl.getActiveUniform(program, 0)!.size).toBe(2);
    });

    it('leaves out a length with no single value, for the renderer to refuse', () => {
      for (const defines of ['#define N 2\n#define N 3\n', '#define N 2\n#undef N\n', '']) {
        const { gl, program } = linked(`#version 300 es\nin vec2 p;\n${defines}uniform float morphTargetInfluences[N];\n${BODY}`);
        expect(gl.getActiveUniform(program, 0)).toBeNull();
      }
    });
  });

  describe('constant attributes', () => {
    const VERTEX_COLOR = 'attribute vec2 p; attribute vec3 color; varying vec3 c; void main() { c = color; gl_Position = vec4(p, 0.0, 1.0); }';
    const FRAGMENT_COLOR = 'precision mediump float; varying vec3 c; void main() { gl_FragColor = vec4(c, 1.0); }';

    function colorContext() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX_COLOR], [GL.FRAGMENT_SHADER, FRAGMENT_COLOR]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
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
      return { gl, color: gl.getAttribLocation(program, 'color') };
    }

    function color(gl: WebGLContext, index = 0) {
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const op = gl.content().ops[index]!;
      if (op.op !== 'draw') throw new Error('not a draw');
      return op.attributes.color;
    }

    it('records a disabled array as the current value, default 0, 0, 0, 1', () => {
      const { gl } = colorContext();
      expect(color(gl)).toEqual({ buffer: 'constant:0,0,0,1', size: 4, type: 'f32', constant: [0, 0, 0, 1] });
    });

    it('takes vertexAttrib1f to 4f and 1fv to 4fv, with the missing components 0, 0, 1', () => {
      const { gl, color: at } = colorContext();
      gl.vertexAttrib1f(at, 0.5);
      expect(color(gl)?.constant).toEqual([0.5, 0, 0, 1]);
      gl.vertexAttrib2fv(at, [0.25, 0.75]);
      expect(color(gl, 1)?.constant).toEqual([0.25, 0.75, 0, 1]);
      gl.vertexAttrib3fv(at, new Float32Array([1, 2, 3]));
      expect(color(gl, 2)?.constant).toEqual([1, 2, 3, 1]);
      gl.vertexAttrib4fv(at, [4, 5, 6, 7]);
      expect(color(gl, 3)?.constant).toEqual([4, 5, 6, 7]);
      gl.vertexAttrib3f(at, 0.1, 0.2, 0.3);
      expect(color(gl, 4)?.constant?.map((v) => Math.round(v * 10))).toEqual([1, 2, 3, 10]);
    });

    it('is context state, kept across vertex array objects', () => {
      const { gl, color: at } = colorContext();
      const other = gl.createVertexArray();
      gl.bindVertexArray(other);
      gl.vertexAttrib3f(at, 1, 2, 3);
      gl.bindVertexArray(null);
      expect(color(gl)?.constant).toEqual([1, 2, 3, 1]);
    });

    it('stops reading the value once the array is enabled with a buffer', () => {
      const { gl, color: at } = colorContext();
      gl.vertexAttrib3fv(at, [1, 0, 0]);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array(9), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 3, GL.FLOAT, false, 0, 0);
      expect(color(gl)?.constant).toBeUndefined();
    });

    it('checks the index and the length as WebGL does, and refuses the integer forms', () => {
      const { gl } = colorContext();
      gl.vertexAttrib4f(16, 0, 0, 0, 0);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.vertexAttrib3fv(0, [1, 2]);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      expect(() => gl.vertexAttribI4i()).toThrow(/^unsupported:.*integer attributes/);
    });
  });

  describe('matrix attributes', () => {
    const VERTEX_MATRIX = '#version 300 es\nin vec2 p; in mat4 instanceMatrix; in vec3 tail; out vec3 t; void main() { t = tail; gl_Position = instanceMatrix * vec4(p, 0.0, 1.0); }';
    const FRAGMENT_PLAIN = '#version 300 es\nprecision highp float; in vec3 t; out vec4 o; void main() { o = vec4(t, 1.0); }';

    it('takes four consecutive locations and records a column at a time, instanced', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX_MATRIX], [GL.FRAGMENT_SHADER, FRAGMENT_PLAIN]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const at = gl.getAttribLocation(program, 'instanceMatrix');
      const locations = [gl.getAttribLocation(program, 'p'), at, gl.getAttribLocation(program, 'tail')];
      expect(new Set([...locations, at + 1, at + 2, at + 3]).size).toBe(6);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array(32), GL.STATIC_DRAW);
      for (let column = 0; column < 4; column += 1) {
        gl.enableVertexAttribArray(at + column);
        gl.vertexAttribPointer(at + column, 4, GL.FLOAT, false, 64, column * 16);
        gl.vertexAttribDivisor(at + column, 1);
      }
      gl.vertexAttrib3f(gl.getAttribLocation(program, 'tail'), 1, 2, 3);
      gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 2);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const draw = gl.content().ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(Object.keys(draw.attributes).sort()).toEqual(['instanceMatrix[0]', 'instanceMatrix[1]', 'instanceMatrix[2]', 'instanceMatrix[3]', 'p', 'tail']);
      expect(draw.attributes['instanceMatrix[2]']).toMatchObject({ size: 4, stride: 64, offset: 32, divisor: 1 });
      expect(draw.instances).toBe(2);
    });
  });

  describe('uniform type codes', () => {
    it('names the integer and shadow samplers and the other types, so three.js finds a setter', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      const vertex = gl.createShader(GL.VERTEX_SHADER)!;
      gl.shaderSource(vertex, '#version 300 es\nuniform highp usampler2D ids; uniform isampler2DArray signed; uniform sampler2DShadow shadow; uniform uvec3 u3; uniform mat3x4 m; void main() { gl_Position = vec4(0.0); }');
      const fragment = gl.createShader(GL.FRAGMENT_SHADER)!;
      gl.shaderSource(fragment, '#version 300 es\nvoid main() {}');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      const types = Object.fromEntries(Array.from({ length: 5 }, (_, i) => gl.getActiveUniform(program, i)!).map((u) => [u.name, u.type]));
      expect(types).toEqual({ ids: GL2.UNSIGNED_INT_SAMPLER_2D, signed: GL2.INT_SAMPLER_2D_ARRAY, shadow: GL2.SAMPLER_2D_SHADOW, u3: GL2.UNSIGNED_INT_VEC3, m: GL2.FLOAT_MAT3x4 });
    });
  });

  describe('float render targets', () => {
    function floatContext(internalformat: number, storage: boolean) {
      const g = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = g.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'], [GL.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(2.0); }']] as const) {
        const shader = g.createShader(type)!;
        g.shaderSource(shader, source);
        g.attachShader(program, shader);
      }
      g.linkProgram(program);
      g.useProgram(program);
      const buffer = g.createBuffer();
      g.bindBuffer(GL.ARRAY_BUFFER, buffer);
      g.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      g.enableVertexAttribArray(g.getAttribLocation(program, 'p'));
      g.vertexAttribPointer(g.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      const texture = g.createTexture();
      g.bindTexture(GL.TEXTURE_2D, texture);
      if (storage) g.texStorage2D(GL.TEXTURE_2D, 1, internalformat, 4, 4);
      else g.texImage2D(GL.TEXTURE_2D, 0, internalformat, 4, 4, 0, GL.RGBA, GL.HALF_FLOAT, null);
      const framebuffer = g.createFramebuffer();
      g.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      g.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      return { gl: g, texture };
    }

    it('is drawn into, by texStorage2D or texImage2D, and recorded with its format', () => {
      for (const storage of [true, false]) {
        const { gl } = floatContext(GL2.RGBA16F, storage);
        expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        expect(gl.getError()).toBe(GL.NO_ERROR);
        const content = gl.content();
        const draw = content.ops[0]!;
        if (draw.op !== 'draw') throw new Error('not a draw');
        expect(content.textures[draw.target!]).toMatchObject({ target: true, width: 4, height: 4, colorFormat: 'RGBA16F' });
      }
    });

    it('takes the one, two and four-channel formats of 16 and 32 bits', () => {
      for (const [format, name] of [[GL2.R16F, 'R16F'], [GL2.RG16F, 'RG16F'], [GL2.R32F, 'R32F'], [GL2.RG32F, 'RG32F'], [GL2.RGBA32F, 'RGBA32F']] as const) {
        const { gl } = floatContext(format, true);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        const content = gl.content();
        const draw = content.ops[0]!;
        if (draw.op !== 'draw') throw new Error('not a draw');
        expect(content.textures[draw.target!]!.colorFormat).toBe(name);
      }
    });

    it('offers EXT_color_buffer_float on WebGL 2 only', () => {
      expect(floatContext(GL2.RGBA16F, true).gl.getExtension('EXT_color_buffer_float')).not.toBeNull();
      expect(createWebGLContext({ size: () => ({ width: 8, height: 4 }) }).getExtension('EXT_color_buffer_float')).toBeNull();
    });

    it('refuses blending into a 32-bit target and RGB16F, and says what to use', () => {
      const { gl } = floatContext(GL2.RGBA32F, true);
      gl.enable(GL.BLEND);
      expect(() => gl.drawArrays(GL.TRIANGLES, 0, 3)).toThrow(/^unsupported:.*32-bit float render target/);
      const rgb = floatContext(GL2.RGB16F, true).gl;
      expect(() => rgb.drawArrays(GL.TRIANGLES, 0, 3)).toThrow(/^unsupported:.*allocate it as RGBA, or as R16F/);
    });

    it('keeps blending into a 16-bit one', () => {
      const { gl } = floatContext(GL2.RGBA16F, true);
      gl.enable(GL.BLEND);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });
  });

  describe('a clear with the scissor test on', () => {
    function drawOf(gl: WebGLContext, index = 0) {
      const op = gl.content().ops[index]!;
      if (op.op !== 'draw') throw new Error('not a draw');
      return op;
    }

    it('clears the box alone: a quad over it that writes the clear colour', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      gl.enable(GL.SCISSOR_TEST);
      gl.scissor(2, 1, 3, 2);
      gl.clearColor(1, 0.5, 0, 1);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      expect(content.ops).toHaveLength(1);
      const draw = drawOf(gl);
      expect(draw.viewport).toEqual([2, 1, 3, 2]);
      expect(draw.scissor).toEqual([2, 1, 3, 2]);
      expect(draw.uniforms.u_color).toEqual([{ kind: 'f', value: [1, 0.5, 0, 1] }]);
      expect(draw.colorMask).toEqual([true, true, true, true]);
      expect(draw.depth).toBeUndefined();
      expect(draw.stencil).toBeUndefined();
      expect(content.programs[draw.program]!.fragment).toContain('o0 = u_color');
    });

    it('keeps what was drawn before it, where a plain clear would drop it', () => {
      const { gl } = setup();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.enable(GL.SCISSOR_TEST);
      gl.scissor(0, 0, 2, 2);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.content().ops.map((o) => o.op)).toEqual(['draw', 'draw']);
      gl.disable(GL.SCISSOR_TEST);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.content().ops.map((o) => o.op)).toEqual(['clear']);
    });

    it('clips the box to the buffer, and an empty box clears nothing', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      gl.enable(GL.SCISSOR_TEST);
      gl.scissor(-2, 3, 20, 20);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(drawOf(gl).viewport).toEqual([0, 3, 8, 1]);
      gl.scissor(9, 0, 4, 4);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(gl.content().ops).toHaveLength(1);
    });

    it('starts from the whole drawing buffer when scissor() was never called, whatever the viewport', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      gl.viewport(0, 0, 2, 2);
      gl.enable(GL.SCISSOR_TEST);
      expect(Array.from(gl.getParameter(GL.SCISSOR_BOX) as Int32Array)).toEqual([0, 0, 8, 4]);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(drawOf(gl).scissor).toEqual([0, 0, 8, 4]);
    });

    it('writes the depth through an ALWAYS test and the stencil by REPLACE', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), attributes: { stencil: true } });
      gl.enable(GL.SCISSOR_TEST);
      gl.scissor(1, 1, 2, 2);
      gl.clearDepth(0.25);
      gl.clearStencil(7);
      gl.clear(GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
      const draw = drawOf(gl);
      expect(draw.colorMask).toEqual([false, false, false, false]);
      expect(draw.depth).toEqual({ func: 'ALWAYS', mask: true, near: 0, far: 1 });
      expect(draw.uniforms.u_depth).toEqual([{ kind: 'f', value: [-0.5] }]);
      expect(draw.stencil).toMatchObject({ ref: 7, writeMask: 255, front: { func: 'ALWAYS', zpass: 'REPLACE' } });
    });

    it('clears a framebuffer texture of its own size, and a single draw buffer of a WebGL 2 context', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      const textures = [gl.createTexture(), gl.createTexture()];
      textures.forEach((t, i) => {
        gl.bindTexture(GL.TEXTURE_2D, t);
        gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + i, GL.TEXTURE_2D, t, 0);
      });
      gl.drawBuffers([GL.COLOR_ATTACHMENT0, GL.COLOR_ATTACHMENT0 + 1]);
      gl.enable(GL.SCISSOR_TEST);
      gl.scissor(0, 0, 6, 2);
      gl.clearBufferfv(GL2.COLOR, 1, [0, 1, 0, 1]);
      const one = drawOf(gl);
      expect(one.viewport).toEqual([0, 0, 4, 2]);
      expect(one.outputs?.[0]).toBeNull();
      expect(one.outputs?.[1]).not.toBeNull();
      expect(gl.content().programs[one.program]!.fragment).toContain('layout(location = 1) out vec4 o1;');
      gl.clear(GL.COLOR_BUFFER_BIT);
      const both = drawOf(gl, 1);
      expect(both.outputs).toHaveLength(2);
      expect(gl.content().programs[both.program]!.fragment).toContain('o0 = u_color; o1 = u_color;');
    });

    it('still refuses a clear through a colour mask', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      gl.enable(GL.SCISSOR_TEST);
      gl.colorMask(true, false, true, true);
      expect(() => gl.clear(GL.COLOR_BUFFER_BIT)).toThrow(/^unsupported:.*colour mask/);
    });
  });
});
