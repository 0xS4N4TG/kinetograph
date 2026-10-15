// size: 96 64
// Value noise from a hash without sin (whose large arguments differ between GPUs), summed over octaves, in GLSL ES 300 es with a vertex shader that passes uv on.
const p = gl.createProgram();
for (const [type, src] of [
  [gl.VERTEX_SHADER, `#version 300 es
    in vec2 a_pos; out vec2 v_uv;
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`],
  [gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec2 v_uv; uniform float u_scale; uniform vec3 u_tint[2]; out vec4 outColor;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    void main() {
      float n = 0.0, a = 0.5;
      vec2 q = v_uv * u_scale;
      for (int i = 0; i < 4; i++) { n += a * noise(q); q *= 2.0; a *= 0.5; }
      outColor = vec4(mix(u_tint[0], u_tint[1], n), 1.0);
    }`],
]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.uniform1f(gl.getUniformLocation(p, 'u_scale'), 5.0);
gl.uniform3fv(gl.getUniformLocation(p, 'u_tint'), [0.05, 0.1, 0.3, 0.95, 0.8, 0.5]);
gl.viewport(0, 0, W, H);
gl.drawArrays(gl.TRIANGLES, 0, 6);
