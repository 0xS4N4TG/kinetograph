// size: 64 32
// SAMPLE_ALPHA_TO_COVERAGE (WebGL 2, the default 4-sample drawing buffer): the alpha a fragment writes is the share of the
// samples it covers: four bands of a red quad with an alpha of 1/4, 1/2, 3/4 and 1 (a share of four samples, so every pixel
// of a band is the same whichever samples the GPU picks) come out dark to bright with blending off.
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(1.0, 0.0, 0.0, (floor(gl_FragCoord.x / 16.0) + 1.0) * 0.25); }`]]) {
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
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
gl.drawArrays(gl.TRIANGLES, 0, 6);
