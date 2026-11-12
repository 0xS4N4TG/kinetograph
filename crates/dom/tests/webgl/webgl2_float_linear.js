// size: 32 16
// OES_texture_float_linear: with the extension enabled a 32-bit float texture is read with a linear filter. A 2 x 1 R32F texture
// (0 and 1) is stretched over the canvas with LINEAR, so it comes out as a ramp, grey from the dark end to the light one.
gl.getExtension('OES_texture_float_linear');
const p = gl.createProgram();
for (const [type, src] of [[gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform sampler2D t;
in vec2 v_uv;
out vec4 o;
void main() { o = vec4(vec3(texture(t, v_uv).r), 1.0); }`]]) {
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
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 2, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0, 1]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.drawArrays(gl.TRIANGLES, 0, 6);
