// size: 64 16
// Compressed textures (WebGL 2, WEBGL_compressed_texture_s3tc): compressedTexImage2D of an 8 x 8 DXT1 image of four colour blocks, a
// texStorage2D DXT1 texture of two levels written by compressedTexSubImage2D (a block replaced after), and a DXT5 block with alpha.
// Where the extension is missing (the replay cannot take it on this machine) the page paints magenta, as three.js would fall back.
const ext = gl.getExtension('WEBGL_compressed_texture_s3tc');
if (!ext) {
  gl.clearColor(1, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
} else {
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
precision highp float; in vec2 v_uv; uniform sampler2D u_a, u_b, u_c; out vec4 o;
void main() {
  float cell = floor(v_uv.x * 4.0);
  vec2 st = vec2(fract(v_uv.x * 4.0), v_uv.y);
  if (cell < 0.5) o = vec4(textureLod(u_a, st, 0.0).rgb, 1.0);
  else if (cell < 1.5) o = vec4(textureLod(u_b, st, 0.0).rgb, 1.0);
  else if (cell < 2.5) o = vec4(textureLod(u_b, st, 1.0).rgb, 1.0);
  else o = vec4(vec3(textureLod(u_c, st, 0.0).a), 1.0);
}`);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // A DXT1 block of one colour (RGB565, the second colour black, every texel the first).
  const dxt1 = (c) => new Uint8Array([c & 255, c >> 8, 0, 0, 0, 0, 0, 0]);
  const join = (...blocks) => { const out = new Uint8Array(blocks.length * 8); blocks.forEach((b, i) => out.set(b, i * 8)); return out; };
  function filters() {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  const a = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, a);
  gl.compressedTexImage2D(gl.TEXTURE_2D, 0, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, 8, 8, 0, join(dxt1(0xf800), dxt1(0x07e0), dxt1(0x001f), dxt1(0xffe0)));
  gl.compressedTexImage2D(gl.TEXTURE_2D, 1, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, 0, dxt1(0xffff));
  gl.compressedTexImage2D(gl.TEXTURE_2D, 2, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, 2, 2, 0, dxt1(0x8410));
  gl.compressedTexImage2D(gl.TEXTURE_2D, 3, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, 1, 1, 0, dxt1(0x8410));
  filters();
  const b = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, b);
  gl.texStorage2D(gl.TEXTURE_2D, 2, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, 8, 8);
  gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 8, 8, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, join(dxt1(0xf81f), dxt1(0x07ff), dxt1(0xf800), dxt1(0x07e0)));
  gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 4, 4, 4, 4, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, dxt1(0xffff));
  gl.compressedTexSubImage2D(gl.TEXTURE_2D, 1, 0, 0, 4, 4, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, dxt1(0x07ff));
  filters();
  const c = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, c);
  // DXT5: alpha 160 and 40 as the two end values, texels 0 (160) and 1 (40) in the first row, the colour red.
  gl.compressedTexImage2D(gl.TEXTURE_2D, 0, ext.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4, 0, new Uint8Array([160, 40, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.useProgram(show);
  ['u_a', 'u_b', 'u_c'].forEach((n, i) => gl.uniform1i(gl.getUniformLocation(show, n), i));
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
