// size: 64 48
// Two children of a shader group as textures (`layerPicture`, a canvas as a page would upload it): a half-transparent
// orange block on the left half, uploaded turned over and premultiplied, and a blue band along the top, uploaded as it
// is. The shader lays the first over the second. The test draws the children itself: on 2D canvases for Chrome, as
// the scene's layers for the engine (the recorder cannot make a group, so `layerPicture` is given to it).
const p = gl.createProgram();
for (const [type, src] of [
  [gl.VERTEX_SHADER, 'attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }'],
  [gl.FRAGMENT_SHADER, `precision mediump float;
    varying vec2 v_uv; uniform sampler2D u_a; uniform sampler2D u_b;
    void main() { vec4 a = texture2D(u_a, v_uv); vec4 b = texture2D(u_b, v_uv); gl_FragColor = a + b * (1.0 - a.a); }`],
]) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  gl.attachShader(p, s);
}
gl.bindAttribLocation(p, 0, 'a_pos');
gl.linkProgram(p);
gl.useProgram(p);
function texture(unit, picture, flip, premultiply) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
texture(0, layerPicture('a', W, H), true, true);
texture(1, layerPicture('b', W, H), false, false);
gl.uniform1i(gl.getUniformLocation(p, 'u_a'), 0);
gl.uniform1i(gl.getUniformLocation(p, 'u_b'), 1);
const b = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.viewport(0, 0, W, H);
gl.drawArrays(gl.TRIANGLES, 0, 6);
