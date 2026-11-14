// size: 96 64
// attributes: {"stencil": true, "antialias": false}
// clear() through the masks: colorMask lets one channel of the clear colour through (and none at all), the scissor box
// limits a masked clear to a rectangle, and stencilMask lets only some bits of the cleared stencil value in; a quad
// tested against the stencil shows the result.
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
  'attribute vec2 a_pos; uniform vec4 u_rect; void main() { gl_Position = vec4(u_rect.xy + (a_pos * 0.5 + 0.5) * u_rect.zw, 0.0, 1.0); }',
  'precision mediump float; uniform vec4 u_color; void main() { gl_FragColor = u_color; }',
);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);

gl.clearColor(0.1, 0.2, 0.6, 1);
gl.clearStencil(0);
gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

// Only red from a white clear: the whole buffer goes (1, 0.2, 0.6).
gl.colorMask(true, false, false, true);
gl.clearColor(1, 1, 1, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

// With the scissor box on, only green and blue of a yellow-grey clear, inside the box.
gl.enable(gl.SCISSOR_TEST);
gl.scissor(8, 8, 40, 24);
gl.colorMask(false, true, true, true);
gl.clearColor(0, 0.9, 0.3, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.disable(gl.SCISSOR_TEST);

// Every channel off: the clear writes nothing.
gl.colorMask(false, false, false, false);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.colorMask(true, true, true, true);

// A stencil clear of 0xff through the mask 0x0f leaves 0x0f; tested for equality, it shows a bar.
gl.stencilMask(0x0f);
gl.clearStencil(0xff);
gl.scissor(48, 0, 48, 64);
gl.enable(gl.SCISSOR_TEST);
gl.clear(gl.STENCIL_BUFFER_BIT);
gl.disable(gl.SCISSOR_TEST);
gl.stencilMask(0xff);

gl.useProgram(flat);
gl.enable(gl.STENCIL_TEST);
gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
gl.stencilFunc(gl.EQUAL, 0x0f, 0xff);
gl.uniform4f(gl.getUniformLocation(flat, 'u_rect'), -1, -1, 2, 2);
gl.uniform4f(gl.getUniformLocation(flat, 'u_color'), 0.9, 0.8, 0.1, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.stencilFunc(gl.EQUAL, 0x00, 0xff);
gl.uniform4f(gl.getUniformLocation(flat, 'u_rect'), -0.9, -0.9, 0.5, 0.5);
gl.uniform4f(gl.getUniformLocation(flat, 'u_color'), 0.0, 0.0, 0.0, 0.5);
gl.disable(gl.STENCIL_TEST);
