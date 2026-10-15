// size: 96 64
// A 4 x 4 texture from an array, sampled magnified (linear, repeating) on the left of a quad and again (nearest,
// clamped) on its right, with interleaved position and uv attributes.
const p = gl.createProgram();
for (const [type, src] of [
  [gl.VERTEX_SHADER, 'attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv; void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }'],
  [gl.FRAGMENT_SHADER, `precision mediump float;
    varying vec2 v_uv; uniform sampler2D u_a; uniform sampler2D u_b;
    void main() { gl_FragColor = v_uv.x < 1.0 ? texture2D(u_a, v_uv * 1.5) : texture2D(u_b, v_uv - 1.0); }`],
]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.bindAttribLocation(p, 1, 'a_uv');
gl.linkProgram(p);
gl.useProgram(p);
const pixels = new Uint8Array(4 * 4 * 4);
for (let y = 0; y < 4; y += 1) {
  for (let x = 0; x < 4; x += 1) {
    const o = (y * 4 + x) * 4;
    const on = (x + y) % 2 === 0;
    pixels.set(on ? [230, 90, 60, 255] : [30, 60, 140, 255], o);
  }
}
function texture(unit, filter, wrap) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
}
texture(0, gl.LINEAR, gl.REPEAT);
texture(1, gl.NEAREST, gl.CLAMP_TO_EDGE);
gl.uniform1i(gl.getUniformLocation(p, 'u_a'), 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_b'), 1);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
// Left half samples texture a (u 0..1), the right half texture b (u 1..2).
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 0, 0, 1, -1, 2, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 2, 0, 1, 1, 2, 1]),
  gl.STATIC_DRAW,
);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
gl.viewport(0, 0, W, H);
gl.drawArrays(gl.TRIANGLES, 0, 6);
