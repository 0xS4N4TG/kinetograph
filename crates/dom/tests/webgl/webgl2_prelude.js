// size: 96 64
// The prelude a library gives every shader (WebGL 2): GL_ES and defined() decide which branch is read, and a branch
// that is left out holds a #define and an #error that must not take effect. The tint comes from a macro chosen by
// an #if with defined(), && and ||.
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  return p;
}
const PRELUDE = `
#ifdef GL_ES
precision highp float;
#else
#if !defined(lowp)
#define lowp
#endif
#define BROKEN 1
#endif
#define K 2
#if defined(K) && K > 1 || defined(NOPE)
#define TINT vec3(1.0, 0.5, 0.25)
#else
#define TINT vec3(0.0)
#endif
#ifdef NOPE
#error not read
#endif
`;
const p = program(`#version 300 es${PRELUDE}
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`, `#version 300 es${PRELUDE}
in vec2 v_uv; out vec4 o;
#ifdef BROKEN
uniform missing;
#endif
void main() { o = vec4(TINT * vec3(v_uv, 1.0), 1.0); }`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.useProgram(p);
gl.drawArrays(gl.TRIANGLES, 0, 6);
