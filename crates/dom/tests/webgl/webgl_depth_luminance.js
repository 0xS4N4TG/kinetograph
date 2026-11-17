// size: 32 16
// A WebGL 1 depth texture (WEBGL_depth_texture) reads as (d, d, d, 1): a triangle drawn at clip depth -0.2 into a
// framebuffer's depth texture, then shown as grey on the canvas. A WebGL 2 sampler would read (d, 0, 0, 1) and show red.
const ext = gl.getExtension('WEBGL_depth_texture');
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
const fill = program(`attribute vec3 a_pos; void main() { gl_Position = vec4(a_pos, 1.0); }`,
  `precision mediump float; void main() { gl_FragColor = vec4(1.0); }`);
const show = program(`attribute vec3 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos.xy * 0.5 + 0.5; gl_Position = vec4(a_pos.xy, 0.0, 1.0); }`,
  `precision mediump float; varying vec2 v_uv; uniform sampler2D u_depth; void main() { gl_FragColor = vec4(texture2D(u_depth, v_uv).rgb, 1.0); }`);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0,
  -1, -1, -0.2, 1, -1, -0.2, 0, 1, -0.2,
]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

const color = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, color);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
const depth = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, depth);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, 32, 16, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const fb = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
gl.viewport(0, 0, 32, 16);
gl.clearColor(0, 0, 0, 1);
gl.clearDepth(1);
gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.enable(gl.DEPTH_TEST);
gl.useProgram(fill);
gl.drawArrays(gl.TRIANGLES, 6, 3);
gl.disable(gl.DEPTH_TEST);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(show);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, depth);
gl.uniform1i(gl.getUniformLocation(show, 'u_depth'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
