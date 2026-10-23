// Shaders that draw natively: WebGL code written as a page writes it runs against a recording context, which the
// renderer replays on the GPU with the same GLSL (packages/cli/skills/kinetograph/references/AUTHORING.md §6.7). The few steps every full-screen shader of the
// core takes (a context, a program, a quad) are here.

import { createWebGLContext, type GL, type GL2, type WebGLContext, type WebGLContextAttributesLike } from '@kinetograph/scene';

/** A WebGL context as a page uses it: the calls, and the constants (`gl.TEXTURE_2D`) on the context itself. */
export type ShaderGL = WebGLContext & typeof GL & typeof GL2;

/** A recording context for a drawing buffer of `width` by `height` pixels. */
export function recordingContext(width: number, height: number, version: 1 | 2, attributes?: WebGLContextAttributesLike): ShaderGL {
  return createWebGLContext({ size: () => ({ width, height }), version, attributes }) as ShaderGL;
}

/** The program of a vertex and a fragment shader, in use. */
export function useProgram(gl: ShaderGL, vertex: string, fragment: string) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  return program;
}

/** A buffer of the four corners of the frame, as a triangle strip, for the attribute `name` of the program in use. */
export function bindQuad(gl: ShaderGL, program: ReturnType<ShaderGL['createProgram']>, name: string): void {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
}
