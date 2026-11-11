// size: 48 16
// Uniforms that come after structs in the default uniform block: an array of a struct of one float (4 bytes, a
// std140 element is 16), a struct of four floats and a vec2 (24 bytes, 32 in std140), then a bool and a float. Each
// of the three squares shows one of the values read after the structs: the bool (red), the float (green) and the
// last element of the array (blue). A back end that sizes a struct by its fields reads them from the wrong place.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos; out vec2 v_pos;
void main() { v_pos = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
struct One { float a; };
struct Shadow { float intensity; float bias; float normalBias; float radius; vec2 size; };
uniform One u_one[2];
uniform Shadow u_shadow;
uniform bool u_on;
uniform float u_k;
in vec2 v_pos;
out vec4 o;
void main() {
  float third = v_pos.x * 0.5 + 0.5;
  vec3 c = third < 0.34 ? vec3(u_on ? 1.0 : 0.0, 0.0, 0.0) : third < 0.67 ? vec3(0.0, u_k, 0.0) : vec3(0.0, 0.0, u_one[1].a);
  o = vec4(c + vec3(u_shadow.size.y * 0.0), 1.0);
}`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
gl.uniform1f(gl.getUniformLocation(p, 'u_one[0].a'), 0.25);
gl.uniform1f(gl.getUniformLocation(p, 'u_one[1].a'), 0.75);
gl.uniform1f(gl.getUniformLocation(p, 'u_shadow.intensity'), 1);
gl.uniform2f(gl.getUniformLocation(p, 'u_shadow.size'), 512, 512);
gl.uniform1i(gl.getUniformLocation(p, 'u_on'), 1);
gl.uniform1f(gl.getUniformLocation(p, 'u_k'), 0.5);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
