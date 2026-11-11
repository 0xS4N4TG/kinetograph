import { describe, expect, it } from 'vitest';
import { createWebGLContext, GL, GL2, WebGLUnsupportedError, type WebGLContext } from '../src/index.js';

// The numbers are what Chrome (ANGLE on SwiftShader) answers for the same shaders: crates/dom/tests/webgl/ubo_*.js
// draws them in both, and these are the layout facts that the page reads back before it fills a buffer.

const FRAGMENT = '#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1); }';
const POSITION = '#version 300 es\nin vec2 p;\n';

function link(gl: WebGLContext, vertex: string, fragment = FRAGMENT) {
  const program = gl.createProgram();
  for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  return program;
}

function context(): WebGLContext {
  return createWebGLContext({ size: () => ({ width: 8, height: 4 }), version: 2 });
}

/** A context with a program of `declarations` and `use` (an expression of vec4) in its vertex shader, and a triangle. */
function setup(declarations: string, use: string, fragment = FRAGMENT) {
  const gl = context();
  const program = link(gl, `${POSITION}${declarations}\nvoid main() { gl_Position = vec4(p, 0.0, 1.0) + ${use}; }`, fragment);
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(GL.ARRAY_BUFFER, quad);
  gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), GL.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
  return { gl, program };
}

const uniforms = (gl: WebGLContext, program: ReturnType<typeof link>, pname: number) => {
  const n = gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS) as number;
  return gl.getActiveUniforms(program, Array.from({ length: n }, (_, i) => i), pname);
};

const draws = (gl: WebGLContext) => gl.content().ops.flatMap((op) => (op.op === 'draw' ? [op] : []));
const bytesOf = (gl: WebGLContext, id: string) => Uint8Array.from(Buffer.from(gl.content().buffers[id]!, 'base64'));

