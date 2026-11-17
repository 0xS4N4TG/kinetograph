// size: 32 16
// A mat3 and a mat4 passed from the vertex shader to the fragment shader (webgl_volume_instancing does): the hand-written
// translator refuses a matrix as a varying, and the recording must still load when ANGLE draws it.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
out mat3 v_m3;
out mat4 v_m4;
void main() {
  v_m3 = mat3(0.2, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.8);
  v_m4 = mat4(1.0);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in mat3 v_m3;
in mat4 v_m4;
out vec4 o;
void main() { o = vec4(v_m3[0][0], v_m3[1][1], v_m3[2][2] * v_m4[3][3], 1.0); }`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
