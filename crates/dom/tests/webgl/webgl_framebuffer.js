// size: 96 64
// Render to texture: a gradient from gl_FragCoord is drawn into a 48 x 32 texture, a second pass reads it into another
// texture and inverts its lower-left triangle, and the canvas shows the two side by side.
function program(fs) {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, 'attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }'],
    [gl.FRAGMENT_SHADER, fs],
  ]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  return p;
}
const gradient = program(`precision mediump float;
  uniform vec2 u_size;
  void main() { gl_FragColor = vec4(gl_FragCoord.x / u_size.x, gl_FragCoord.y / u_size.y, 0.25, 1.0); }`);
const mark = program(`precision mediump float;
  varying vec2 v_uv; uniform sampler2D u_tex;
  void main() {
    vec4 c = texture2D(u_tex, v_uv);
    gl_FragColor = v_uv.x + v_uv.y < 0.5 ? vec4(1.0 - c.rgb, 1.0) : vec4(c.rgb * 0.6, 1.0);
  }`);
const show = program(`precision mediump float;
  varying vec2 v_uv; uniform sampler2D u_a; uniform sampler2D u_b;
  void main() {
    vec2 uv = vec2(fract(v_uv.x * 2.0), v_uv.y);
    gl_FragColor = v_uv.x < 0.5 ? texture2D(u_a, uv) : texture2D(u_b, uv);
  }`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function target(width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { tex, fb };
}
const a = target(48, 32);
const b = target(48, 32);

gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
gl.viewport(0, 0, 48, 32);
gl.useProgram(gradient);
gl.uniform2f(gl.getUniformLocation(gradient, 'u_size'), 48, 32);
gl.drawArrays(gl.TRIANGLES, 0, 6);

gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
gl.useProgram(mark);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, a.tex);
gl.uniform1i(gl.getUniformLocation(mark, 'u_tex'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, b.tex);
gl.uniform1i(gl.getUniformLocation(show, 'u_a'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_b'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
