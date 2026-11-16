// size: 64 32
// Integer textures (WebGL 2): an R32UI texture (4 x 2) and an RGBA32I texture (2 x 2) read with texelFetch through usampler2D and
// isampler2D, in the fragment shader (a grid of cells) and in the vertex shader (a value for each corner, interpolated).
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
in vec2 a_pos; uniform highp usampler2D u_ids; out vec2 v_uv; out float v_vtx;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_vtx = float(texelFetch(u_ids, ivec2(gl_VertexID % 4, 1), 0).r) / 255.0;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`, `#version 300 es
precision highp float; precision highp int; precision highp usampler2D; precision highp isampler2D;
in vec2 v_uv; in float v_vtx; uniform usampler2D u_ids; uniform isampler2D u_signed; out vec4 o;
void main() {
  ivec2 cell = ivec2(floor(v_uv * vec2(3.999, 1.999)));
  uint id = texelFetch(u_ids, cell, 0).r;
  ivec4 sg = texelFetch(u_signed, cell & ivec2(1), 0);
  o = vec4(float(id) / 40.0, float(sg.g + 8) / 16.0, 0.5 * v_vtx + 0.25, 1.0);
}`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function texture(unit, internalformat, format, type, width, height, data) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalformat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}
texture(0, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, 4, 2, new Uint32Array([10, 20, 30, 40, 0, 51, 102, 255]));
texture(1, gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 2, 2, new Int32Array([0, -8, 0, 0, 0, -3, 0, 0, 0, 3, 0, 0, 0, 7, 0, 0]));
gl.useProgram(p);
gl.uniform1i(gl.getUniformLocation(p, 'u_ids'), 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_signed'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
