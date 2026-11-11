// size: 96 64
// bindBufferRange into one large buffer (WebGL 2) with the std140 padding of matrices and arrays: `Big` holds a mat4,
// a mat3, a float array, a vec3 then a float (which sits in the vec3's padding), a mat2 and an array of vec2, at the
// offsets and strides the program reports, 512 bytes into a buffer whose other bytes are 0.9. Eight strips each show
// one part of it as a colour.
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
const p = program(`#version 300 es
in vec2 a_pos; in float a_id; out vec3 v_color;
layout(std140) uniform Big { mat4 mvp; mat3 m3; float arr[3]; vec3 tint; float alpha; mat2 m2; vec2 pts[2]; };
void main() {
  int id = int(a_id);
  vec3 c = vec3(0.0);
  if (id == 0) c = m3[0];
  else if (id == 1) c = m3[1];
  else if (id == 2) c = m3[2];
  else if (id == 3) c = vec3(arr[0], arr[1], arr[2]);
  else if (id == 4) c = tint * alpha;
  else if (id == 5) c = vec3(m2[0], m2[1].x);
  else if (id == 6) c = vec3(pts[0], pts[1].y);
  else c = mvp[3].xyz;
  v_color = c;
  gl_Position = vec4(a_pos.x * 0.125 + (float(id) - 3.5) * 0.25, a_pos.y, 0.0, 1.0);
}`, `#version 300 es
precision highp float; in vec3 v_color; out vec4 o;
void main() { o = vec4(v_color, 1.0); }`);

const verts = [];
for (let id = 0; id < 8; id += 1) {
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [-1, 1], [1, -1], [1, 1]]) verts.push(x, y, id);
}
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);

const index = gl.getUniformBlockIndex(p, 'Big');
const size = gl.getActiveUniformBlockParameter(p, index, gl.UNIFORM_BLOCK_DATA_SIZE);
const names = ['mvp', 'm3', 'arr', 'tint', 'alpha', 'm2', 'pts'];
const ids = gl.getUniformIndices(p, names);
const offset = gl.getActiveUniforms(p, ids, gl.UNIFORM_OFFSET);
const arrayStride = gl.getActiveUniforms(p, ids, gl.UNIFORM_ARRAY_STRIDE);
const matrixStride = gl.getActiveUniforms(p, ids, gl.UNIFORM_MATRIX_STRIDE);

const bytes = new ArrayBuffer(2048);
const f = new Float32Array(bytes);
f.fill(0.9);
const base = 512 / 4;
f.fill(0, base, base + size / 4);
const at = (name) => base + offset[names.indexOf(name)] / 4;
// A matrix by its columns, an array by its stride.
const matrix = (name, columns) => columns.forEach((c, j) => f.set(c, at(name) + (j * matrixStride[names.indexOf(name)]) / 4));
const list = (name, items) => items.forEach((v, i) => f.set([].concat(v), at(name) + (i * arrayStride[names.indexOf(name)]) / 4));
matrix('mvp', [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0.2, 0.4, 0.6, 1]]);
matrix('m3', [[0.9, 0.1, 0.2], [0.3, 0.8, 0.4], [0.5, 0.6, 0.7]]);
list('arr', [0.15, 0.55, 0.95]);
f.set([0.7, 0.2, 0.5], at('tint'));
f[at('alpha')] = 0.75;
matrix('m2', [[0.25, 0.85], [0.45, 0.65]]);
list('pts', [[0.35, 0.05], [0.95, 0.5]]);
const ubo = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.STATIC_DRAW);
gl.uniformBlockBinding(p, index, 2);
gl.bindBufferRange(gl.UNIFORM_BUFFER, 2, ubo, 512, 1024);

gl.clearColor(0.05, 0.05, 0.1, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.viewport(0, 0, W, H);
gl.useProgram(p);
gl.drawArrays(gl.TRIANGLES, 0, 48);
