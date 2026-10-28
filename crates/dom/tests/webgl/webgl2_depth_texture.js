// size: 96 64
// A depth texture (WebGL 2), as a shadow map is made: two tilted quads that cross are drawn with the depth test into
// a framebuffer whose depth attachment is a DEPTH_COMPONENT24 texture; the canvas shows the colour on the left and
// the depth, sampled as (d, 0, 0, 1), on the right.
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
const scene = program(`#version 300 es
in vec3 a_pos;
void main() { gl_Position = vec4(a_pos, 1.0); }`, `#version 300 es
precision mediump float; uniform vec4 u_color; out vec4 o;
void main() { o = u_color; }`);
const show = program(`#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`, `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_color; uniform highp sampler2D u_depth; out vec4 o;
void main() {
  vec2 uv = vec2(fract(v_uv.x * 2.0), v_uv.y);
  o = v_uv.x < 0.5 ? texture(u_color, uv) : texture(u_depth, uv);
}`);

// Two quads, each tilted in depth the other way, so they cross halfway.
const quads = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quads);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -0.9, -0.8, -0.6, 0.6, -0.8, 0.6, -0.9, 0.5, -0.6, -0.9, 0.5, -0.6, 0.6, -0.8, 0.6, 0.6, 0.5, 0.6,
  -0.6, -0.5, 0.7, 0.9, -0.5, -0.7, -0.6, 0.8, 0.7, -0.6, 0.8, 0.7, 0.9, -0.5, -0.7, 0.9, 0.8, -0.7,
]), gl.STATIC_DRAW);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);

function texture(internalformat, format, type) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalformat, 48, 64, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return t;
}
const colour = texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
const depth = texture(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
gl.viewport(0, 0, 48, 64);
gl.clearColor(0.1, 0.1, 0.15, 1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.enable(gl.DEPTH_TEST);
gl.useProgram(scene);
gl.bindBuffer(gl.ARRAY_BUFFER, quads);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
const color = gl.getUniformLocation(scene, 'u_color');
gl.uniform4f(color, 0.95, 0.6, 0.2, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.uniform4f(color, 0.2, 0.6, 0.95, 1);
gl.drawArrays(gl.TRIANGLES, 6, 6);
gl.disable(gl.DEPTH_TEST);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, colour);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, depth);
gl.uniform1i(gl.getUniformLocation(show, 'u_color'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_depth'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
