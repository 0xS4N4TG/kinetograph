// size: 128 64
// texSubImage2D and texImage2D from ImageData into levels above 0, with the unpack state of pictures (WebGL 2): UNPACK_FLIP_Y_WEBGL,
// UNPACK_PREMULTIPLY_ALPHA_WEBGL, a window of the source (UNPACK_SKIP_PIXELS, UNPACK_SKIP_ROWS), and a rectangle given with the
// width and height overload; part of a cube face from a picture; a level made by texImage2D after level 0 was one picture; and
// texSubImage3D of level 1 of a 3D texture from an array. Each cell of the 4 x 2 grid shows one of them (textureLod, NEAREST).
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
precision highp float; in vec2 v_uv;
uniform sampler2D u_a, u_b, u_c, u_e; uniform samplerCube u_cube; uniform highp sampler3D u_volume; out vec4 o;
void main() {
  vec2 cell = floor(v_uv * vec2(4.0, 2.0));
  vec2 st = fract(v_uv * vec2(4.0, 2.0));
  int i = int(cell.x) + 4 * int(cell.y);
  if (i == 0) o = vec4(textureLod(u_a, st, 1.0).rgb, 1.0);
  else if (i == 1) o = vec4(textureLod(u_b, st, 1.0).rgb, 1.0);
  else if (i == 2) o = vec4(textureLod(u_c, st, 2.0).rgb, 1.0);
  else if (i == 3) o = vec4(textureLod(u_e, st, 1.0).rgb, 1.0);
  else if (i == 4) { vec2 s = st * 2.0 - 1.0; o = vec4(textureLod(u_cube, vec3(1.0, -s.y, -s.x), 0.0).rgb, 1.0); }
  else if (i == 5) o = vec4(textureLod(u_volume, vec3(st, 0.25), 1.0).rgb, 1.0);
  else if (i == 6) o = vec4(textureLod(u_c, st, 1.0).rgb, 1.0);
  else o = vec4(0.0, 0.0, 0.0, 1.0);
}`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function gradient(width, height, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x * 60 + 20, y * 60 + 20, 200 - x * 30, alpha], (y * width + x) * 4);
  return new ImageData(data, width, height);
}
function solid(width, height, [r, g, b, a = 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4);
  return data;
}
function filters(target) {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}
function made(unit, target, make) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, t);
  make();
  filters(target);
  return t;
}

// A: level 1 from a 2 x 2 picture, turned over.
made(0, gl.TEXTURE_2D, () => {
  gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 4, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texSubImage2D(gl.TEXTURE_2D, 1, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, gradient(2, 2));
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
});
// B: a 2 x 2 window of a 4 x 3 picture, from its second texel of its second row, into the second row of level 1 of a 4 x 4 level.
made(1, gl.TEXTURE_2D, () => {
  gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 8, 8);
  gl.texSubImage2D(gl.TEXTURE_2D, 1, 0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, solid(4, 4, [30, 30, 30]));
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 1, 1, 2, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, gradient(4, 3));
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
});
// C: level 1 from a half-transparent picture, level 2 from half-transparent pixels, the colour multiplied by the alpha in both.
made(2, gl.TEXTURE_2D, () => {
  gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA8, 4, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texSubImage2D(gl.TEXTURE_2D, 1, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, gradient(2, 2, 128));
  gl.texSubImage2D(gl.TEXTURE_2D, 2, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, solid(1, 1, [200, 100, 50, 128]));
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
});
// E: level 0 one picture, level 1 another by texImage2D (a chain written level by level, without storage).
made(3, gl.TEXTURE_2D, () => {
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gradient(4, 4));
  gl.texImage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, solid(2, 2, [250, 220, 40]));
  gl.texImage2D(gl.TEXTURE_2D, 2, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gradient(1, 1));
});
// The cube: the faces written whole, then a 2 x 2 picture into the middle of +X.
made(4, gl.TEXTURE_CUBE_MAP, () => {
  gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, 4, 4);
  for (let f = 0; f < 6; f++) gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, 0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, solid(4, 4, [40 * f + 30, 90, 200 - 30 * f]));
  gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, gradient(2, 2));
});
// A 3D texture of 4 x 4 x 4 and two levels, level 1 (2 x 2 x 2) written by an array.
made(5, gl.TEXTURE_3D, () => {
  gl.texStorage3D(gl.TEXTURE_3D, 2, gl.RGBA8, 4, 4, 4);
  const level = new Uint8Array(2 * 2 * 2 * 4);
  for (let i = 0; i < 8; i++) level.set([i * 30 + 10, 255 - i * 30, 100, 255], i * 4);
  gl.texSubImage3D(gl.TEXTURE_3D, 1, 0, 0, 0, 2, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, level);
});

gl.useProgram(show);
['u_a', 'u_b', 'u_c', 'u_e', 'u_cube', 'u_volume'].forEach((name, unit) => gl.uniform1i(gl.getUniformLocation(show, name), unit));
gl.drawArrays(gl.TRIANGLES, 0, 6);
