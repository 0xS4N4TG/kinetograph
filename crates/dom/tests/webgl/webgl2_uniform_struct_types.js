// size: 48 16
// Struct uniforms with int, uint, ivec and mat3 fields, and one the page also constructs. Each third shows values read
// from a struct whose std140 size is more than its fields': an array of `S { vec3; int; vec2 }` (24 bytes, 32 in
// std140), `M { mat3; uvec2; ivec3 }` (76 bytes, 80), and `L { vec3; vec3 }` (28 bytes, 32), which `L(...)` also
// builds in the shader, followed by a float. A layout that skips the padding of a struct with an int field reads
// everything after it from the wrong place; padding inside `L` itself would break the constructor.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos; out vec2 v_pos;
void main() { v_pos = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
struct S { vec3 a; int k; vec2 b; };
struct M { mat3 m; uvec2 u; ivec3 iv; };
struct L { vec3 p; vec3 q; };
uniform S u_s[2];
uniform M u_m;
uniform L u_l;
uniform float u_after;
in vec2 v_pos;
out vec4 o;
void main() {
  float third = v_pos.x * 0.5 + 0.5;
  L made = L(u_l.p, vec3(0.0));
  vec3 c = third < 0.34 ? vec3(u_s[1].a.x, float(u_s[1].k) / 10.0, u_s[1].b.y)
    : third < 0.67 ? vec3(u_m.m[1][1], float(u_m.u.y) / 10.0, float(u_m.iv.z) / 10.0)
    : vec3(made.p.x, u_after, u_l.q.z);
  o = vec4(c, 1.0);
}`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
gl.uniform3f(gl.getUniformLocation(p, 'u_s[1].a'), 0.75, 0, 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_s[1].k'), 5);
gl.uniform2f(gl.getUniformLocation(p, 'u_s[1].b'), 0, 0.5);
gl.uniformMatrix3fv(gl.getUniformLocation(p, 'u_m.m'), false, [0, 0, 0, 0, 0.25, 0, 0, 0, 0]);
gl.uniform2ui(gl.getUniformLocation(p, 'u_m.u'), 0, 7);
gl.uniform3i(gl.getUniformLocation(p, 'u_m.iv'), 0, 0, 3);
gl.uniform3f(gl.getUniformLocation(p, 'u_l.p'), 0.5, 0, 0);
gl.uniform3f(gl.getUniformLocation(p, 'u_l.q'), 0, 0, 0.9);
gl.uniform1f(gl.getUniformLocation(p, 'u_after'), 0.4);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
