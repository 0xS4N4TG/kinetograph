// size: 96 64
// A full-screen quad with a fragment shader that reads gl_FragCoord and two uniforms (GLSL ES 100).
function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  return p;
}
const p = program(
  'attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }',
  `precision mediump float;
   uniform vec2 u_res; uniform float u_time;
   void main() {
     vec2 uv = gl_FragCoord.xy / u_res;
     float wave = 0.5 + 0.5 * sin(uv.x * 6.2831 + u_time);
     gl_FragColor = vec4(uv.x, uv.y * wave, 1.0 - uv.x * 0.5, 1.0);
   }`,
);
gl.useProgram(p);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
const at = gl.getAttribLocation(p, 'a_pos');
gl.enableVertexAttribArray(at);
gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
gl.uniform2f(gl.getUniformLocation(p, 'u_res'), W, H);
gl.uniform1f(gl.getUniformLocation(p, 'u_time'), 1.25);
gl.viewport(0, 0, W, H);
gl.drawArrays(gl.TRIANGLES, 0, 6);
