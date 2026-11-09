// size: 96 64
// attributes: {"antialias": false}
// blitFramebuffer of float targets (WebGL 2, EXT_color_buffer_float): a gradient from 0 to 4 is drawn into an RGBA16F
// renderbuffer. Its left half is blitted to the canvas, which clamps it to 1; its right half is blitted into an
// RGBA16F texture, which keeps the values, and the canvas shows that texture divided by 4. Without the extension the
// case draws nothing.
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
if (gl.getExtension('EXT_color_buffer_float')) {
  const VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
  const hdr = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
void main() { o = vec4(v_uv.y * 4.0, v_uv.x * 2.0, 0.5, 1.0); }`);
  const show = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb / 4.0, 1.0); }`);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA16F, W, H);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  gl.viewport(0, 0, W, H);
  gl.useProgram(hdr);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 48, 64);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const floatFb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, floatFb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, floatFb);
  gl.blitFramebuffer(48, 0, 96, 64, 0, 0, 48, 64, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(0, 0, 48, 64, 0, 0, 48, 64, gl.COLOR_BUFFER_BIT, gl.NEAREST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(48, 0, 48, 64);
  gl.useProgram(show);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
