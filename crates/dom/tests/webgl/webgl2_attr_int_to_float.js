// size: 96 64
// Integer arrays feeding float inputs (WebGL 2, GLES 3.0 section 2.9): vertexAttribPointer with SHORT, UNSIGNED_BYTE and
// BYTE and normalized false makes the shader see the integer values as floats. Positions are pixels in an interleaved
// buffer of shorts (stride 12, the colour, three components of 0..255, at offset 4), four instances are placed by a
// UNSIGNED_BYTE pair with divisor 1, and a BYTE with divisor 2 dims the last two.
function program(vs, fs, names) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  names.forEach((n, i) => gl.bindAttribLocation(p, i, n));
  gl.linkProgram(p);
  return p;
}
function attribute(index, data, size, type, normalized, stride, offset, divisor) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(index);
  return b;
}
const p = program(`#version 300 es
in vec2 a_pos; in vec3 a_color; in vec2 a_offset; in float a_shade; out vec3 v_color;
void main() {
  v_color = a_color / 255.0 * (1.0 - a_shade * 0.4);
  gl_Position = vec4((a_pos + a_offset) / vec2(48.0, 32.0) - 1.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float; in vec3 v_color; out vec4 o;
void main() { o = vec4(v_color, 1.0); }`, ['a_pos', 'a_color', 'a_offset', 'a_shade']);

const rows = [];
for (const [x, y, r, g, b] of [[0, 0, 255, 60, 40], [20, 0, 255, 60, 40], [0, 20, 40, 200, 255], [0, 20, 40, 200, 255], [20, 0, 255, 60, 40], [20, 20, 40, 200, 255]]) rows.push(x, y, r, g, b, 0);
attribute(0, new Int16Array(rows), 2, gl.SHORT, false, 12, 0, 0);
gl.vertexAttribPointer(0, 2, gl.SHORT, false, 12, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 3, gl.SHORT, false, 12, 4);

attribute(2, new Uint8Array([8, 8, 40, 8, 8, 36, 40, 36]), 2, gl.UNSIGNED_BYTE, false, 0, 0, 1);
gl.vertexAttribPointer(2, 2, gl.UNSIGNED_BYTE, false, 0, 0);
gl.vertexAttribDivisor(2, 1);
attribute(3, new Int8Array([0, 1]), 1, gl.BYTE, false, 0, 0, 2);
gl.vertexAttribPointer(3, 1, gl.BYTE, false, 0, 0);
gl.vertexAttribDivisor(3, 2);

gl.clearColor(0.2, 0.2, 0.2, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.viewport(0, 0, W, H);
gl.useProgram(p);
gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 4);
