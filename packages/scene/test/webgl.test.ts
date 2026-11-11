import { describe, expect, it } from 'vitest';
import { MAX_OPS_PER_TARGET } from '../src/webgl-carry.js';
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
    gl.vertexAttribDivisor(at, 3);
    gl.drawArraysInstanced(GL.TRIANGLES, 0, 3, 2);
    const ops = gl.content().ops as { instances?: number; attributes: Record<string, { divisor?: number }> }[];
    expect(ops).toHaveLength(2);
    expect(ops[0]!.instances).toBe(5);
    expect(Object.values(ops[0]!.attributes)[0]!.divisor).toBe(1);
    expect(Object.values(ops[1]!.attributes)[0]!.divisor).toBe(3);
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

  it('ignores a uniform call whose location is null or undefined, as WebGL does', () => {
    const { gl, program } = setup();
    const lacking = gl.getUniformLocation(program, 'nope');
    expect(lacking).toBeNull();
    for (const location of [lacking, undefined]) {
      gl.uniform1f(location, 1);
      gl.uniform4fv(location, [1, 2, 3, 4]);
      gl.uniformMatrix4fv(location, false, new Float32Array(16));
      gl.uniform1i(location, 0);
    }
    expect(gl.getError()).toBe(GL.NO_ERROR);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const draw = gl.content().ops.find((o) => o.op === 'draw');
    expect(draw !== undefined && 'uniforms' in draw && Object.keys(draw.uniforms)).toEqual([]);
  });

  it('answers the limits a page reads at start-up with values the replay has', () => {
    const gl2 = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    const { gl } = setup();
    for (const g of [gl, gl2]) {
      expect(g.getParameter(GL.MAX_RENDERBUFFER_SIZE)).toBe(8192);
      expect(g.getParameter(GL.MAX_TEXTURE_SIZE)).toBe(8192);
      expect(g.getParameter(GL.SUBPIXEL_BITS)).toBe(4);
    }
    expect(gl2.getParameter(GL2.MAX_ELEMENT_INDEX)).toBe(0xffffffff);
    expect(gl2.getParameter(GL2.MAX_VARYING_COMPONENTS)).toBe(60);
    expect(gl2.getParameter(GL2.MAX_FRAGMENT_UNIFORM_COMPONENTS)).toBe(1024);
    expect([gl2.getParameter(GL2.MIN_PROGRAM_TEXEL_OFFSET), gl2.getParameter(GL2.MAX_PROGRAM_TEXEL_OFFSET)]).toEqual([-8, 7]);
    expect(gl2.getError()).toBe(GL.NO_ERROR);
    // A WebGL 1 context has no such names.
    expect(gl.getParameter(GL2.MAX_ELEMENT_INDEX)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_ENUM);
  });

  it('reads the declarations after a prelude that tests GL_ES and defined()', () => {
    const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
    const program = gl.createProgram();
    const prelude = '#ifdef GL_ES\nprecision mediump float;\n#else\n#if !defined(lowp)\n#define lowp\n#endif\nuniform float desktop_only;\n#endif\n#ifdef GL_FRAGMENT_PRECISION_HIGH\nuniform float high;\n#endif\n';
    for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, `${prelude}uniform float t; void main() { gl_FragColor = vec4(t); }`]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    expect(Array.from({ length: gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS) as number }, (_, i) => gl.getActiveUniform(program, i)!.name)).toEqual(['high', 't']);
  });

  describe('integer vertex data', () => {
    const attributes = (gl: WebGLContext) => {
      const draw = gl.content().ops.find((o) => o.op === 'draw');
      return draw !== undefined && 'attributes' in draw ? draw.attributes : {};
    };
    const page = () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, '#version 300 es\nin vec2 p; in uvec4 joints; void main() { gl_Position = vec4(p, float(joints.x & 255u), 1.0); }'], [GL.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; out vec4 o; void main() { o = vec4(1); }']] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.bindAttribLocation(program, 0, 'p');
      gl.bindAttribLocation(program, 1, 'joints');
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Int16Array([0, 0, 1, 0, 0, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      return { gl, buffer };
    };

    it('records a non-normalised short array for a float attribute as it is, with the type for the renderer to convert', () => {
      const { gl } = page();
      gl.vertexAttribPointer(0, 2, GL.SHORT, false, 0, 0);
      gl.vertexAttribIPointer(1, 4, GL.UNSIGNED_SHORT, 0, 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(attributes(gl).p).toMatchObject({ size: 2, type: 'i16', normalized: false });
      expect(attributes(gl).p).not.toHaveProperty('integer');
    });

    it('records vertexAttribIPointer as an integer attribute of any integer type, and refuses what it must', () => {
      const { gl } = page();
      for (const [type, name] of [[GL.BYTE, 'i8'], [GL.UNSIGNED_BYTE, 'u8'], [GL.SHORT, 'i16'], [GL.UNSIGNED_SHORT, 'u16'], [GL.INT, 'i32'], [GL.UNSIGNED_INT, 'u32']] as const) {
        gl.vertexAttribIPointer(1, 3, type, 12, 4);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        expect(attributes(gl).joints).toMatchObject({ integer: true, size: 3, type: name, stride: 12, offset: 4, normalized: false });
        gl.resetState();
      }
      gl.vertexAttribIPointer(1, 3, GL.FLOAT, 0, 0);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      gl.vertexAttribIPointer(1, 5, GL.SHORT, 0, 0);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.bindBuffer(GL.ARRAY_BUFFER, null);
      gl.vertexAttribIPointer(1, 2, GL.SHORT, 0, 0);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('a later vertexAttribPointer makes the attribute a float one again', () => {
      const { gl } = page();
      gl.vertexAttribIPointer(1, 4, GL.UNSIGNED_SHORT, 0, 0);
      gl.vertexAttribPointer(1, 4, GL.UNSIGNED_SHORT, true, 0, 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(attributes(gl).joints).toMatchObject({ type: 'u16', normalized: true });
      expect(attributes(gl).joints).not.toHaveProperty('integer');
    });
  });

  it('stores empty levels of the faces of a cube map for a framebuffer to draw in, and refuses pixels there', () => {
    const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    const cube = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
    for (let face = 0; face < 6; face += 1) {
      for (let level = 0; level < 3; level += 1) gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, level, GL.RGBA, 4 >> level, 4 >> level, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    }
    expect(gl.getError()).toBe(GL.NO_ERROR);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_NEGATIVE_Y, cube, 1);
    expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
    expect(() => gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(16))).toThrow(/levels above 0 with pixels/);
    // A level of the wrong size is refused as for a 2D texture.
    expect(() => gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, GL.RGBA, 3, 3, 0, GL.RGBA, GL.UNSIGNED_BYTE, null)).toThrow(/level 1 of 3 x 3/);
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
    const gl2 = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
    gl2.bindRenderbuffer(GL.RENDERBUFFER, gl2.createRenderbuffer());
    expect(refused(() => gl2.renderbufferStorageMultisample(GL.RENDERBUFFER, 4, GL2.RGBA32F, 4, 4))).toMatch(/^unsupported:.*multisampled/);
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

    it('starts each frame with its textures as its own draws leave them, over the whole of each', () => {
      const { gl, program } = setup();
      attach(gl, 4, 2);
      const quad = () => {
        gl.bindBuffer(GL.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW);
        gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
        gl.drawArrays(GL.TRIANGLE_STRIP, 0, 4);
      };
      quad();
      gl.resetState();
      quad();
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

    it('says a draw WebGL refused, as it is not drawn', () => {
      const said: string[] = [];
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), report: (what) => said.push(what) });
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('INVALID_OPERATION');
      expect(gl.content().ops).toHaveLength(0);
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

      // Once drawn in, a texture's mipmaps are made from what was drawn (a 1 x 1 one has none to make).
      specify(GL.RGBA, null);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.generateMipmap(GL.TEXTURE_2D);
      expect(gl.getError()).toBe(GL.NO_ERROR);
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

    it('records TEXTURE_BASE_LEVEL with the sampler that reads the texture', () => {
      const { gl, program } = setup2();
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(GL.FRAMEBUFFER, gl.createFramebuffer());
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_BASE_LEVEL, 2);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect((gl.content().ops.at(-1) as { units: Record<string, object> }).units['0']).toMatchObject({ baseLevel: 2 });
    });

    it('truncates the level count of a texStorage2D to an integer, as a GLsizei is (three passes log2(size) + 1)', () => {
      const { gl, program } = setup2();
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texStorage2D(GL.TEXTURE_2D, Math.log2(683) + 1, GL2.RGBA8, 512, 683);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 512, 683, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(512 * 683 * 4));
      gl.generateMipmap(GL.TEXTURE_2D);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      expect((gl.content().ops.at(-1) as { units: Record<string, object> }).units['0']).toMatchObject({ maxLevel: 9 });
    });

    it('clamps the base and max level of a texStorage2D texture to its levels, so a short chain is complete', () => {
      const { gl, program } = setup2();
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texStorage2D(GL.TEXTURE_2D, 3, GL2.RGBA8, 32, 32);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_NEAREST);
      gl.bindFramebuffer(GL.FRAMEBUFFER, gl.createFramebuffer());
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_BASE_LEVEL, 5);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect((gl.content().ops.at(-1) as { units: Record<string, object> }).units['0']).toMatchObject({ baseLevel: 2, maxLevel: 2 });
    });

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

    it('flips and premultiplies the rows of a texSubImage2D of floats, as the unpack state says', () => {
      const { gl } = floatContext();
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.RGBA32F, 1, 3, 0, GL.RGBA, GL.FLOAT, new Float32Array(12));
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, 1);
      gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      // Two rows at y = 1: the source's last row lands first, and the colour is scaled by its alpha.
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 1, 1, 2, GL.RGBA, GL.FLOAT, new Float32Array([1, 1, 1, 0.5, 4, 4, 4, 1]));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const content = gl.content();
      const draw = content.ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = content.textures[draw.units['0']!.texture]!;
      expect([...new Float32Array(new Uint8Array(Buffer.from(texture.floats!, 'base64')).buffer)]).toEqual([0, 0, 0, 0, 4, 4, 4, 1, 0.5, 0.5, 0.5, 0.5]);
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
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL2.RED, GL.FLOAT, new Float32Array(1));
      expect(gl.getError()).toBe(GL.NO_ERROR);
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
      expect(() => gl.texSubImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 1, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
    });
  });

  describe('copyTexImage2D and copyTexSubImage2D', () => {
    it('record a NEAREST blit of the read buffer into the texture, which becomes a render target', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.copyTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 2, 4, 2, 0);
      gl.copyTexSubImage2D(GL.TEXTURE_2D, 0, 2, 1, 0, 0, 2, 1);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const [first, second] = gl.content().ops;
      expect(first).toMatchObject({ op: 'blit', from: [1, 2, 5, 4], to: [0, 0, 4, 2] });
      expect(second).toMatchObject({ op: 'blit', from: [0, 0, 2, 1], to: [2, 1, 4, 2] });
      expect(first).not.toHaveProperty('src');
      const id = (first as { target: string }).target;
      expect(gl.content().textures[id]).toEqual({ target: true, width: 4, height: 2 });
      gl.copyTexSubImage2D(GL.TEXTURE_2D, 0, 3, 0, 0, 0, 2, 1);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
    });

    it('refuse a texture that holds uploaded pixels, and read a framebuffer\'s read buffer', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const uploaded = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, uploaded);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
      expect(() => gl.copyTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 0, 0, 1, 1)).toThrow(WebGLUnsupportedError);
      const drawn = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, drawn);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, drawn, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      const into = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, into);
      gl.copyTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 0, 0, 2, 2, 0);
      const [clear, blit] = gl.content().ops;
      if (clear?.op !== 'clear') throw new Error('not a clear');
      expect(blit).toMatchObject({ op: 'blit', src: clear.target });
    });
  });

  describe('multisampled renderbuffers', () => {
    function msaa() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const color = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(GL.RENDERBUFFER, 2, GL2.RGBA8, 4, 4);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(GL.RENDERBUFFER, 4, GL2.DEPTH24_STENCIL8, 4, 4);
      const ms = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, ms);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, depth);
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      const resolve = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, resolve);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      return { gl, color, ms, resolve };
    }

    it('has MAX_SAMPLES samples, and records them on the target', () => {
      const { gl, color, ms } = msaa();
      expect(gl.getParameter(GL2.MAX_SAMPLES)).toBe(4);
      gl.bindRenderbuffer(GL.RENDERBUFFER, color);
      expect(gl.getRenderbufferParameter(GL.RENDERBUFFER, GL2.RENDERBUFFER_SAMPLES)).toBe(4);
      gl.bindFramebuffer(GL.FRAMEBUFFER, ms);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
      expect(gl.getParameter(GL.SAMPLES)).toBe(4);
      gl.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
      const clear = gl.content().ops[0]!;
      if (clear.op !== 'clear') throw new Error('not a clear');
      expect(gl.content().textures[clear.target!]).toEqual({ target: true, width: 4, height: 4, samples: 4 });
      expect(gl.content().textures[clear.depthStencil!]).toMatchObject({ format: 'depthStencil', samples: 4 });
    });

    it('resolves with a blit of the same rectangle, and refuses another rectangle or a multisampled destination', () => {
      const { gl, ms, resolve } = msaa();
      gl.bindFramebuffer(GL2.READ_FRAMEBUFFER, ms);
      gl.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, resolve);
      gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 2, 2, GL.COLOR_BUFFER_BIT, GL.NEAREST);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 4, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      expect(gl.content().ops).toHaveLength(1);
      gl.bindFramebuffer(GL2.READ_FRAMEBUFFER, resolve);
      gl.bindFramebuffer(GL2.DRAW_FRAMEBUFFER, ms);
      gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 4, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('is incomplete with attachments of different samples', () => {
      const { gl, ms } = msaa();
      const single = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, single);
      gl.renderbufferStorage(GL.RENDERBUFFER, GL2.DEPTH24_STENCIL8, 4, 4);
      gl.bindFramebuffer(GL.FRAMEBUFFER, ms);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, single);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL2.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE);
    });
  });

  describe('cube map render targets', () => {
    const FRAGMENT_CUBE = 'precision mediump float; varying vec2 v; uniform samplerCube env; void main() { gl_FragColor = textureCube(env, vec3(v, 1.0)); }';

    function setup() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
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
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      gl.texStorage2D(GL.TEXTURE_CUBE_MAP, 1, GL2.RGBA8, 4, 4);
      gl.texParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      return { gl, program, cube, fb };
    }

    it('draws into each face and samples the six targets as one cube map', () => {
      const { gl, program, cube } = setup();
      for (let f = 0; f < 6; f += 1) {
        gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, cube, 0);
        expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
        gl.clearColor(f / 5, 0, 0, 1);
        gl.clear(GL.COLOR_BUFFER_BIT);
      }
      expect(gl.getFramebufferAttachmentParameter(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)).toBe(cube);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      const clears = content.ops.filter((o) => o.op === 'clear').map((o) => (o as { target?: string }).target);
      const draw = content.ops.at(-1)!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = content.textures[draw.units['0']!.texture]!;
      expect(texture).toEqual({ cube: true, targets: clears });
      expect(new Set(clears).size).toBe(6);
      expect(content.textures[clears[0]!]).toEqual({ target: true, width: 4, height: 4 });
    });

    it('takes empty float faces from texImage2D as render targets', () => {
      const { gl, cube } = setup();
      const floats = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, floats);
      for (let f = 0; f < 6; f += 1) gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, GL2.RGBA16F, 2, 2, 0, GL.RGBA, GL.HALF_FLOAT, null);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_NEGATIVE_Z, floats, 0);
      expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
      gl.clear(GL.COLOR_BUFFER_BIT);
      const clear = gl.content().ops[0]!;
      if (clear.op !== 'clear') throw new Error('not a clear');
      expect(gl.content().textures[clear.target!]).toMatchObject({ target: true, colorFormat: 'RGBA16F' });
      expect(() => gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL2.RGBA16F, 2, 2, 0, GL.RGBA, GL.FLOAT, new Float32Array(16))).toThrow(WebGLUnsupportedError);
      void cube;
    });

    it('refuses a sampler that reads the cube map a face of which the draw writes, and a face target of a 2D texture', () => {
      const { gl, program, cube } = setup();
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_Y, cube, 0);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      const flat = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, flat);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_X, flat, 0);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, cube, 0);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('makes the mipmaps of drawn faces with a LINEAR blit from each level to the next', () => {
      const { gl, program } = setup();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      gl.texStorage2D(GL.TEXTURE_CUBE_MAP, 3, GL2.RGBA8, 4, 4);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_Z, cube, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.generateMipmap(GL.TEXTURE_CUBE_MAP);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const content = gl.content();
      const blits = content.ops.filter((o) => o.op === 'blit');
      expect(blits).toHaveLength(12);
      const draw = content.ops.at(-1)!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const faces = content.textures[draw.units['0']!.texture]!.targets!;
      expect(blits.slice(8, 10)).toEqual([
        { op: 'blit', src: faces[4], target: faces[4], level: 1, from: [0, 0, 4, 4], to: [0, 0, 2, 2], linear: true },
        { op: 'blit', src: faces[4], srcLevel: 1, target: faces[4], level: 2, from: [0, 0, 2, 2], to: [0, 0, 1, 1], linear: true },
      ]);
      for (const f of faces) expect(content.textures[f]).toEqual({ target: true, width: 4, height: 4, levels: 3 });
    });

    it('records TEXTURE_BASE_LEVEL on the sampler, and makes mipmaps from it', () => {
      const { gl, program } = setup();
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.texStorage2D(GL.TEXTURE_2D, 3, GL2.RGBA8, 4, 4);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 1);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_BASE_LEVEL, 1);
      gl.generateMipmap(GL.TEXTURE_2D);
      const blits = gl.content().ops.filter((o) => o.op === 'blit');
      expect(blits).toEqual([expect.objectContaining({ srcLevel: 1, level: 2 })]);
      void program;
    });

    it('gives a drawn 2D texture all its levels at generateMipmap, and refuses a 32-bit float one', () => {
      const { gl } = setup();
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.generateMipmap(GL.TEXTURE_2D);
      const content = gl.content();
      const blits = content.ops.filter((o) => o.op === 'blit');
      expect(blits.map((b) => (b as { to: number[] }).to)).toEqual([[0, 0, 4, 1], [0, 0, 2, 1], [0, 0, 1, 1]]);
      expect(content.textures[(blits[0] as { target: string }).target]).toMatchObject({ levels: 4 });
      const f = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, f);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.RGBA32F, 2, 2, 0, GL.RGBA, GL.FLOAT, null);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, f, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(() => gl.generateMipmap(GL.TEXTURE_2D)).toThrow(WebGLUnsupportedError);
    });

    it('takes whole faces from texSubImage2D into texStorage2D, as three.js uploads a cube map', () => {
      const { gl, program } = setup();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      gl.texStorage2D(GL.TEXTURE_CUBE_MAP, 2, GL2.SRGB8_ALPHA8, 2, 2);
      for (let f = 0; f < 6; f += 1) gl.texSubImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(16).fill(f + 1));
      gl.generateMipmap(GL.TEXTURE_CUBE_MAP);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const draw = gl.content().ops.at(-1)!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      const texture = gl.content().textures[draw.units['0']!.texture]!;
      expect(texture).toMatchObject({ cube: true, width: 2, srgb: true, mipmaps: true });
      expect(Buffer.from(texture.faces![5]!.pixels!, 'base64')[0]).toBe(6);
      expect(() => gl.texSubImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, 1, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
    });

    it('refuses a cube map of uploaded and drawn faces', () => {
      const { gl, program } = setup();
      const mixed = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, mixed);
      for (let f = 0; f < 6; f += 1) gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, f === 0 ? null : new Uint8Array([9, 9, 9, 255]));
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_X, mixed, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.uniform1i(gl.getUniformLocation(program, 'env'), 0);
      expect(() => gl.drawArrays(GL.TRIANGLES, 0, 3)).toThrow(WebGLUnsupportedError);
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

    it('lists an array of one element as name[0], as a browser does, so a library sets it as an array', () => {
      const { gl, program } = linked('#version 300 es\nin vec2 p;\nuniform sampler2D maps[1];\nuniform float single;\nvoid main() { gl_Position = vec4(p, single, 1.0); }');
      expect([0, 1].map((i) => gl.getActiveUniform(program, i)!.name)).toEqual(['maps[0]', 'single']);
      expect(gl.getUniformLocation(program, 'maps[0]')).not.toBeNull();
    });

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

    it('leaves out a length that is not defined where it is read, for the renderer to refuse', () => {
      for (const defines of ['#ifdef FAST\n#define N 2\n#endif\n', '#define N 2\n#undef N\n', '']) {
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
      expect(() => gl.vertexAttribI4i()).toThrow(/^unsupported:.*current value of an integer attribute/);
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

    it('takes texSubImage2D of floats into a float texture, as three.js fills a data texture', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texStorage2D(GL.TEXTURE_2D, 1, GL2.RGBA32F, 2, 2);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 1, 1, GL.RGBA, GL.FLOAT, new Float32Array([5, 6, 7, 8]));
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 2, 1, GL.RGBA, GL.FLOAT, new Float32Array(8));
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('blends into a 32-bit target once EXT_float_blend is enabled, as a browser does, and refuses RGB16F', () => {
      const { gl } = floatContext(GL2.RGBA32F, true);
      expect(gl.getSupportedExtensions()).toEqual(expect.arrayContaining(['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend']));
      gl.enable(GL.BLEND);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.INVALID_OPERATION);
      expect(gl.getExtension('EXT_float_blend')).not.toBeNull();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      expect(gl.content().ops.at(-1)).toMatchObject({ op: 'draw', blend: { srcRgb: 'ONE' } });
      const rgb = floatContext(GL2.RGB16F, true).gl;
      expect(() => rgb.drawArrays(GL.TRIANGLES, 0, 3)).toThrow(/^unsupported:.*allocate it as RGBA, SRGB8_ALPHA8, R8, RG8, or as R16F/);
    });

    it('keeps blending into a 16-bit one', () => {
      const { gl } = floatContext(GL2.RGBA16F, true);
      gl.enable(GL.BLEND);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });
  });

  describe('struct uniforms', () => {
    const FRAGMENT_LIGHTS = '#version 300 es\nprecision highp float;\nstruct DirectionalLight {\n vec3 direction;\n vec3 color;\n};\nstruct Shadow { float bias; vec2 size[2]; };\nuniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];\nuniform Shadow shadow;\nuniform float opacity;\nout vec4 o;\nvoid main() { o = vec4(directionalLights[1].color, opacity + shadow.bias); }';

    function lights() {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'], [GL.FRAGMENT_SHADER, `#define NUM_DIR_LIGHTS 2\n${FRAGMENT_LIGHTS}`]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      return { gl, program };
    }

    it('lists each field of each element, as three.js reads them', () => {
      const { gl, program } = lights();
      const count = gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS) as number;
      const active = Array.from({ length: count }, (_, i) => gl.getActiveUniform(program, i)!);
      expect(active.map((u) => u.name)).toEqual([
        'directionalLights[0].direction',
        'directionalLights[0].color',
        'directionalLights[1].direction',
        'directionalLights[1].color',
        'shadow.bias',
        'shadow.size[0]',
        'opacity',
      ]);
      expect(active.find((u) => u.name === 'directionalLights[1].color')).toMatchObject({ size: 1, type: GL.FLOAT_VEC3 });
      expect(active.find((u) => u.name === 'shadow.size[0]')).toMatchObject({ size: 2, type: GL.FLOAT_VEC2 });
    });

    it('sets a field through its location and records it under that name', () => {
      const { gl, program } = lights();
      gl.uniform3fv(gl.getUniformLocation(program, 'directionalLights[1].color'), [0.1, 0.2, 0.3]);
      gl.uniform2fv(gl.getUniformLocation(program, 'shadow.size[1]'), [4, 5]);
      gl.uniform1f(gl.getUniformLocation(program, 'shadow.bias'), 0.5);
      expect(gl.getUniformLocation(program, 'directionalLights[2].color')).toBeNull();
      expect(gl.getUniformLocation(program, 'directionalLights[1].nope')).toBeNull();
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const draw = gl.content().ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(draw.uniforms['directionalLights[1].color']).toEqual([{ kind: 'f', value: [0.1, 0.2, 0.3] }]);
      expect(draw.uniforms['shadow.size']).toEqual([{ kind: 'f', value: [4, 5], index: 1 }]);
      expect(draw.uniforms['shadow.bias']).toBeDefined();
    });
  });

  describe('lines', () => {
    it('records LINES, LINE_STRIP and LINE_LOOP, and refuses neither', () => {
      for (const [mode, name] of [[GL.LINES, 'lines'], [GL.LINE_STRIP, 'lineStrip'], [GL.LINE_LOOP, 'lineLoop']] as const) {
        const { gl } = setup();
        gl.drawArrays(mode, 0, 3);
        expect(gl.getError()).toBe(GL.NO_ERROR);
        const draw = gl.content().ops[0]!;
        if (draw.op !== 'draw') throw new Error('not a draw');
        expect(draw.mode).toBe(name);
      }
    });

    it('takes lineWidth, which is one pixel wide whatever it says, and checks it', () => {
      const { gl } = setup();
      expect(Array.from(gl.getParameter(GL.ALIASED_LINE_WIDTH_RANGE) as Float32Array)).toEqual([1, 1]);
      gl.lineWidth(3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      gl.lineWidth(0);
      expect(gl.getError()).toBe(GL.INVALID_VALUE);
    });

    it('does not offset a line by polygonOffset', () => {
      const { gl } = setup();
      gl.enable(GL.DEPTH_TEST);
      gl.enable(GL.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.drawArrays(GL.LINES, 0, 2);
      const draw = gl.content().ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(draw.depth).toBeDefined();
      expect(draw.polygonOffset).toBeUndefined();
    });
  });

  describe('sRGB textures', () => {
    it('records an SRGB8_ALPHA8 upload as sRGB bytes, and an RGBA8 one as it was', () => {
      for (const [format, srgb] of [[GL2.SRGB8_ALPHA8, true], [GL2.RGBA8, false]] as const) {
        const { gl, program } = setup();
        const texture = gl.createTexture();
        gl.bindTexture(GL.TEXTURE_2D, texture);
        gl.texImage2D(GL.TEXTURE_2D, 0, format, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([188, 188, 188, 255]));
        gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        const content = gl.content();
        const draw = content.ops[0]!;
        if (draw.op !== 'draw') throw new Error('not a draw');
        expect(content.textures[draw.units['0']!.texture]!.srgb).toBe(srgb ? true : undefined);
      }
    });

    it('draws into SRGB8_ALPHA8 textures, cube faces and renderbuffers, and float renderbuffers', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, fb);
      const colorFormatOf = () => {
        const clear = gl.content().ops.at(-1)!;
        if (clear.op !== 'clear') throw new Error('not a clear');
        return gl.content().textures[clear.target!]!.colorFormat;
      };
      const t = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, t);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL2.SRGB8_ALPHA8, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(colorFormatOf()).toBe('SRGB8_ALPHA8');
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      gl.texStorage2D(GL.TEXTURE_CUBE_MAP, 1, GL2.SRGB8_ALPHA8, 2, 2);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_NEGATIVE_Y, cube, 0);
      gl.clear(GL.COLOR_BUFFER_BIT);
      expect(colorFormatOf()).toBe('SRGB8_ALPHA8');
      for (const [format, name] of [[GL2.SRGB8_ALPHA8, 'SRGB8_ALPHA8'], [GL2.RGBA16F, 'RGBA16F']] as const) {
        const rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(GL.RENDERBUFFER, rb);
        gl.renderbufferStorage(GL.RENDERBUFFER, format, 2, 2);
        gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, rb);
        expect(gl.checkFramebufferStatus(GL.FRAMEBUFFER)).toBe(GL.FRAMEBUFFER_COMPLETE);
        gl.clear(GL.COLOR_BUFFER_BIT);
        expect(colorFormatOf()).toBe(name);
      }
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });

    it('draws into R8 and RG8 textures, and refuses an upload over a drawn one', () => {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      gl.bindFramebuffer(GL.FRAMEBUFFER, gl.createFramebuffer());
      for (const [format, base, name] of [[GL2.R8, GL2.RED, 'R8'], [GL2.RG8, GL2.RG, 'RG8']] as const) {
        const t = gl.createTexture();
        gl.bindTexture(GL.TEXTURE_2D, t);
        gl.texImage2D(GL.TEXTURE_2D, 0, format, 2, 2, 0, base, GL.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, t, 0);
        gl.clear(GL.COLOR_BUFFER_BIT);
        const clear = gl.content().ops.at(-1)!;
        if (clear.op !== 'clear') throw new Error('not a clear');
        expect(gl.content().textures[clear.target!]!.colorFormat).toBe(name);
        expect(() => gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, base, GL.UNSIGNED_BYTE, new Uint8Array(4))).toThrow(WebGLUnsupportedError);
      }
    });

    it('records a cube map of sRGB faces as sRGB, and refuses a float face with pixels', () => {
      const { gl } = setup();
      const cube = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_CUBE_MAP, cube);
      expect(() => gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL2.RGBA16F, 1, 1, 0, GL.RGBA, GL.FLOAT, new Float32Array(4))).toThrow(/^unsupported:.*float pixels/);
      for (let f = 0; f < 6; f += 1) gl.texImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, GL2.SRGB8_ALPHA8, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
      expect(gl.getError()).toBe(GL.NO_ERROR);
    });
  });

  describe('declarations the conditionals leave out', () => {
    function link(vertex: string, version: 1 | 2 = 2) {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, version === 2 ? '#version 300 es\nvoid main() {}' : 'void main() {}']] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      return { gl, program };
    }

    it('are not attributes or uniforms, as three.js sees the program', () => {
      const { gl, program } = link(
        '#version 300 es\n#define attribute in\nattribute vec3 position;\nattribute vec2 uv;\n#ifdef USE_TANGENT\nattribute vec4 tangent;\n#endif\n#if defined( USE_COLOR_ALPHA )\nattribute vec4 color;\n#endif\n#if 0 > 0\nuniform float never;\n#endif\nuniform float kept;\nvoid main() { gl_Position = vec4(position, kept); }',
      );
      expect(gl.getProgramParameter(program, GL.ACTIVE_ATTRIBUTES)).toBe(2);
      expect(gl.getAttribLocation(program, 'tangent')).toBe(-1);
      expect(gl.getAttribLocation(program, 'color')).toBe(-1);
      expect(gl.getUniformLocation(program, 'never')).toBeNull();
      expect(gl.getUniformLocation(program, 'kept')).not.toBeNull();
    });

    it('leave the live branch, and a macro defined inside one, as they are', () => {
      const { gl, program } = link(
        '#version 300 es\nin vec2 p;\n#define FAST 1\n#ifdef FAST\n#define N 3\nuniform float w[N];\n#else\nuniform float v;\n#endif\nvoid main() { gl_Position = vec4(p, w[0], 1.0); }',
      );
      expect(gl.getActiveUniform(program, 0)).toMatchObject({ name: 'w[0]', size: 3 });
      expect(gl.getUniformLocation(program, 'v')).toBeNull();
    });
  });

  describe('shadow samplers', () => {
    const FRAGMENT_SHADOW = '#version 300 es\nprecision highp float; precision highp sampler2DShadow; in vec2 v; uniform sampler2DShadow maps[2]; out vec4 o; void main() { o = vec4(texture(maps[1], vec3(v, 0.5)) + texture(maps[0], vec3(v, 0.5))); }';
    const VERTEX_ES3 = '#version 300 es\nin vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';

    function shadowContext(compare: boolean, depthTexture = true) {
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX_ES3], [GL.FRAGMENT_SHADER, FRAGMENT_SHADOW]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      const textures = [gl.createTexture(), gl.createTexture()];
      textures.forEach((texture, i) => {
        gl.activeTexture(GL.TEXTURE0 + i);
        gl.bindTexture(GL.TEXTURE_2D, texture);
        if (depthTexture) gl.texImage2D(GL.TEXTURE_2D, 0, GL2.DEPTH_COMPONENT24, 4, 4, 0, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, null);
        else gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4));
        if (compare) {
          gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_COMPARE_MODE, GL2.COMPARE_REF_TO_TEXTURE);
          gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_COMPARE_FUNC, i === 0 ? GL.LEQUAL : GL.GREATER);
        }
      });
      gl.uniform1iv(gl.getUniformLocation(program, 'maps[0]'), [0, 1]);
      return { gl, program };
    }

    it('records the compare function of each depth texture, and the units of an array of samplers', () => {
      const { gl, program } = shadowContext(true);
      expect(gl.getActiveUniform(program, 0)).toMatchObject({ name: 'maps[0]', size: 2, type: GL2.SAMPLER_2D_SHADOW });
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.getError()).toBe(GL.NO_ERROR);
      const draw = gl.content().ops[0]!;
      if (draw.op !== 'draw') throw new Error('not a draw');
      expect(draw.uniforms.maps).toEqual([{ kind: 'i', value: [0, 1] }]);
      expect(draw.units['0']!.compare).toBe('LEQUAL');
      expect(draw.units['1']!.compare).toBe('GREATER');
    });

    it('refuses a shadow sampler on a texture that does not compare, or a colour texture', () => {
      const plain = shadowContext(false);
      plain.gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(plain.gl.getError()).toBe(GL.INVALID_OPERATION);
      const colour = shadowContext(true, false);
      colour.gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(colour.gl.getError()).toBe(GL.INVALID_OPERATION);
    });

    it('takes TEXTURE_COMPARE_MODE and FUNC on WebGL 2 only, and checks them', () => {
      const { gl } = shadowContext(true);
      gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_COMPARE_MODE, 7);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      gl.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_COMPARE_FUNC, GL.LINEAR);
      expect(gl.getError()).toBe(GL.INVALID_ENUM);
      const v1 = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
      v1.bindTexture(GL.TEXTURE_2D, v1.createTexture());
      v1.texParameteri(GL.TEXTURE_2D, GL2.TEXTURE_COMPARE_MODE, GL2.COMPARE_REF_TO_TEXTURE);
      expect(v1.getError()).toBe(GL.INVALID_ENUM);
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

  describe('render targets across frames', () => {
    /** A texture of this size allocated as a render target, with a framebuffer that has it attached and is bound. */
    function attach(gl: WebGLContext, width: number, height: number) {
      const texture = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.bindTexture(GL.TEXTURE_2D, null);
      gl.viewport(0, 0, width, height);
      return { texture, framebuffer };
    }
    /** Draws the canvas with the texture bound to unit 0. */
    function drawCanvasWith(gl: WebGLContext, program: ReturnType<WebGLContext['createProgram']>, texture: ReturnType<WebGLContext['createTexture']>) {
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.viewport(0, 0, 8, 4);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, null);
    }
    const kinds = (gl: WebGLContext) => gl.content().ops.map((o) => `${o.op}${o.op !== 'upload' && o.target !== undefined ? ':target' : ''}`);

    it('keeps what was drawn into a texture for the frames after it (an environment map drawn once, read in every frame)', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.clearColor(1, 0, 0, 1);
      gl.clear(GL.COLOR_BUFFER_BIT);
      // Over part of it: the clear still shows around it.
      gl.viewport(0, 0, 2, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['clear:target', 'draw:target', 'draw']);
      const content = gl.content();
      const id = (content.ops[0] as { target: string }).target;
      expect(content.textures[id]).toMatchObject({ target: true, width: 4, height: 2 });
      expect(Object.keys(content.programs)).toHaveLength(1);
      expect(Object.keys(content.buffers)).toHaveLength(1);
      // And the frame after that one: the same.
      gl.resetState();
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['clear:target', 'draw:target', 'draw']);
    });

    it('opens a frame with only the target ops it reads', () => {
      const { gl, program } = setup();
      const used = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      attach(gl, 2, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      drawCanvasWith(gl, program, used.texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
    });

    it('drops what a frame draws over a texture whole before anything reads it, so the ops do not pile up', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      for (let frame = 0; frame < 5; frame++) {
        gl.clear(GL.COLOR_BUFFER_BIT);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        drawCanvasWith(gl, program, texture);
        // Back to the framebuffer for the next frame.
        gl.resetState();
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, 4, 2);
      }
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      drawCanvasWith(gl, program, texture);
      // The frame's own clear and draw alone: none of the five before it.
      expect(kinds(gl)).toEqual(['clear:target', 'draw:target', 'draw']);
    });

    /** Draws a strip of four vertices over the clip square: every texel of a target the viewport holds. */
    function fullscreen(gl: WebGLContext, program: ReturnType<WebGLContext['createProgram']>) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(GL.ARRAY_BUFFER, buffer);
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW);
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      gl.drawArrays(GL.TRIANGLE_STRIP, 0, 4);
    }
    /** A frame that ends, with the framebuffer of `texture` bound again for the next. */
    function nextFrame(gl: WebGLContext, texture: ReturnType<WebGLContext['createTexture']>) {
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.resetState();
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, 4, 2);
    }

    it('drops the draws under a draw whose triangles cover the clip square, with nothing to blend, discard or cull it', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      for (let frame = 0; frame < 5; frame++) {
        fullscreen(gl, program);
        nextFrame(gl, texture);
      }
      fullscreen(gl, program);
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
      gl.resetState();
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
    });

    it('keeps the draws under one that may not cover the texture: a sprite, a discard, a cull', () => {
      const carriedAfter = (draw: (gl: WebGLContext, program: ReturnType<WebGLContext['createProgram']>) => void, shaded?: string, vertex = VERTEX) => {
        const { gl, program } = setup();
        const { texture } = attach(gl, 4, 2);
        let program2 = program;
        if (shaded !== undefined) {
          program2 = gl.createProgram();
          for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, shaded]] as const) {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            gl.attachShader(program2, shader);
          }
          gl.linkProgram(program2);
          gl.useProgram(program2);
        }
        for (let frame = 0; frame < 3; frame++) {
          draw(gl, program2);
          nextFrame(gl, texture);
        }
        draw(gl, program2);
        drawCanvasWith(gl, program2, texture);
        return kinds(gl).filter((k) => k === 'draw:target').length;
      };
      // Three vertices over half of the square.
      expect(carriedAfter((gl) => gl.drawArrays(GL.TRIANGLES, 0, 3))).toBe(4);
      // The whole square, but the fragment shader may discard.
      expect(carriedAfter(fullscreen, 'precision mediump float; varying vec2 v; uniform sampler2D tex; void main() { if (v.x > 0.5) discard; gl_FragColor = texture2D(tex, v); }')).toBe(4);
      // The whole square, but in front of the near plane, so clipped away.
      const FRAGMENT_OPEN = 'precision mediump float; varying vec2 v; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, v); }';
      expect(carriedAfter(fullscreen, FRAGMENT_OPEN, 'attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 3.0, 1.0); }')).toBe(4);
      // The whole square, wound clockwise and back faces culled.
      expect(
        carriedAfter((gl, program) => {
          gl.enable(GL.CULL_FACE);
          gl.cullFace(GL.FRONT);
          fullscreen(gl, program);
        }),
      ).toBe(4);
    });

    it('drops the draws under a texSubImage2D that covers the texture', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(4 * 2 * 4));
      gl.bindTexture(GL.TEXTURE_2D, null);
      nextFrame(gl, texture);
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['upload', 'draw']);
    });

    it('says a frame depends on the frames before it only when it makes a target from what the target held', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      fullscreen(gl, program);
      nextFrame(gl, texture);
      // The frame after the one that drew the target reads what that frame wrote.
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      drawCanvasWith(gl, program, texture);
      expect(gl.dependsOnHistory).toBe(true);
      // Only reading the target, as the frames after one that drew nothing do (an environment map drawn once).
      nextFrame(gl, texture);
      nextFrame(gl, texture);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      drawCanvasWith(gl, program, texture);
      expect(gl.dependsOnHistory).toBe(false);
      // Showing the target on the canvas, then covering it again: the canvas showed what the frame before left.
      gl.resetState();
      nextFrame(gl, texture);
      nextFrame(gl, texture);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      drawCanvasWith(gl, program, texture);
      gl.viewport(0, 0, 4, 2);
      const again = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, again);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      fullscreen(gl, program);
      expect(gl.dependsOnHistory).toBe(true);
      // Covering it, then reading it.
      gl.resetState();
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, 4, 2);
      fullscreen(gl, program);
      drawCanvasWith(gl, program, texture);
      expect(gl.dependsOnHistory).toBe(false);
      // A clear, then a sprite over it.
      nextFrame(gl, texture);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(GL.COLOR_BUFFER_BIT);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.dependsOnHistory).toBe(false);
      // A sprite over what the frame before left (a trail).
      nextFrame(gl, texture);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      expect(gl.dependsOnHistory).toBe(true);
      // Two passes that cover a target while reading the other, which the frame writes next (a ping-pong, feedback).
      nextFrame(gl, texture);
      const other = attach(gl, 4, 2);
      gl.viewport(0, 0, 4, 2);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      fullscreen(gl, program);
      gl.bindTexture(GL.TEXTURE_2D, null);
      const back = gl.createFramebuffer();
      gl.bindFramebuffer(GL.FRAMEBUFFER, back);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
      gl.bindTexture(GL.TEXTURE_2D, other.texture);
      fullscreen(gl, program);
      gl.bindTexture(GL.TEXTURE_2D, null);
      expect(gl.dependsOnHistory).toBe(true);
    });

    /** A draw of `positions` (x, y pairs) in `mode`, over the clip square or not. */
    function drawPositions(gl: WebGLContext, program: ReturnType<WebGLContext['createProgram']>, positions: number[], mode: number, count: number) {
      gl.bindBuffer(GL.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array(positions), GL.STATIC_DRAW);
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      gl.drawArrays(mode, 0, count);
    }
    /** How many draws into a target the canvas draw after three frames of `positions` still needs. */
    function neededAfter(positions: number[], mode: number, count: number): number {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      for (let frame = 0; frame < 3; frame++) {
        drawPositions(gl, program, positions, mode, count);
        nextFrame(gl, texture);
      }
      drawPositions(gl, program, positions, mode, count);
      drawCanvasWith(gl, program, texture);
      return kinds(gl).filter((k) => k === 'draw:target').length;
    }

    it('counts a draw as covering the clip square only when its triangles provably do', () => {
      // One triangle that holds the four corners (the fullscreen triangle), and two that make the square.
      expect(neededAfter([-1, -1, 3, -1, -1, 3], GL.TRIANGLES, 3)).toBe(1);
      expect(neededAfter([-1, -1, 1, -1, -1, 1, 1, 1], GL.TRIANGLE_STRIP, 4)).toBe(1);
      expect(neededAfter([-1, -1, 1, -1, 1, 1, -1, 1], GL.TRIANGLE_FAN, 4)).toBe(1);
      // Two triangles that hit the nine sample points of the square but leave a band of it bare.
      const bare = [-1, -1, 1, -1, -1, 1, 1.01, 1.01, 1.01, -0.1, -0.1, 1.01];
      expect(neededAfter(bare, GL.TRIANGLES, 6)).toBe(4);
      // Two triangles that share an edge but do not make a convex quad.
      expect(neededAfter([-1, -1, 1, -1, 0, 0, -1, -1, 1, -1, 0, -2], GL.TRIANGLES, 6)).toBe(4);
      // A triangle with no area holds nothing.
      expect(neededAfter([-1, -1, -1, -1, -1, -1], GL.TRIANGLES, 3)).toBe(4);
    });

    /** A 300-frame loop of a target drawn, given every level, and shown, as three.js does for glass; what each frame needs of the frames before it. */
    it('keeps a mipmapped render target from growing or being reported, however many frames draw it', () => {
      const said: string[] = [];
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), report: (what) => said.push(what) });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.bindBuffer(GL.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      const { texture, framebuffer } = attach(gl, 8, 4);
      const counts: number[] = [];
      for (let frame = 0; frame < 300; frame++) {
        gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, 8, 4);
        gl.clear(GL.COLOR_BUFFER_BIT);
        gl.drawArrays(GL.TRIANGLES, 0, 3);
        gl.bindTexture(GL.TEXTURE_2D, texture);
        gl.generateMipmap(GL.TEXTURE_2D);
        gl.bindTexture(GL.TEXTURE_2D, null);
        drawCanvasWith(gl, program, texture);
        counts.push(gl.content().ops.length);
        gl.resetState();
      }
      // The frame's own clear, draw, three level blits and canvas draw; nothing of the 299 frames before it.
      expect(new Set(counts.slice(2))).toEqual(new Set([6]));
      expect(said).toEqual([]);
    });

    it('caps a target drawn with a depth test every frame, naming it and its depth buffer, and reports it', () => {
      const said: string[] = [];
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), report: (what) => said.push(what) });
      const program = gl.createProgram();
      for (const [type, source] of [[GL.VERTEX_SHADER, VERTEX], [GL.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      gl.bindBuffer(GL.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      const { texture } = attach(gl, 4, 2);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(GL.RENDERBUFFER, depth);
      gl.renderbufferStorage(GL.RENDERBUFFER, GL.DEPTH_COMPONENT16, 4, 2);
      gl.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, depth);
      gl.enable(GL.DEPTH_TEST);
      gl.depthFunc(GL.ALWAYS);
      for (let i = 0; i < MAX_OPS_PER_TARGET + 10; i++) gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      drawCanvasWith(gl, program, texture);
      // A draw writes the colour target and the depth buffer; over the cap for either, it goes.
      expect(kinds(gl)).toHaveLength(MAX_OPS_PER_TARGET + 1);
      expect(said.length).toBeGreaterThan(0);
      expect(said[0]).toMatch(/render target .*feedback/);
    });

    it('drops the oldest draws of a target past the cap, never another target\'s, and says the frames that read it are not drawn right', () => {
      const said: string[] = [];
      const gl = createWebGLContext({ size: () => ({ width: 8, height: 4 }), report: (what) => said.push(what) });
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
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'p'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, GL.FLOAT, false, 0, 0);
      const quiet = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      const busy = attach(gl, 2, 2);
      for (let i = 0; i < MAX_OPS_PER_TARGET + 10; i++) gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      // Reading the quiet one: all its draws, and nothing said.
      drawCanvasWith(gl, program, quiet.texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
      expect(said).toEqual([]);
      // Reading the busy one: the newest draws, and it is said.
      gl.resetState();
      drawCanvasWith(gl, program, busy.texture);
      expect(kinds(gl)).toHaveLength(MAX_OPS_PER_TARGET + 1);
      // Once for each time the recording was made.
      expect(new Set(said).size).toBe(1);
      expect(said[0]).toMatch(/render target .*feedback/);
    });

    it('does not carry what went to the canvas', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.viewport(0, 0, 8, 4);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      expect(gl.drawn).toBe(false);
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
    });

    it('keeps the render targets when the canvas is resized, as a browser keeps its framebuffer objects', () => {
      const { gl, program } = setup();
      const { texture } = attach(gl, 4, 2);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      gl.resetState();
      gl.reset();
      drawCanvasWith(gl, program, texture);
      expect(kinds(gl)).toEqual(['draw:target', 'draw']);
      // And what the frame drew into them before the resize.
      const other = setup();
      const attached = attach(other.gl, 4, 2);
      other.gl.drawArrays(GL.TRIANGLES, 0, 3);
      other.gl.reset();
      drawCanvasWith(other.gl, other.program, attached.texture);
      expect(kinds(other.gl)).toEqual(['draw:target', 'draw']);
    });
  });
});

