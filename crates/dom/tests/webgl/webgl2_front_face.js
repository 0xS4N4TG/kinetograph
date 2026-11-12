// size: 32 16
// gl_FrontFacing with culling off and frontFace(CW): the left triangle is wound counter-clockwise and the right one
// clockwise, and the fragment shader colours a front face green and a back face red. With CW as the front the left
// one is red and the right one green; the recording must keep the frontFace call although nothing is culled.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = gl_FrontFacing ? vec4(0.1, 0.8, 0.2, 1.0) : vec4(0.9, 0.1, 0.1, 1.0); }`]]) {
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
  -0.9, -0.9, -0.1, -0.9, -0.5, 0.9,
  0.1, -0.9, 0.5, 0.9, 0.9, -0.9,
]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.frontFace(gl.CW);
gl.drawArrays(gl.TRIANGLES, 0, 6);
