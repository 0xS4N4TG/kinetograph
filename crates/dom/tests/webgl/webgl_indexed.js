// size: 64 48
// An indexed draw: four vertices with a colour each, six unsigned shorts that make two triangles, drawn by
// `drawElements` from an `ELEMENT_ARRAY_BUFFER` (a buffer WebGL keeps apart from the array buffers).
const p = gl.createProgram();
for (const [type, src] of [
  [gl.VERTEX_SHADER, 'attribute vec2 a_pos; attribute vec3 a_color; varying vec3 v_color; void main() { v_color = a_color; gl_Position = vec4(a_pos, 0.0, 1.0); }'],
  [gl.FRAGMENT_SHADER, 'precision mediump float; varying vec3 v_color; void main() { gl_FragColor = vec4(v_color, 1.0); }'],
]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.bindAttribLocation(p, 1, 'a_color');
gl.linkProgram(p);
gl.useProgram(p);
const vertices = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 1, 0, 0, 0.8, -0.8, 0, 1, 0, 0.8, 0.8, 0, 0, 1, -0.8, 0.8, 1, 1, 0]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
const indices = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
gl.viewport(0, 0, W, H);
gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
