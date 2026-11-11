// size: 96 64
// copyTexImage2D and copyTexSubImage2D (WebGL 2): a 48 x 64 framebuffer texture gets a gradient with a white square;
// copyTexImage2D copies the whole of it into one texture, and copyTexSubImage2D copies its top-left 24 x 32 quarter
// into the bottom-right of a second texture cleared to dark green. The canvas shows the first on the left, the second
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
const draw = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() {
  vec3 c = vec3(v_uv.x, v_uv.y, 0.6);
  if (abs(v_uv.x - 0.3) < 0.12 && abs(v_uv.y - 0.7) < 0.1) c = vec3(1.0);
  o = vec4(c, 1.0);
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

function texture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 48, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const source = texture();
const b = texture();
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b, 0);
gl.viewport(0, 0, 48, 64);
gl.clearColor(0.1, 0.3, 0.15, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, source, 0);
gl.useProgram(draw);
gl.drawArrays(gl.TRIANGLES, 0, 6);

const a = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, a);
gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, 48, 64, 0);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.bindTexture(gl.TEXTURE_2D, b);
gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 24, 0, 0, 32, 24, 32);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, a);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, b);
gl.uniform1i(gl.getUniformLocation(show, 'u_a'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_b'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
