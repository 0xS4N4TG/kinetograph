// size: 96 64
// EXT_float_blend (WebGL 2): four soft blobs are added with blendFunc(ONE, ONE) into an RGBA32F texture, where they
// overlap past 1.0; the canvas shows the texture divided by 4, so the overlaps are brighter rather than clamped.
// Without EXT_color_buffer_float and EXT_float_blend the case draws nothing.
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
if (gl.getExtension('EXT_color_buffer_float') && gl.getExtension('EXT_float_blend')) {
  const VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
  const blob = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform vec2 u_center; out vec4 o;
void main() {
  vec2 d = (v_uv - u_center) * vec2(1.5, 1.0);
  o = vec4(vec3(2.0, 1.2, 0.6) * exp(-dot(d, d) * 12.0), 1.0);
}`);
  const show = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb / 4.0, 1.0); }`);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.useProgram(blob);
  const center = gl.getUniformLocation(blob, 'u_center');
  for (const [x, y] of [[0.35, 0.4], [0.55, 0.45], [0.45, 0.65], [0.65, 0.6]]) {
    gl.uniform2f(center, x, y);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(show);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
