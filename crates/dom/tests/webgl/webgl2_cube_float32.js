// size: 96 64
// A cube map of float faces uploaded from pixels (WebGL 2, RGBA32F, FLOAT): six 4 x 4 faces, each a gradient of its own colour
// with values above 1 (HDR), uploaded by texImage2D on the six face targets and sampled by direction with LINEAR. The
// canvas shows the faces in a 3 x 2 grid (+X, -X, +Y on top; -Y, +Z, -Z below), the values halved. OES_texture_float_linear is on.
gl.getExtension('OES_texture_float_linear');
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
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`, `#version 300 es
precision highp float; in vec2 v_uv; uniform samplerCube u_cube; out vec4 o;
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
  o = vec4(texture(u_cube, dir).rgb * 0.5, 1.0);
}`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const colors = [[1.8, 0.3, 0.3], [0.3, 1.4, 0.4], [0.3, 0.4, 1.9], [1.7, 1.5, 0.2], [1.3, 0.4, 1.6], [0.3, 1.6, 1.6]];
const cube = gl.createTexture();
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
for (let i = 0; i < 6; i++) {
  const data = new Float32Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const k = (y * 4 + x) * 4, g = 0.4 + 0.2 * (x + y);
    data[k] = colors[i][0] * g * 0.5; data[k + 1] = colors[i][1] * g * 0.5; data[k + 2] = colors[i][2] * g * 0.5; data[k + 3] = 1;
  }
  gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA32F, 4, 4, 0, gl.RGBA, gl.FLOAT, data);
}
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.uniform1i(gl.getUniformLocation(show, 'u_cube'), 0);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
