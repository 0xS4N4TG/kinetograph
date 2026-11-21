// size: 64 32
// Integer textures made by storage and updated in parts (WebGL 2): an R8UI texture (4 x 4) from texStorage2D, then texSubImage2D of the
// whole of it and of a 2 x 2 window of an array with UNPACK_ROW_LENGTH and the skips; an RGBA8UI 2D array (2 x 2, 2 layers) from texImage3D,
// then a layer written by texSubImage3D. Read with texelFetch through usampler2D and usampler2DArray.
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
const p = program(`#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`, `#version 300 es
precision highp float; precision highp int; precision highp usampler2D; precision highp usampler2DArray;
in vec2 v_uv; uniform usampler2D u_grid; uniform usampler2DArray u_layers; out vec4 o;
void main() {
  if (v_uv.x < 0.5) {
    uint id = texelFetch(u_grid, ivec2(floor(vec2(v_uv.x * 2.0, v_uv.y) * 3.999)), 0).r;
    o = vec4(float(id) / 255.0, float(id & 15u) / 15.0, 0.25, 1.0);
  } else {
    uvec4 t = texelFetch(u_layers, ivec3(floor(vec2((v_uv.x - 0.5) * 2.0, fract(v_uv.y * 2.0)) * 1.999), int(v_uv.y * 2.0)), 0);
    o = vec4(t) / 255.0;
  }
}`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function filters(target) {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}
const grid = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, grid);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, 4, 4);
filters(gl.TEXTURE_2D);
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, 4, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]));
// A 2 x 2 window of rows 4 texels long, starting at the second texel of the second row, into (1, 1).
const source = new Uint8Array(16).map((_, i) => 200 + i);
gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 4);
gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 1);
gl.texSubImage2D(gl.TEXTURE_2D, 0, 1, 1, 2, 2, gl.RED_INTEGER, gl.UNSIGNED_BYTE, source);
gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);

const layers = gl.createTexture();
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D_ARRAY, layers);
gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8UI, 2, 2, 2, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  0, 0, 0, 255, 90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255,
]));
filters(gl.TEXTURE_2D_ARRAY);
gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 1, 2, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([255, 128, 0, 255, 0, 128, 255, 255]));

gl.useProgram(p);
gl.uniform1i(gl.getUniformLocation(p, 'u_grid'), 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_layers'), 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