describe('uniform blocks', () => {
  const BLOCKS = `
layout(std140) uniform Tiny { float a; };
layout(std140) uniform Block { vec3 v; float f; float arr[3]; mat3 m3; mat2 m2; mat4x3 m43; ivec2 iv; bool flag; vec2 v2arr[2]; } inst;
layout(std140) uniform Plain { vec4 c; mat4 mvp; };
uniform float loose;
uniform sampler2D s;`;
  const USE = 'vec4(a + inst.v.x + inst.f + inst.arr[1] + inst.m3[0][0] + inst.m2[0][0] + inst.m43[0][0] + float(inst.iv.x) + float(inst.flag) + inst.v2arr[1].x + c.x + mvp[0][0] + loose + texture(s, vec2(0)).x)';
  const SHARED = '#version 300 es\nprecision highp float; out vec4 o;\nlayout(std140) uniform Plain { vec4 c; mat4 mvp; };\nvoid main() { o = c; }';

  it('lays the members out as std140 and lists them after the loose uniforms, as a browser does', () => {
    const { gl, program } = setup(BLOCKS, USE, SHARED);
    expect(gl.getProgramParameter(program, GL.LINK_STATUS)).toBe(true);
    expect(gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS)).toBe(14);
    expect(gl.getProgramParameter(program, GL2.ACTIVE_UNIFORM_BLOCKS)).toBe(3);
    const names = Array.from({ length: 14 }, (_, i) => gl.getActiveUniform(program, i)!.name);
    expect(names).toEqual(['loose', 's', 'a', 'Block.v', 'Block.f', 'Block.arr[0]', 'Block.m3', 'Block.m2', 'Block.m43', 'Block.iv', 'Block.flag', 'Block.v2arr[0]', 'c', 'mvp']);
    expect(uniforms(gl, program, GL2.UNIFORM_OFFSET)).toEqual([-1, -1, 0, 0, 12, 16, 64, 112, 144, 208, 216, 224, 0, 16]);
    expect(uniforms(gl, program, GL2.UNIFORM_BLOCK_INDEX)).toEqual([-1, -1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
    expect(uniforms(gl, program, GL2.UNIFORM_SIZE)).toEqual([1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 2, 1, 1]);
    expect(uniforms(gl, program, GL2.UNIFORM_ARRAY_STRIDE)).toEqual([-1, -1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 16, 0, 0]);
    expect(uniforms(gl, program, GL2.UNIFORM_MATRIX_STRIDE)).toEqual([-1, -1, 0, 0, 0, 0, 16, 16, 16, 0, 0, 0, 0, 16]);
    expect(uniforms(gl, program, GL2.UNIFORM_TYPE)).toEqual([GL.FLOAT, GL.SAMPLER_2D, GL.FLOAT, GL.FLOAT_VEC3, GL.FLOAT, GL.FLOAT, GL.FLOAT_MAT3, GL.FLOAT_MAT2, GL2.FLOAT_MAT4x3, GL.INT_VEC2, GL.BOOL, GL.FLOAT_VEC2, GL.FLOAT_VEC4, GL.FLOAT_MAT4]);
    expect(uniforms(gl, program, GL2.UNIFORM_IS_ROW_MAJOR)!.every((r) => r === false)).toBe(true);
  });

  it('answers the block queries: sizes are where the last member ends, and a block shared by both shaders is referenced by both', () => {
    const { gl, program } = setup(BLOCKS, USE, SHARED);
    expect([gl.getUniformBlockIndex(program, 'Block'), gl.getUniformBlockIndex(program, 'Plain'), gl.getUniformBlockIndex(program, 'inst'), gl.getUniformBlockIndex(program, 'none')]).toEqual([1, 2, GL2.INVALID_INDEX, GL2.INVALID_INDEX]);
    const block = (i: number) => [GL2.UNIFORM_BLOCK_BINDING, GL2.UNIFORM_BLOCK_DATA_SIZE, GL2.UNIFORM_BLOCK_ACTIVE_UNIFORMS, GL2.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER, GL2.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER].map((p) => gl.getActiveUniformBlockParameter(program, i, p));
    expect([0, 1, 2].map((i) => gl.getActiveUniformBlockName(program, i))).toEqual(['Tiny', 'Block', 'Plain']);
    expect(block(0)).toEqual([0, 4, 1, true, false]);
    expect(block(1)).toEqual([0, 256, 9, true, false]);
    expect(block(2)).toEqual([0, 80, 2, true, true]);
    expect(Array.from(gl.getActiveUniformBlockParameter(program, 1, GL2.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES) as Uint32Array)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(gl.getUniformIndices(program, ['Block.v', 'Plain.mvp', 'Block.arr', 'Block.arr[0]', 'inst.v', 'c', 'loose', 'nope'])).toEqual([3, GL2.INVALID_INDEX, 5, 5, GL2.INVALID_INDEX, 12, 0, GL2.INVALID_INDEX]);
    expect(gl.getUniformLocation(program, 'Block.v')).toBeNull();
    expect(gl.getUniformLocation(program, 'c')).toBeNull();
    expect(gl.getUniformLocation(program, 'loose')).not.toBeNull();
    expect(gl.getError()).toBe(GL.NO_ERROR);
    expect(gl.getActiveUniformBlockName(program, 99)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_VALUE);
    expect(gl.getActiveUniformBlockParameter(program, 0, GL.FLOAT)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_ENUM);
    expect(gl.getActiveUniforms(program, [99], GL2.UNIFORM_TYPE)).toBeNull();
    expect(gl.getError()).toBe(GL.INVALID_VALUE);
  });

  it('lays out structs, arrays of them and matrices of every shape as std140 does', () => {
    const { gl, program } = setup('struct L { vec3 pos; float r[2]; mat2 m; };\nlayout(std140) uniform B { float pre; L lights[2]; L one; float post; } b;', 'vec4(b.pre + b.lights[1].pos.x + b.one.r[0] + b.post)');
    expect(Array.from({ length: 11 }, (_, i) => gl.getActiveUniform(program, i)!.name)).toEqual(['B.pre', 'B.lights[0].pos', 'B.lights[0].r[0]', 'B.lights[0].m', 'B.lights[1].pos', 'B.lights[1].r[0]', 'B.lights[1].m', 'B.one.pos', 'B.one.r[0]', 'B.one.m', 'B.post']);
    expect(uniforms(gl, program, GL2.UNIFORM_OFFSET)).toEqual([0, 16, 32, 64, 96, 112, 144, 176, 192, 224, 256]);
    expect(gl.getActiveUniformBlockParameter(program, 0, GL2.UNIFORM_BLOCK_DATA_SIZE)).toBe(260);
    const m = setup('layout(std140) uniform B { mat2 m[2]; mat3x2 n; mat2x4 q; uint u; uvec3 w; bvec2 bb; };', 'vec4(m[1][0][0] + n[0][0] + q[0][0] + float(u) + float(w.x) + float(bb.x))');
    expect(uniforms(m.gl, m.program, GL2.UNIFORM_OFFSET)).toEqual([0, 64, 112, 144, 160, 176]);
    expect(uniforms(m.gl, m.program, GL2.UNIFORM_ARRAY_STRIDE)).toEqual([32, 0, 0, 0, 0, 0]);
    expect(m.gl.getActiveUniformBlockParameter(m.program, 0, GL2.UNIFORM_BLOCK_DATA_SIZE)).toBe(184);
    const sizes = (body: string) => {
      const { gl: g, program: p } = setup(`layout(std140) uniform B { ${body} };`, 'vec4(0)');
      return g.getActiveUniformBlockParameter(p, 0, GL2.UNIFORM_BLOCK_DATA_SIZE);
    };
    expect([sizes('vec3 v;'), sizes('float f; vec3 v;'), sizes('vec4 v; float f;')]).toEqual([12, 28, 20]);
  });

  it('numbers the blocks in the order they are declared and the loose uniforms ahead of the members', () => {
    const { gl, program } = setup('layout(std140) uniform Z { float z; }; layout(std140) uniform A { float a; }; uniform vec4 l1; uniform float l2[3];', 'vec4(z + a + l1.x + l2[2])');
    expect([gl.getUniformBlockIndex(program, 'Z'), gl.getUniformBlockIndex(program, 'A')]).toEqual([0, 1]);
    expect(Array.from({ length: 4 }, (_, i) => gl.getActiveUniform(program, i)!.name)).toEqual(['l1', 'l2[0]', 'z', 'a']);
  });

  it('has the limits the replay has, and a binding point for each block (default 0)', () => {
    const { gl, program } = setup(BLOCKS, USE, SHARED);
    expect([GL2.MAX_UNIFORM_BUFFER_BINDINGS, GL2.MAX_UNIFORM_BLOCK_SIZE, GL2.UNIFORM_BUFFER_OFFSET_ALIGNMENT, GL2.MAX_VERTEX_UNIFORM_BLOCKS, GL2.MAX_FRAGMENT_UNIFORM_BLOCKS, GL2.MAX_COMBINED_UNIFORM_BLOCKS].map((p) => gl.getParameter(p))).toEqual([24, 65536, 256, 12, 12, 24]);
    gl.uniformBlockBinding(program, 1, 3);
    expect(gl.getActiveUniformBlockParameter(program, 1, GL2.UNIFORM_BLOCK_BINDING)).toBe(3);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    gl.uniformBlockBinding(program, 99, 3);
    expect(gl.getError()).toBe(GL.INVALID_VALUE);
    gl.uniformBlockBinding(program, 1, 24);
    expect(gl.getError()).toBe(GL.INVALID_VALUE);
    // A link starts them over.
    gl.linkProgram(program);
    expect(gl.getActiveUniformBlockParameter(program, 1, GL2.UNIFORM_BLOCK_BINDING)).toBe(0);
  });

  it('binds buffers with the errors a browser gives', () => {
    const { gl } = setup('layout(std140) uniform B { float a; };', 'vec4(a)');
    const buffer = gl.createBuffer();
    gl.bindBuffer(GL2.UNIFORM_BUFFER, buffer);
    expect(gl.getParameter(GL2.UNIFORM_BUFFER_BINDING)).toBe(buffer);
    gl.bufferData(GL2.UNIFORM_BUFFER, 1024, GL.DYNAMIC_DRAW);
    expect(gl.getBufferParameter(GL2.UNIFORM_BUFFER, GL.BUFFER_SIZE)).toBe(1024);
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 0, buffer);
    expect([gl.getIndexedParameter(GL2.UNIFORM_BUFFER_BINDING, 0) === buffer, gl.getIndexedParameter(GL2.UNIFORM_BUFFER_START, 0), gl.getIndexedParameter(GL2.UNIFORM_BUFFER_SIZE, 0)]).toEqual([true, 0, 0]);
    gl.bindBufferRange(GL2.UNIFORM_BUFFER, 1, buffer, 256, 64);
    expect([gl.getIndexedParameter(GL2.UNIFORM_BUFFER_START, 1), gl.getIndexedParameter(GL2.UNIFORM_BUFFER_SIZE, 1)]).toEqual([256, 64]);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    const errors: number[] = [];
    const next = (call: () => void) => {
      call();
      errors.push(gl.getError());
    };
    next(() => gl.bindBufferRange(GL2.UNIFORM_BUFFER, 0, buffer, 128, 64));
    next(() => gl.bindBufferRange(GL2.UNIFORM_BUFFER, 0, buffer, 256, 0));
    next(() => gl.bindBufferRange(GL2.UNIFORM_BUFFER, 0, buffer, 256, 4096));
    next(() => gl.bindBufferBase(GL2.UNIFORM_BUFFER, 24, buffer));
    next(() => gl.bindBufferBase(GL.ARRAY_BUFFER, 0, buffer));
    next(() => gl.getIndexedParameter(GL2.UNIFORM_BUFFER_BINDING, 24));
    next(() => gl.getIndexedParameter(GL.ARRAY_BUFFER_BINDING, 0));
    expect(errors).toEqual([GL.INVALID_VALUE, GL.INVALID_VALUE, GL.NO_ERROR, GL.INVALID_VALUE, GL.INVALID_ENUM, GL.INVALID_VALUE, GL.INVALID_ENUM]);
    // A deleted buffer is unbound everywhere.
    gl.deleteBuffer(buffer);
    expect([gl.getParameter(GL2.UNIFORM_BUFFER_BINDING), gl.getIndexedParameter(GL2.UNIFORM_BUFFER_BINDING, 1)]).toEqual([null, null]);
    gl.bindBuffer(GL2.UNIFORM_BUFFER, null);
    gl.bufferData(GL2.UNIFORM_BUFFER, 4, GL.STATIC_DRAW);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
  });

  it('refuses a draw whose block has no buffer or less of one than it holds, as a browser does', () => {
    const { gl, program } = setup('layout(std140) uniform B { float a; float b; float c[2]; };', 'vec4(a + b + c[1])');
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    const buffer = gl.createBuffer();
    gl.bindBuffer(GL2.UNIFORM_BUFFER, buffer);
    gl.bufferData(GL2.UNIFORM_BUFFER, 8, GL.DYNAMIC_DRAW);
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 0, buffer);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    gl.bufferData(GL2.UNIFORM_BUFFER, 1024, GL.DYNAMIC_DRAW);
    gl.bindBufferRange(GL2.UNIFORM_BUFFER, 0, buffer, 256, 16);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    // The block points at 3, which holds nothing.
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 0, buffer);
    gl.uniformBlockBinding(program, 0, 3);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.getError()).toBe(GL.INVALID_OPERATION);
    expect(draws(gl)).toEqual([]);
    gl.bindBufferRange(GL2.UNIFORM_BUFFER, 3, buffer, 256, 48);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    expect(gl.getError()).toBe(GL.NO_ERROR);
    expect(draws(gl)).toHaveLength(1);
  });

  it('gives each draw the bytes the buffer had then, and records the layout once with the program', () => {
    const { gl, program } = setup('layout(std140) uniform B { vec4 c; mat2 m; } b;\nlayout(std140) uniform Other { float k[2]; };', 'b.c + vec4(b.m[1][1] + k[1])');
    const first = gl.createBuffer();
    const second = gl.createBuffer();
    gl.bindBuffer(GL2.UNIFORM_BUFFER, first);
    gl.bufferData(GL2.UNIFORM_BUFFER, new Float32Array(12).fill(1), GL.DYNAMIC_DRAW);
    gl.bindBuffer(GL2.UNIFORM_BUFFER, second);
    gl.bufferData(GL2.UNIFORM_BUFFER, new Float32Array(8).fill(2), GL.DYNAMIC_DRAW);
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 0, first);
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 1, second);
    gl.uniformBlockBinding(program, 1, 1);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.bindBuffer(GL2.UNIFORM_BUFFER, first);
    gl.bufferSubData(GL2.UNIFORM_BUFFER, 16, new Float32Array([9, 9, 9, 9]));
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const [a, b] = draws(gl);
    expect(Object.keys(a!.blocks!)).toEqual(['B', 'Other']);
    expect(a!.blocks!.B).toMatchObject({ offset: 0, size: 48 });
    expect(a!.blocks!.Other).toMatchObject({ offset: 0, size: 32 });
    expect(a!.blocks!.B!.buffer).not.toBe(b!.blocks!.B!.buffer);
    expect(a!.blocks!.Other!.buffer).toBe(b!.blocks!.Other!.buffer);
    expect(Array.from(new Float32Array(bytesOf(gl, a!.blocks!.B!.buffer).buffer).slice(4, 8))).toEqual([1, 1, 1, 1]);
    expect(Array.from(new Float32Array(bytesOf(gl, b!.blocks!.B!.buffer).buffer).slice(4, 8))).toEqual([9, 9, 9, 9]);
    const recorded = gl.content().programs[a!.program]!;
    expect(recorded.blocks).toEqual([
      { name: 'B', size: 48, members: [{ name: 'c', type: 'vec4', offset: 0 }, { name: 'm', type: 'mat2', offset: 16 }] },
      { name: 'Other', size: 32, members: [{ name: 'k', type: 'float', length: 2, offset: 0, stride: 16 }] },
    ]);
  });

  it('keeps a render target draw\'s uniform buffers in the frames after it', () => {
    const { gl } = setup('layout(std140) uniform B { vec4 c; };', 'c');
    const buffer = gl.createBuffer();
    gl.bindBuffer(GL2.UNIFORM_BUFFER, buffer);
    gl.bufferData(GL2.UNIFORM_BUFFER, new Float32Array([1, 2, 3, 4]), GL.STATIC_DRAW);
    gl.bindBufferBase(GL2.UNIFORM_BUFFER, 0, buffer);
    const texture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    gl.bindFramebuffer(GL.FRAMEBUFFER, null);
    gl.resetState();
    // The next frame reads the texture; the draw that made it comes first, with its block.
    const sampler = link(gl, `${POSITION}out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`, '#version 300 es\nprecision highp float; in vec2 v; uniform sampler2D t; out vec4 o; void main() { o = texture(t, v); }');
    gl.useProgram(sampler);
    gl.uniform1i(gl.getUniformLocation(sampler, 't'), 0);
    gl.drawArrays(GL.TRIANGLES, 0, 3);
    const content = gl.content();
    const [target] = content.ops.flatMap((op) => (op.op === 'draw' && op.target !== undefined ? [op] : []));
    expect(Object.keys(content.buffers)).toContain(target!.blocks!.B!.buffer);
  });

  it('says unsupported, precisely, for the layouts it does not draw', () => {
    const refused = (declarations: string): string => {
      try {
        setup(declarations, 'vec4(0)');
      } catch (e) {
        expect(e).toBeInstanceOf(WebGLUnsupportedError);
        return (e as Error).message;
      }
      throw new Error('did not throw');
    };
    expect(refused('layout(std140, row_major) uniform B { mat4 m; };')).toMatch(/^unsupported: row_major on the uniform block B/);
    expect(refused('layout(std140) uniform B { row_major mat4 m; };')).toMatch(/^unsupported: row_major in the uniform block B/);
    expect(refused('layout(shared) uniform B { float f; };')).toMatch(/^unsupported: layout\(shared\) on the uniform block B; WebGL allows std140 only/);
    expect(refused('layout(std140) uniform B { float f; } b[2];')).toMatch(/^unsupported: the uniform block B declared as an array of instances/);
    expect(refused('layout(std140) uniform B { sampler2D s; };')).toMatch(/^unsupported: a sampler2D in a uniform block/);
    expect(refused('layout(std140) uniform B { Missing m; };')).toMatch(/^unsupported: the type `Missing` in a uniform block/);
  });

  it('refuses to link a block the two shaders declare differently', () => {
    const gl = context();
    const program = link(gl, `${POSITION}layout(std140) uniform B { vec4 c; }; void main() { gl_Position = c; }`, '#version 300 es\nprecision highp float; out vec4 o; layout(std140) uniform B { vec3 c; }; void main() { o = vec4(c, 1); }');
    expect(gl.getProgramParameter(program, GL.LINK_STATUS)).toBe(false);
    expect(gl.getProgramInfoLog(program)).toMatch(/uniform block 'B' is declared differently/);
  });
});
