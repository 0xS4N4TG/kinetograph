// size: 96 64
// attributes: {"antialias": false}
// A multisampled renderbuffer resolved by blitFramebuffer (WebGL 2): a 48 x 32 RGBA8 renderbuffer of 4 samples gets
// a triangle with a long diagonal edge, is resolved into a texture, and the canvas shows the texture at twice its size
// with NEAREST, so the edge's partly covered pixels are visible as in-between colours.
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
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const flat = program(VS, `#version 300 es
precision mediump float; uniform vec4 u_color; out vec4 o;
void main() { o = u_color; }`);
const show = program(VS, `#version 300 es
precision mediump float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;
void main() { o = texture(u_tex, v_uv); }`);

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
const triangle = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.85, 0.9, -0.6, -0.3, 0.9]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);

const rb = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.RGBA8, 48, 32);
const msaa = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
gl.viewport(0, 0, 48, 32);
gl.clearColor(0.1, 0.1, 0.25, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(flat);
gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.uniform4f(gl.getUniformLocation(flat, 'u_color'), 0.95, 0.8, 0.3, 1);
gl.drawArrays(gl.TRIANGLES, 0, 3);

const t = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, t);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 48, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.bindTexture(gl.TEXTURE_2D, null);
const resolved = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, resolved);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa);
gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved);
gl.blitFramebuffer(0, 0, 48, 32, 0, 0, 48, 32, gl.COLOR_BUFFER_BIT, gl.NEAREST);

gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.useProgram(show);
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindTexture(gl.TEXTURE_2D, t);
gl.uniform1i(gl.getUniformLocation(show, 'u_tex'), 0);
gl.drawArrays(gl.TRIANGLES, 0, 6);
