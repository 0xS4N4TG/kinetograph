// size: 128 64
// texSubImage2D into immutable storage (texStorage2D) written level by level (WebGL 2): a 2D texture whose level 0 is a window of a
// larger pixel array (UNPACK_ROW_LENGTH, UNPACK_SKIP_PIXELS, UNPACK_SKIP_ROWS) and whose levels above 0 are written in two
// rectangles; and a cube map whose faces are written whole at every level, then a rectangle of +X at level 0 and one at level 1.
// The top row shows the 2D levels 0 to 3 (textureLod); the bottom row +X at levels 0, 1, 2 and -Z at level 1.
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
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform samplerCube u_cube; out vec4 o;
void main() {
  vec2 cell = floor(v_uv * vec2(4.0, 2.0));
  vec2 st = fract(v_uv * vec2(4.0, 2.0));
  if (cell.y > 0.5) { o = vec4(textureLod(u_tex, st, cell.x).rgb, 1.0); return; }
  vec2 s = st * 2.0 - 1.0;
  if (cell.x < 2.5) o = vec4(textureLod(u_cube, vec3(1.0, -s.y, -s.x), cell.x).rgb, 1.0);
  else o = vec4(textureLod(u_cube, vec3(s.x, -s.y, -1.0), 1.0).rgb, 1.0);
}`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function solid(width, height, [r, g, b]) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) out.set([r, g, b, 255], i * 4);
  return out;
}

// The 2D texture: 8 x 8, four levels.
const tex = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texStorage2D(gl.TEXTURE_2D, 4, gl.RGBA8, 8, 8);
const source = new Uint8Array(10 * 9 * 4);
for (let y = 0; y < 9; y++) for (let x = 0; x < 10; x++) source.set([x * 25, y * 28, 128, 255], (y * 10 + x) * 4);
gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 10);
gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 2);
gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 1);
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, source);
gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
gl.texSubImage2D(gl.TEXTURE_2D, 1, 0, 0, 2, 4, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 4, [230, 60, 40]));
gl.texSubImage2D(gl.TEXTURE_2D, 1, 2, 0, 2, 4, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 4, [40, 200, 90]));
gl.texSubImage2D(gl.TEXTURE_2D, 2, 0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 2, [60, 90, 240]));
gl.texSubImage2D(gl.TEXTURE_2D, 3, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, solid(1, 1, [240, 220, 40]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

// The cube map: 4 x 4 faces, three levels.
const cube = gl.createTexture();
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 3, gl.RGBA8, 4, 4);
const colors = [[230, 60, 60], [60, 200, 90], [70, 100, 240], [230, 210, 60], [200, 70, 220], [60, 210, 210]];
for (let f = 0; f < 6; f++) {
  const target = gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, [r, g, b] = colors[f];
  gl.texSubImage2D(target, 0, 0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, solid(4, 4, [r, g, b]));
  gl.texSubImage2D(target, 1, 0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 2, [r * 0.6, g * 0.6, b * 0.6]));
  gl.texSubImage2D(target, 2, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, solid(1, 1, [r * 0.3, g * 0.3, b * 0.3]));
}
gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X, 0, 1, 1, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 2, [255, 255, 255]));
gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X, 1, 1, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, solid(1, 2, [20, 20, 20]));
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

gl.useProgram(show);
gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
gl.uniform1i(gl.getUniformLocation(show, 'u_cube'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
