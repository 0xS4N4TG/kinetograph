// size: 96 64
// Several colour outputs (WebGL 2): one pass writes a gradient to COLOR_ATTACHMENT0 and its inverse, in stripes, to
// COLOR_ATTACHMENT1 of a 48 x 64 framebuffer; then a draw with drawBuffers([NONE, COLOR_ATTACHMENT1]) paints a
// square into the second only, and the canvas shows the two side by side.
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
const VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv; uniform float u_scale;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos * u_scale, 0.0, 1.0); }`;
const two = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv;
layout(location = 0) out vec4 o_first;
layout(location = 1) out vec4 o_second;
void main() {
  o_first = vec4(v_uv, 0.3, 1.0);
  float stripe = step(0.5, fract(v_uv.y * 4.0));
  o_second = vec4(1.0 - v_uv.x, 1.0 - v_uv.y, stripe, 1.0);
}`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_a; uniform sampler2D u_b; out vec4 o;
void main() {
  vec2 uv = vec2(fract(v_uv.x * 2.0), v_uv.y);
  o = v_uv.x < 0.5 ? texture(u_a, uv) : texture(u_b, uv);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function target() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 48, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}
const a = target();
const b = target();
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
gl.viewport(0, 0, 48, 64);
gl.useProgram(two);
gl.uniform1f(gl.getUniformLocation(two, 'u_scale'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1]);
gl.uniform1f(gl.getUniformLocation(two, 'u_scale'), 0.4);
gl.drawArrays(gl.TRIANGLES, 0, 6);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.uniform1f(gl.getUniformLocation(show, 'u_scale'), 1);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, a);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, b);
gl.uniform1i(gl.getUniformLocation(show, 'u_a'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_b'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
