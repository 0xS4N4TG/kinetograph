// size: 32 16
// The winding a draw has is its own: a draw with culling on and frontFace(CW) comes first (a clockwise triangle, blue,
// on top), then culling goes off and frontFace(CCW) is set again, and gl_FrontFacing colours the counter-clockwise
// triangle green and the clockwise one red below. A replay that carried the clockwise winding over would swap them.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
uniform float u_blue;
out vec4 o;
void main() { o = u_blue > 0.5 ? vec4(0.1, 0.2, 0.9, 1.0) : gl_FrontFacing ? vec4(0.1, 0.8, 0.2, 1.0) : vec4(0.9, 0.1, 0.1, 1.0); }`]]) {
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
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  // top, clockwise
  -0.9, 0.1, 0.0, 0.9, 0.9, 0.1,
  // bottom left, counter-clockwise; bottom right, clockwise
  -0.9, -0.9, -0.1, -0.9, -0.5, -0.1,
  0.1, -0.9, 0.5, -0.1, 0.9, -0.9,
]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
const blue = gl.getUniformLocation(p, 'u_blue');
gl.enable(gl.CULL_FACE);
gl.cullFace(gl.BACK);
gl.frontFace(gl.CW);
gl.uniform1f(blue, 1);
gl.drawArrays(gl.TRIANGLES, 0, 3);
gl.disable(gl.CULL_FACE);
gl.frontFace(gl.CCW);
gl.uniform1f(blue, 0);
gl.drawArrays(gl.TRIANGLES, 3, 6);
