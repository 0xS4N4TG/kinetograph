// size: 96 48
// Render targets in the mip levels of a cube map's faces (WebGL 2), as a PMREM generator makes them: every face has
// levels 0 to 2 (4, 2 and 1 texels), each level of each face is drawn in a solid colour of its own, and the canvas reads
// them back with textureLod: one column for each face, one row for each level.
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
const fill = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform vec3 u_color; out vec4 o;
void main() { o = vec4(u_color, 1.0); }`);
const show = program(VS, `#version 300 es
precision highp float; in vec2 v_uv; uniform samplerCube u_cube; out vec4 o;
void main() {
  vec3 dirs[6] = vec3[6](vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
  int face = int(v_uv.x * 6.0);
  float level = floor((1.0 - v_uv.y) * 3.0);
  o = vec4(textureLod(u_cube, dirs[face], level).rgb, 1.0);
}`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const cube = gl.createTexture();
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
for (let face = 0; face < 6; face += 1) {
  for (let level = 0; level < 3; level += 1) {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, level, gl.RGBA8, 4 >> level, 4 >> level, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
}
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.useProgram(fill);
const bases = [[1, 0.2, 0.2], [0.2, 1, 0.2], [0.2, 0.2, 1], [1, 1, 0.2], [1, 0.2, 1], [0.2, 1, 1]];
for (let level = 0; level < 3; level += 1) {
  for (let face = 0; face < 6; face += 1) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, cube, level);
    gl.viewport(0, 0, 4 >> level, 4 >> level);
    const k = 1 - level * 0.3;
    gl.uniform3f(gl.getUniformLocation(fill, 'u_color'), bases[face][0] * k, bases[face][1] * k, bases[face][2] * k);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.uniform1i(gl.getUniformLocation(show, 'u_cube'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
