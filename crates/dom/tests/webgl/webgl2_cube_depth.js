// size: 96 64
// A depth cube map (WebGL 2), as a point light's shadow map is made: a 16 x 16 DEPTH_COMPONENT24 cube from
// texStorage2D has each face cleared to 1 and a quad of its own depth drawn in a box of it, through a framebuffer with
// that face as its depth attachment. The canvas shows the six faces in a 3 x 2 grid (+X, -X, +Y on top; -Y, +Z, -Z
// below), each the result of a samplerCubeShadow comparison against 0.5, so a box shows as black where it is nearer.
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
in vec2 a_pos; out vec2 v_uv; uniform float u_scale; uniform float u_depth;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos * u_scale, u_depth * 2.0 - 1.0, 1.0); }`;
const fill = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() { o = vec4(1.0); }`);
const show = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform highp samplerCubeShadow u_cube; out vec4 o;
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
  o = vec4(vec3(texture(u_cube, vec4(dir, 0.5))), 1.0);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const cube = gl.createTexture();
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.DEPTH_COMPONENT24, 16, 16);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.drawBuffers([gl.NONE]);
gl.viewport(0, 0, 16, 16);
gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LESS);
gl.useProgram(fill);
gl.uniform1f(gl.getUniformLocation(fill, 'u_scale'), 0.5);
for (let i = 0; i < 6; i++) {
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cube, 0);
  gl.clearDepth(1);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  // The depths 0.15 to 0.85 are either side of the 0.5 the comparison uses.
  gl.uniform1f(gl.getUniformLocation(fill, 'u_depth'), 0.15 + 0.14 * i);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

gl.disable(gl.DEPTH_TEST);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.uniform1f(gl.getUniformLocation(show, 'u_scale'), 1);
gl.uniform1f(gl.getUniformLocation(show, 'u_depth'), 0.5);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.uniform1i(gl.getUniformLocation(show, 'u_cube'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
