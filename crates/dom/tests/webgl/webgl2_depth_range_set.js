// size: 32 16
// A page that narrows depthRange to 0.25..0.5 and draws a depth-tested triangle: the range must not reach a later page.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.2, 0.4, 0.9, 1.0); }`]]) {
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
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.9, 0.9, -0.9, 0.0, 0.9]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clearDepth(1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.enable(gl.DEPTH_TEST);
gl.depthRange(0.25, 0.5);
gl.drawArrays(gl.TRIANGLES, 0, 3);
