// size: 96 64
// TEXTURE_BASE_LEVEL (WebGL 2): a 32 x 32 texture of three levels has each level cleared to its own solid colour
// (red, green, blue) through a framebuffer. The left half samples it at base level 0, the right half at base level 1,
// both magnified, so the left is red and the right green; a small copy on the right, minified to 8 pixels with
// NEAREST_MIPMAP_NEAREST and base level 1, reads level 2 and is blue.
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
const show = program(`#version 300 es
in vec2 a_pos; out vec2 v_uv; uniform vec4 u_rect;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(mix(u_rect.xy, u_rect.zw, v_uv), 0.0, 1.0); }`, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const t = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, t);
gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 32, 32);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.bindTexture(gl.TEXTURE_2D, null);
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
const colors = [[0.9, 0.2, 0.2], [0.2, 0.8, 0.3], [0.2, 0.3, 0.9]];
for (let level = 0; level < 3; level++) {
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, level);
  gl.viewport(0, 0, 32 >> level, 32 >> level);
  gl.clearColor(colors[level][0], colors[level][1], colors[level][2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.clearColor(0.1, 0.1, 0.1, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(show);
gl.bindTexture(gl.TEXTURE_2D, t);
gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
const rect = gl.getUniformLocation(show, 'u_rect');
// A rectangle in canvas pixels, from the bottom left.
function at(x, y, w, h) {
  gl.uniform4f(rect, (x / W) * 2 - 1, (y / H) * 2 - 1, ((x + w) / W) * 2 - 1, ((y + h) / H) * 2 - 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
at(0, 0, 48, 64);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 1);
at(48, 16, 48, 48);
at(52, 4, 8, 8);
