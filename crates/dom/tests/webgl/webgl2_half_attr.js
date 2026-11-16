// size: 64 64
// A HALF_FLOAT vertex attribute (WebGL 2): positions (a triangle that covers the canvas) of 2 halves and colours of 4 halves (and of 3 halves, padded to a
// stride of 8 bytes), each bound with vertexAttribPointer(.., gl.HALF_FLOAT, ..).
function toHalf(v) {
  const f = new Float32Array([v]), b = new Uint32Array(f.buffer)[0];
  const sign = (b >> 16) & 0x8000, e = ((b >> 23) & 0xff) - 127 + 15, m = b & 0x7fffff;
  if (v === 0) return sign;
  let h = sign | (e << 10) | (m >> 13);
  if ((m & 0x1fff) > 0x1000 || ((m & 0x1fff) === 0x1000 && (h & 1))) h++;
  return h;
}
const p = gl.createProgram();
for (const [type, src] of [
  [gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos; in vec4 a_color; in vec3 a_tint; out vec4 v_color;
void main() { v_color = vec4(a_color.rgb * 0.5 + a_tint * 0.5, a_color.a); gl_Position = vec4(a_pos, 0.0, 1.0); }`],
  [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; in vec4 v_color; out vec4 o;
void main() { o = v_color; }`],
]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.bindAttribLocation(p, 1, 'a_color');
gl.bindAttribLocation(p, 2, 'a_tint');
gl.linkProgram(p);
gl.useProgram(p);
// Interleaved per vertex: 2 halves of position, 4 of colour, 3 of tint and one of padding: 20 bytes.
const vertices = [
  [-1, -1, 1, 0, 0, 1, 0, 0, 1],
  [3, -1, 0, 1, 0, 1, 1, 0, 0],
  [-1, 3, 0, 0, 1, 1, 0, 1, 0],
];
const data = new Uint16Array(vertices.length * 10);
vertices.forEach((v, i) => { v.forEach((x, k) => { data[i * 10 + k] = toHalf(x); }); });
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.HALF_FLOAT, false, 20, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 4, gl.HALF_FLOAT, false, 20, 4);
gl.enableVertexAttribArray(2);
gl.vertexAttribPointer(2, 3, gl.HALF_FLOAT, false, 20, 12);
gl.drawArrays(gl.TRIANGLES, 0, 3);
