// size: 96 64
// attributes: {"antialias": false}
// vertexAttribDivisor of 2 (WebGL 2): drawArraysInstanced draws eight squares in two rows; each instance's offset
// advances every instance (divisor 1) and its colour every second instance (divisor 2), so the squares come in pairs
// of red, green, blue and yellow.
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_offset');
  gl.bindAttribLocation(p, 2, 'a_color');
  gl.linkProgram(p);
  return p;
}
const p = program(`#version 300 es
in vec2 a_pos; in vec2 a_offset; in vec3 a_color; out vec3 v_color; uniform vec2 u_res;
void main() { v_color = a_color; gl_Position = vec4((a_pos + a_offset) / u_res * 2.0 - 1.0, 0.0, 1.0); }`, `#version 300 es
precision mediump float; in vec3 v_color; out vec4 o;
void main() { o = vec4(v_color, 1.0); }`);

// A 20 x 20 pixel square.
const square = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, square);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 20, 0, 0, 20, 0, 20, 20, 0, 20, 20]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const offsets = [];
for (let i = 0; i < 8; i++) offsets.push(4 + (i % 4) * 24, i < 4 ? 36 : 8);
const offset = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, offset);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(offsets), gl.STATIC_DRAW);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(1, 1);

const color = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, color);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0.9, 0.2, 0.2, 0.2, 0.8, 0.3, 0.2, 0.3, 0.9, 0.9, 0.8, 0.2]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(2);
gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(2, 2);

gl.viewport(0, 0, W, H);
gl.clearColor(0.1, 0.1, 0.15, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(p);
gl.uniform2f(gl.getUniformLocation(p, 'u_res'), W, H);
gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 8);
