// size: 96 64
// R8 and RG8 render targets (WebGL 2): one gradient pass writes (x, y, 1, 1) into an R8 and an RG8 texture, which
// keep one and two channels; the canvas shows them as sampled (green and blue read 0, alpha 1), R8 on the left, RG8
// on the right.
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
void main() { o = vec4(v_uv.x, v_uv.y, 1.0, 1.0); }`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_r; uniform sampler2D u_rg; out vec4 o;
void main() {
  vec2 uv = vec2(fract(v_uv.x * 2.0), v_uv.y);
  o = v_uv.x < 0.5 ? texture(u_r, uv) : texture(u_rg, uv);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.viewport(0, 0, 48, 64);
gl.useProgram(gradient);
function target(format, base) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, format, 48, 64, 0, base, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return t;
}
const r = target(gl.R8, gl.RED);
const rg = target(gl.RG8, gl.RG);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, r);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, rg);
gl.uniform1i(gl.getUniformLocation(show, 'u_r'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_rg'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
