// size: 32 16
// A 3D texture of 32-bit floats (R32F, as three.js's Data3DTexture of FloatType is) and one of RGBA8, read with texelFetch:
// each 16 x 16 half shows a 4 x 4 grid of the texels of the layer z = 2, as grey (left: the floats, right: the bytes).
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D u_float;
uniform sampler3D u_bytes;
out vec4 o;
void main() {
  ivec2 cell = ivec2(mod(gl_FragCoord.xy, 16.0) / 4.0);
  float v = gl_FragCoord.x < 16.0 ? texelFetch(u_float, ivec3(cell, 2), 0).r : texelFetch(u_bytes, ivec3(cell, 2), 0).r;
  o = vec4(vec3(v), 1.0);
}`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const floats = new Float32Array(64);
const bytes = new Uint8Array(64 * 4);
for (let i = 0; i < 64; i++) { floats[i] = i / 63; bytes.set([Math.round(255 - i * 4), 0, 0, 255], i * 4); }
const a = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_3D, a);
gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, 4, 4, 4, 0, gl.RED, gl.FLOAT, floats);
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
const b = gl.createTexture();
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_3D, b);
gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 4, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.uniform1i(gl.getUniformLocation(p, 'u_float'), 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_bytes'), 1);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
