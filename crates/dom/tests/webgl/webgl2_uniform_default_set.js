// size: 32 16
// Uniforms a page never sets are 0, and a sampler never set reads unit 0, whatever an earlier page with the same shader set (this page sets
// the sampler to unit 1, a green texture there, and u_k to 0.4).
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D u_tex; uniform float u_k; out vec4 o;
void main() { o = texture(u_tex, v_uv) + vec4(u_k, 0.0, 0.0, 0.0); }`]]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, "a_pos");
gl.linkProgram(p);
gl.useProgram(p);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
function tex(unit, rgba) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
tex(0, [200, 60, 60, 255]);
tex(1, [40, 200, 90, 255]);
gl.uniform1i(gl.getUniformLocation(p, 'u_tex'), 1);
gl.uniform1f(gl.getUniformLocation(p, 'u_k'), 0.4);
gl.drawArrays(gl.TRIANGLES, 0, 6);
