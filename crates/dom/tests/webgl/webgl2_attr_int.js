// size: 96 64
// Integer vertex inputs (WebGL 2): vertexAttribIPointer feeds `uvec4`, `ivec2` and `uint` inputs of UNSIGNED_SHORT,
// BYTE (signed, so a shift can be negative) and UNSIGNED_BYTE values, one for each of four instances, and the shader
// takes them apart with shifts, masks and a test of a bit.
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
in vec2 a_pos; in uvec4 a_ids; in ivec2 a_shift; in uint a_flags; out vec3 v_color;
void main() {
  vec3 c = vec3(float(a_ids.x & 255u), float(a_ids.x >> 8u), float(a_ids.y)) / 255.0;
  if ((a_flags & 4u) != 0u) c = c.bgr;
  c *= 1.0 - 0.5 * float((a_flags >> 1u) & 1u);
  v_color = c;
  vec2 origin = vec2(float(a_ids.z), float(a_ids.w)) + vec2(a_shift);
  gl_Position = vec4((a_pos + origin) / vec2(48.0, 32.0) - 1.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float; in vec3 v_color; out vec4 o;
void main() { o = vec4(v_color, 1.0); }`, ['a_pos', 'a_ids', 'a_shift', 'a_flags']);

attribute(0, new Float32Array([0, 0, 20, 0, 0, 20, 0, 20, 20, 0, 20, 20]), 2, gl.FLOAT, false, 0, 0, 0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
// Colour packed in the low and high bytes of a short and in a second one, the origin in the other two.
attribute(1, new Uint16Array([
  200 | (40 << 8), 80, 8, 8,
  30 | (180 << 8), 240, 40, 8,
  250 | (220 << 8), 60, 8, 36,
  90 | (90 << 8), 200, 40, 36,
]), 4, gl.UNSIGNED_SHORT, false, 0, 0, 1);
gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_SHORT, 0, 0);
gl.vertexAttribDivisor(1, 1);
attribute(2, new Int8Array([-4, 4, 4, -4, 0, 0, 0, 0]), 2, gl.BYTE, false, 4, 0, 1);
gl.vertexAttribIPointer(2, 2, gl.BYTE, 2, 0);
gl.vertexAttribDivisor(2, 1);
attribute(3, new Uint8Array([0, 2, 4, 6]), 1, gl.UNSIGNED_BYTE, false, 0, 0, 1);
gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0);
gl.vertexAttribDivisor(3, 1);

gl.clearColor(0.2, 0.2, 0.2, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.viewport(0, 0, W, H);
gl.useProgram(p);
gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 4);
