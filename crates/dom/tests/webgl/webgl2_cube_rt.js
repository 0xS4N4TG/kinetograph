// size: 96 64
// Cube map faces as render targets (WebGL 2): a 16 x 16 cube from texStorage2D has each face cleared to its own
// colour through a framebuffer, and a gradient square drawn into +X and +Y; the canvas shows the six faces, sampled
// from the cube by direction, in a 3 x 2 grid (+X, -X, +Y on top; -Y, +Z, -Z below).
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
precision mediump float; in vec2 v_uv; uniform samplerCube u_cube; out vec4 o;
void main() {
  vec2 cell = floor(v_uv * vec2(3.0, 2.0));
  vec2 st = (fract(v_uv * vec2(3.0, 2.0)) * 2.0 - 1.0) * 0.8;
  float face = cell.x + (1.0 - cell.y) * 3.0;
  vec3 dir;
  if (face < 0.5) dir = vec3(1.0, -st.y, -st.x);
  else if (face < 1.5) dir = vec3(-1.0, -st.y, st.x);
  else if (face < 2.5) dir = vec3(st.x, 1.0, st.y);
  else if (face < 3.5) dir = vec3(st.x, -1.0, -st.y);
  else if (face < 4.5) dir = vec3(st.x, -st.y, 1.0);
  else dir = vec3(-st.x, -st.y, -1.0);
  o = texture(u_cube, dir);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const cube = gl.createTexture();
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, 16, 16);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

const colors = [[0.9, 0.2, 0.2], [0.2, 0.7, 0.3], [0.2, 0.3, 0.9], [0.9, 0.8, 0.2], [0.7, 0.3, 0.8], [0.2, 0.8, 0.8]];
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.viewport(0, 0, 16, 16);
gl.useProgram(gradient);
gl.uniform1f(gl.getUniformLocation(gradient, 'u_scale'), 0.5);
for (let i = 0; i < 6; i++) {
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cube, 0);
  gl.clearColor(colors[i][0], colors[i][1], colors[i][2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (i === 0 || i === 2) gl.drawArrays(gl.TRIANGLES, 0, 6);
}

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.uniform1f(gl.getUniformLocation(show, 'u_scale'), 1);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.uniform1i(gl.getUniformLocation(show, 'u_cube'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
