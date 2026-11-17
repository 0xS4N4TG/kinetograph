// size: 48 16
// inverse() of a mat2, a mat3 and a mat4 (the Metal back end has none, so the replay writes it out): the entries of each
// inverse are drawn as brightness in three cells, so a wrong sign, a transposition or a wrong cofactor shows.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform mat4 u_m4;
uniform mat3 u_m3;
uniform mat2 u_m2;
out vec4 o;
void main() {
  int cell = int(gl_FragCoord.x / 16.0);
  vec2 q = fract(gl_FragCoord.xy / 16.0);
  float v = 0.0;
  if (cell == 0) { mat2 i = inverse(u_m2); v = i[int(q.x * 2.0)][int(q.y * 2.0)]; }
  else if (cell == 1) { mat3 i = inverse(u_m3); v = i[int(q.x * 3.0)][int(q.y * 3.0)]; }
  else { mat4 i = inverse(u_m4); v = i[int(q.x * 4.0)][int(q.y * 4.0)]; }
  o = vec4(vec3(v * 0.5 + 0.5), 1.0);
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
// Column-major, none symmetric, with a translation.
gl.uniformMatrix2fv(gl.getUniformLocation(p, 'u_m2'), false, [1, 0.5, -0.25, 2]);
gl.uniformMatrix3fv(gl.getUniformLocation(p, 'u_m3'), false, [1, 0.2, 0, -0.3, 1.5, 0.1, 0.4, 0, 2]);
gl.uniformMatrix4fv(gl.getUniformLocation(p, 'u_m4'), false, [1, 0.1, 0, 0, -0.2, 1.2, 0.3, 0, 0, -0.1, 0.9, 0, 0.5, -0.4, 0.3, 1]);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
