// size: 96 64
// attributes: {"stencil": true, "antialias": false}
// Renderbuffers and blitFramebuffer of colour, depth and stencil (WebGL 2): a framebuffer of an RGBA8 renderbuffer
// and a DEPTH24_STENCIL8 one gets a tilted quad (depth) with stencil 1 under it; all three are blitted to the
// canvas, where a flat quad halfway in depth shows only where it is in front and the stencil is 1. A texture's level
// 1 is drawn into and shown at that level in the corner.
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
const flat = program(`#version 300 es
in vec3 a_pos;
void main() { gl_Position = vec4(a_pos, 1.0); }`, `#version 300 es
precision mediump float; uniform vec4 u_color; out vec4 o;
void main() { o = u_color; }`);
const lod = program(`#version 300 es
in vec3 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos.xy * 0.5 + 0.5; gl_Position = vec4(a_pos.xy * 0.3 + vec2(0.7, 0.7), 0.0, 1.0); }`, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = textureLod(u_tex, v_uv, 1.0); }`);

const tilted = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, tilted);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, -0.9, 0.8, -0.8, 0.9, -0.8, 0.8, -0.9, -0.8, 0.8, -0.9, 0.8, -0.8, 0.9, 0.8, 0.8, 0.9]), gl.STATIC_DRAW);
const level = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, level);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);

function renderbuffer(format) {
  const r = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, r);
  gl.renderbufferStorage(gl.RENDERBUFFER, format, W, H);
  return r;
}
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer(gl.RGBA8));
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, renderbuffer(gl.DEPTH24_STENCIL8));
gl.viewport(0, 0, W, H);
gl.clearColor(0.15, 0.1, 0.2, 1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
gl.enable(gl.DEPTH_TEST);
gl.enable(gl.STENCIL_TEST);
gl.stencilFunc(gl.ALWAYS, 1, 0xff);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
gl.useProgram(flat);
gl.bindBuffer(gl.ARRAY_BUFFER, tilted);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
const color = gl.getUniformLocation(flat, 'u_color');
gl.uniform4f(color, 0.9, 0.3, 0.3, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);

gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT, gl.NEAREST);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);

// A flat quad halfway in depth, kept by the copied depth and stencil.
gl.stencilFunc(gl.EQUAL, 1, 0xff);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
gl.bindBuffer(gl.ARRAY_BUFFER, level);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
gl.uniform4f(color, 0.3, 0.9, 0.4, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.disable(gl.STENCIL_TEST);
gl.disable(gl.DEPTH_TEST);

// Level 1 of a 32 x 32 texture, drawn in and shown at that level.
const t = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, t);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texImage2D(gl.TEXTURE_2D, 1, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 1);
gl.bindTexture(gl.TEXTURE_2D, null);
const levelFb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, levelFb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 1);
gl.viewport(0, 0, 16, 16);
gl.clearColor(0.95, 0.85, 0.2, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(lod);
gl.bindTexture(gl.TEXTURE_2D, t);
gl.uniform1i(gl.getUniformLocation(lod, 'u_tex'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