describe('what a renderer reads of a WebGL 2 context at start-up', () => {
  const v2 = (): WebGLContext => createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });

  it('answers the uniform buffer limits as the replay has them, and an unbound UNIFORM_BUFFER_BINDING', () => {
    const gl = v2();
    expect([GL2.MAX_UNIFORM_BUFFER_BINDINGS, GL2.MAX_VERTEX_UNIFORM_BLOCKS, GL2.MAX_FRAGMENT_UNIFORM_BLOCKS, GL2.MAX_COMBINED_UNIFORM_BLOCKS, GL2.MAX_UNIFORM_BLOCK_SIZE, GL2.UNIFORM_BUFFER_OFFSET_ALIGNMENT].map((p) => gl.getParameter(p))).toEqual([24, 12, 12, 24, 65536, 256]);
    expect(gl.getParameter(GL2.UNIFORM_BUFFER_BINDING)).toBeNull();
    expect(gl.getError()).toBe(GL.NO_ERROR);
    // WebGL 1 has none of them.
    const one = createWebGLContext({ size: () => ({ width: 8, height: 4 }) });
    expect(one.getParameter(GL2.MAX_UNIFORM_BUFFER_BINDINGS)).toBeNull();
    expect(one.getError()).toBe(GL.INVALID_ENUM);
  });

  it('lists the sample counts of a renderbuffer format, none for a 32-bit float one, and rejects what is not a renderbuffer format', () => {
    const gl = v2();
    const samples = (format: number, pname: number = GL.SAMPLES, target: number = GL.RENDERBUFFER) => gl.getInternalformatParameter(target, format, pname);
    expect(Array.from(samples(GL2.RGBA8)!)).toEqual([4]);
    expect(Array.from(samples(GL2.DEPTH24_STENCIL8)!)).toEqual([4]);
    expect(Array.from(samples(GL2.RGBA16F)!)).toEqual([4]);
    expect(Array.from(samples(GL2.RGBA32F)!)).toEqual([]);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    expect(samples(GL.DEPTH_COMPONENT)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_ENUM);
    expect(samples(GL2.RGBA8, GL2.MAX_SAMPLES)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_ENUM);
    expect(samples(GL2.RGBA8, GL.SAMPLES, GL.TEXTURE_2D)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_ENUM);
  });

  it('gives null for an extension it does not have, and lists only the ones it answers', () => {
    const gl = v2();
    for (const name of ['WEBGL_lose_context', 'OES_texture_float_linear', 'EXT_texture_filter_anisotropic', 'KHR_parallel_shader_compile', 'NO_SUCH_EXTENSION']) expect(gl.getExtension(name)).toBeNull();
    for (const name of gl.getSupportedExtensions()) expect(gl.getExtension(name)).not.toBeNull();
    expect(gl.getError()).toBe(GL.NO_ERROR);
  });
});
