// size: 96 64
// Layers of an array texture and of a 3D texture as framebuffer attachments (WebGL 2, framebufferTextureLayer): each of
// three 16 x 16 layers is cleared to its own colour, and a gradient square is drawn into layers 0 and 2 (layer 1 stays
// the clear colour). The canvas shows the three layers of the array texture on top, and the three of the 3D texture
// below, each read by its own sampler.
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
const gradient = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() { o = vec4(v_uv, 1.0 - v_uv.x, 1.0); }`);
const show = program(VS, `#version 300 es
precision highp float; precision highp sampler3D; precision highp sampler2DArray;
in vec2 v_uv; uniform sampler2DArray u_array; uniform sampler3D u_volume; out vec4 o;
void main() {
  float layer = floor(v_uv.x * 3.0);
  vec2 st = vec2(fract(v_uv.x * 3.0), fract(v_uv.y * 2.0));
  o = v_uv.y > 0.5 ? texture(u_array, vec3(st, layer)) : texture(u_volume, vec3(st, (layer + 0.5) / 3.0));
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function volume(target) {
  const t = gl.createTexture();
  gl.bindTexture(target, t);
  gl.texStorage3D(target, 1, gl.RGBA8, 16, 16, 3);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(target, null);
  return t;
}
const array = volume(gl.TEXTURE_2D_ARRAY);
const solid = volume(gl.TEXTURE_3D);

const colors = [[0.9, 0.2, 0.2], [0.2, 0.7, 0.3], [0.2, 0.3, 0.9]];
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.viewport(0, 0, 16, 16);
gl.useProgram(gradient);
gl.uniform1f(gl.getUniformLocation(gradient, 'u_scale'), 0.5);
for (const texture of [array, solid]) {
  for (let i = 0; i < 3; i++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, i);
    gl.clearColor(colors[i][0], colors[i][1], colors[i][2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (i !== 1) gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.uniform1f(gl.getUniformLocation(show, 'u_scale'), 1);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D_ARRAY, array);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_3D, solid);
gl.uniform1i(gl.getUniformLocation(show, 'u_array'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_volume'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
