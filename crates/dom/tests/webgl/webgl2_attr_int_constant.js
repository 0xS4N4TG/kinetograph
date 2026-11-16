// size: 64 32
// The current value of integer attributes (WebGL 2): vertexAttribI4i and vertexAttribI4ui set what a disabled array reads as ivec4 and uvec4,
// vertexAttribI4iv and vertexAttribI4uiv do the same from an array; the value changes between two draws.
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_signed');
  gl.bindAttribLocation(p, 2, 'a_unsigned');
  gl.linkProgram(p);
  return p;
}
const p = program(`#version 300 es
in vec2 a_pos; in ivec4 a_signed; in uvec4 a_unsigned; out vec4 v_color;
void main() {
  v_color = vec4(float(a_signed.x + 8) / 16.0, float(a_signed.y + 8) / 16.0, float(a_unsigned.z) / 255.0, float(a_unsigned.w) / 255.0);
  gl_Position = vec4(a_pos * vec2(0.5, 1.0) + vec2(float(a_signed.w) * 0.5, 0.0), 0.0, 1.0);
}`, `#version 300 es
precision highp float; in vec4 v_color; out vec4 o;
void main() { o = v_color; }`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.useProgram(p);
gl.vertexAttribI4i(1, -4, 5, 0, -1);
gl.vertexAttribI4ui(2, 0, 0, 200, 255);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.vertexAttribI4iv(1, new Int32Array([3, -6, 0, 1]));
gl.vertexAttribI4uiv(2, new Uint32Array([0, 0, 90, 255]));
gl.drawArrays(gl.TRIANGLES, 0, 6);
