// size: 96 64
// An SRGB8_ALPHA8 render target (WebGL 2): a linear gradient drawn into it is stored sRGB-encoded and read back
// linear, so the top half (sampled from the sRGB texture) matches the bottom half (the same gradient through an RGBA8
// texture) except for the rounding of dark values in 8-bit sRGB.
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
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const gradient = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() { o = vec4(v_uv.x, v_uv.x * v_uv.x, 1.0 - v_uv.x, 1.0); }`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_srgb; uniform sampler2D u_plain; out vec4 o;
void main() {
  vec2 uv = vec2(v_uv.x, fract(v_uv.y * 2.0));
  o = v_uv.y >= 0.5 ? texture(u_srgb, uv) : texture(u_plain, uv);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.viewport(0, 0, 96, 32);
gl.useProgram(gradient);
function target(format) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, 96, 32);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return t;
}
const srgb = target(gl.SRGB8_ALPHA8);
const plain = target(gl.RGBA8);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, srgb);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, plain);
gl.uniform1i(gl.getUniformLocation(show, 'u_srgb'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_plain'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
