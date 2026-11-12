// size: 32 32
// A uniform declared as an array of one element is listed as `name[0]` (getActiveUniform), as an array of any length is: a
// library tells a single value from an array by that suffix, and sets an array (a three.js shadow map is `sampler2DShadow m[1]`)
// with the array setter. The page picks the colour by what it finds: green for `[0]`, red for a name without it.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
uniform float u_c[1];
out vec4 o;
void main() { o = vec4(1.0 - u_c[0], u_c[0], 0.0, 1.0); }`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
let listed = '';
for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) listed = gl.getActiveUniform(p, i).name;
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.uniform1fv(gl.getUniformLocation(p, 'u_c[0]'), [listed.endsWith('[0]') ? 1 : 0]);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
