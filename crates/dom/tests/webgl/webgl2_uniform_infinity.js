// size: 32 32
// A uniform set to Infinity (three.js sets a transmissive material's attenuationDistance to it, and its shader asks
// isinf): the recording is JSON, which has no infinity, so the replay has to read one back. Green where isinf is true,
// red where it is not (the left half is a finite uniform, the right half the infinite one).
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform float u_finite;
uniform float u_far;
out vec4 o;
void main() {
  float v = gl_FragCoord.x < 16.0 ? u_finite : u_far;
  o = isinf(v) ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);
}`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.uniform1f(gl.getUniformLocation(p, 'u_finite'), 3.0);
gl.uniform1f(gl.getUniformLocation(p, 'u_far'), Infinity);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
