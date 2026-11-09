// size: 96 64
// generateMipmap of a texture a framebuffer drew in (WebGL 2): a 64 x 64 texture gets one-pixel red and blue
// stripes with a green disc, its mip chain is made, and it is drawn at 64, 32, 16, 8 and 12 pixels with
// LINEAR_MIPMAP_LINEAR, so the stripes average to purple in the smaller copies and the 12-pixel one blends two levels.
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
const VS = `#version 300 es
in vec2 a_pos; out vec2 v_uv; uniform vec4 u_rect;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(mix(u_rect.xy, u_rect.zw, v_uv), 0.0, 1.0); }`;
const pattern = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; out vec4 o;
void main() {
  float stripe = mod(floor(gl_FragCoord.x), 2.0);
  vec3 c = mix(vec3(0.9, 0.1, 0.1), vec3(0.1, 0.2, 0.9), stripe);
  if (length(v_uv - 0.5) < 0.3) c = vec3(0.2, 0.8, 0.3);
  o = vec4(c, 1.0);
}`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const t = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, t);
gl.texStorage2D(gl.TEXTURE_2D, 7, gl.RGBA8, 64, 64);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.bindTexture(gl.TEXTURE_2D, null);
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
gl.viewport(0, 0, 64, 64);
gl.useProgram(pattern);
gl.uniform4f(gl.getUniformLocation(pattern, 'u_rect'), -1, -1, 1, 1);
gl.drawArrays(gl.TRIANGLES, 0, 6);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.bindTexture(gl.TEXTURE_2D, t);
gl.generateMipmap(gl.TEXTURE_2D);

gl.viewport(0, 0, W, H);
gl.clearColor(0.1, 0.1, 0.1, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(show);
gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
const rect = gl.getUniformLocation(show, 'u_rect');
// A rectangle in canvas pixels, from the bottom left.
function at(x, y, w, h) {
  gl.uniform4f(rect, (x / W) * 2 - 1, (y / H) * 2 - 1, ((x + w) / W) * 2 - 1, ((y + h) / H) * 2 - 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
at(0, 0, 64, 64);
at(64, 32, 32, 32);
at(64, 16, 16, 16);
at(80, 16, 8, 8);
at(68, 2, 12, 12);
