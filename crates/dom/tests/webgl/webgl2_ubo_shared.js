// size: 96 64
// One uniform block shared by two programs (WebGL 2): `Frame` is declared in the shaders of both programs, filled once
// at the offsets getActiveUniforms reports, and bound at two binding points, 0 for the first program (the default) and
// 5 for the second. Each reads it for its own picture: a tinted square, and three strips as bright as the block's array.
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  return p;
}
const FRAME = `layout(std140) uniform Frame { vec4 tint; vec2 shift; float scale; float levels[3]; };`;
const square = program(`#version 300 es
in vec2 a_pos; ${FRAME}
void main() { gl_Position = vec4(a_pos * scale + shift, 0.0, 1.0); }`, `#version 300 es
precision highp float; out vec4 o; ${FRAME}
void main() { o = tint; }`);
const strips = program(`#version 300 es
in vec2 a_pos; out float v_level; ${FRAME}
void main() {
  int i = gl_VertexID / 6;
  v_level = levels[i];
  gl_Position = vec4(a_pos.x * 0.15 + (float(i) - 1.0) * 0.4, a_pos.y * 0.25 - 0.65, 0.0, 1.0);
}`, `#version 300 es
precision highp float; in float v_level; out vec4 o; ${FRAME}
void main() { o = vec4(vec3(v_level) * tint.rgb, 1.0); }`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
const q = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...q, ...q, ...q]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

// Fill the block by the layout the program reports.
const size = gl.getActiveUniformBlockParameter(square, gl.getUniformBlockIndex(square, 'Frame'), gl.UNIFORM_BLOCK_DATA_SIZE);
const view = new Float32Array(size / 4);
const names = ['tint', 'shift', 'scale', 'levels'];
const ids = gl.getUniformIndices(square, names);
const at = gl.getActiveUniforms(square, ids, gl.UNIFORM_OFFSET);
const stride = gl.getActiveUniforms(square, ids, gl.UNIFORM_ARRAY_STRIDE)[3];
view.set([0.9, 0.5, 0.1, 1], at[0] / 4);
view.set([-0.45, 0.35], at[1] / 4);
view.set([0.4], at[2] / 4);
[0.3, 0.6, 1.0].forEach((v, i) => { view[(at[3] + i * stride) / 4] = v; });
const ubo = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
gl.bufferData(gl.UNIFORM_BUFFER, view, gl.STATIC_DRAW);
gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
gl.bindBufferBase(gl.UNIFORM_BUFFER, 5, ubo);
gl.uniformBlockBinding(strips, gl.getUniformBlockIndex(strips, 'Frame'), 5);

gl.clearColor(0.1, 0.12, 0.2, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.viewport(0, 0, W, H);
gl.useProgram(square);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.useProgram(strips);
gl.drawArrays(gl.TRIANGLES, 0, 18);
