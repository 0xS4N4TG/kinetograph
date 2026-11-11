// size: 96 64
// Two blocks with binding points of their own (3 and 7) and two draws with a bufferSubData between them (WebGL 2): each
// draw shows the bytes the buffers held when it was made. The first is a blue square at the left; then both buffers
// are rewritten in part and the second is a smaller green one at the right (both on pixel edges), half way to its edge colour.
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
const p = program(`#version 300 es
in vec2 a_pos;
layout(std140) uniform Placement { vec2 pos; float size; };
void main() { gl_Position = vec4(a_pos * size + pos, 0.0, 1.0); }`, `#version 300 es
precision highp float; out vec4 o;
layout(std140) uniform Colors { vec4 inner; vec3 edge; float mixer; };
void main() { o = vec4(mix(inner.rgb, edge, mixer), inner.a); }`);
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const placement = gl.createBuffer();
const colors = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, placement);
gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array([-0.5, 0.0, 0.25, 0]), gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.UNIFORM_BUFFER, colors);
gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array([0.1, 0.3, 0.9, 1, 0.9, 0.9, 0.2, 0]), gl.DYNAMIC_DRAW);
gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Placement'), 3);
gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Colors'), 7);
gl.bindBufferBase(gl.UNIFORM_BUFFER, 3, placement);
gl.bindBufferBase(gl.UNIFORM_BUFFER, 7, colors);

gl.clearColor(0.8, 0.8, 0.8, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
gl.viewport(0, 0, W, H);
gl.useProgram(p);
gl.drawArrays(gl.TRIANGLES, 0, 6);

// The first square is drawn; what the buffers hold now is for the second.
gl.bindBuffer(gl.UNIFORM_BUFFER, placement);
gl.bufferSubData(gl.UNIFORM_BUFFER, 0, new Float32Array([0.5, 0.25]));
gl.bufferSubData(gl.UNIFORM_BUFFER, 8, new Float32Array([0.125]));
gl.bindBuffer(gl.UNIFORM_BUFFER, colors);
gl.bufferSubData(gl.UNIFORM_BUFFER, 0, new Float32Array([0.1, 0.8, 0.3, 1]));
gl.bufferSubData(gl.UNIFORM_BUFFER, 16, new Float32Array([0.0, 0.2, 0.0]));
gl.bufferSubData(gl.UNIFORM_BUFFER, 28, new Float32Array([0.5]));
gl.drawArrays(gl.TRIANGLES, 0, 6);
