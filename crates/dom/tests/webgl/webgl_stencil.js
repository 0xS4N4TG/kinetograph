// size: 96 64
// attributes: {"stencil": true, "antialias": false}
// The stencil test: a six-pointed star is drawn into the stencil buffer only (colour masked off), a gradient is
// drawn where the stencil is 1, and a flat colour where it is not; a second star, inverting the bits, cuts the
// first, so where both lie the stencil is back to 0.
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
const flat = program(
  'attribute vec2 a_pos; uniform vec2 u_at; uniform float u_scale; void main() { gl_Position = vec4(a_pos * u_scale + u_at, 0.0, 1.0); }',
  'precision mediump float; uniform vec4 u_color; void main() { gl_FragColor = u_color; }',
);
const gradient = program(
  'attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }',
  'precision mediump float; varying vec2 v_uv; void main() { gl_FragColor = vec4(v_uv.x, v_uv.y, 1.0 - v_uv.x, 1.0); }',
);

// Two triangles that make a star of six points, around the origin (y stretched to the canvas's aspect).
const star = [];
for (const turn of [0, Math.PI / 3]) {
  for (let k = 0; k < 3; k += 1) {
    const a = turn + (k * 2 * Math.PI) / 3 + Math.PI / 2;
    star.push(Math.cos(a), Math.sin(a) * 1.5);
  }
}
const starBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(star), gl.STATIC_DRAW);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);

gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clearStencil(0);
gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
gl.enable(gl.STENCIL_TEST);

// The stars, into the stencil alone.
gl.colorMask(false, false, false, false);
gl.useProgram(flat);
gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.uniform4f(gl.getUniformLocation(flat, 'u_color'), 1, 1, 1, 1);
gl.stencilFunc(gl.ALWAYS, 1, 0xff);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
gl.uniform2f(gl.getUniformLocation(flat, 'u_at'), -0.25, 0);
gl.uniform1f(gl.getUniformLocation(flat, 'u_scale'), 0.6);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
gl.stencilMask(0x01);
gl.uniform2f(gl.getUniformLocation(flat, 'u_at'), 0.35, -0.1);
gl.uniform1f(gl.getUniformLocation(flat, 'u_scale'), 0.45);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.stencilMask(0xff);
gl.colorMask(true, true, true, true);

// The gradient where the stencil is 1, an orange where it is not.
gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.stencilFunc(gl.EQUAL, 1, 0xff);
gl.useProgram(gradient);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
gl.useProgram(flat);
gl.uniform2f(gl.getUniformLocation(flat, 'u_at'), 0, 0);
gl.uniform1f(gl.getUniformLocation(flat, 'u_scale'), 1);
gl.uniform4f(gl.getUniformLocation(flat, 'u_color'), 0.9, 0.5, 0.2, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
