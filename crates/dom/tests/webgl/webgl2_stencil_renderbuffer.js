// size: 32 16
// A colour texture with a single-sample STENCIL_INDEX8 renderbuffer as the framebuffer's stencil: a triangle is written to
// the stencil, then a red quad is drawn only where the stencil is 1, and the canvas shows the texture. Asking GL for one
// sample of a stencil renderbuffer gets a multisampled one, which makes the framebuffer incomplete.
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
const solid = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() { o = vec4(0.9, 0.1, 0.1, 1.0); }`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1, -0.8, -0.8, 0.8, -0.8, 0.0, 0.8]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
const rb = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, 32, 16);
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
gl.viewport(0, 0, 32, 16);
gl.clearColor(0.1, 0.1, 0.3, 1);
gl.clearStencil(0);
gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
gl.enable(gl.STENCIL_TEST);
gl.useProgram(solid);
gl.colorMask(false, false, false, false);
gl.stencilFunc(gl.ALWAYS, 1, 0xff);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
gl.drawArrays(gl.TRIANGLES, 6, 3);
gl.colorMask(true, true, true, true);
gl.stencilFunc(gl.EQUAL, 1, 0xff);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.disable(gl.STENCIL_TEST);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
