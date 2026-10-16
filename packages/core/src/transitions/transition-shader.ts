// The shaders of the built-in shader presentations share one shape: a fragment shader over a full-screen quad that mixes
// the scene coming in (`u_prev`) with the scene going out (`u_next`) by the progress (`u_time`, 0 at the start of the
// transition). `v_uv` is the position in the frame with its origin at the top left. The names are those of the published
// package, so a shader written for `makeHtmlInCanvasPresentation` there reads the same here.

import type { HtmlInCanvasShader } from './html-in-canvas.js';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export interface TransitionShaderSpec<Props> {
  /** GLSL ES 300, with the vertex shader's `v_uv`, the samplers `u_prev` and `u_next`, `u_time` and its own uniforms. */
  fragment: string;
  /** How the scenes are sampled past their edges. Default `clamp`. */
  wrap?: 'clamp' | 'repeat';
  /** The values of the shader's own uniforms (floats, or `vec2` to `vec4` as arrays), from the props, the size and the progress. */
  uniforms?: (props: Props, frame: { width: number; height: number; time: number }) => Record<string, number | readonly number[]>;
}

/** The shader of a presentation that is `spec.fragment` over the two scenes. */
export function transitionShader<Props extends Record<string, unknown>>(spec: TransitionShaderSpec<Props>): HtmlInCanvasShader<Props> {
  return (canvas) => {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true });
    if (!gl) throw new Error('Failed to create WebGL2 context');

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, spec.fragment));
    gl.linkProgram(program);

    const wrap = spec.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    const makeTexture = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return texture;
    };
    const prevTexture = makeTexture();
    const nextTexture = makeTexture();

    // One quad that covers the frame, as a triangle strip.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const clear = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };
    const cleanup = () => {
      gl.deleteProgram(program);
      gl.deleteTexture(prevTexture);
      gl.deleteTexture(nextTexture);
    };

    return {
      clear,
      cleanup,
      draw({ prevImage, nextImage, width, height, time, passedProps }) {
        if (!prevImage && !nextImage) return;
        // With one scene missing, the other is shown whole. At time 0 the shader shows `nextImage`, at 1 `prevImage`.
        const progress = !prevImage ? 0 : !nextImage ? 1 : time;
        gl.viewport(0, 0, width, height);
        clear();
        gl.useProgram(program);
        for (const [unit, texture, image, name] of [
          [0, prevTexture, prevImage, 'u_prev'],
          [1, nextTexture, nextImage, 'u_next'],
        ] as const) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.uniform1i(gl.getUniformLocation(program, name), unit);
        }
        gl.uniform1f(gl.getUniformLocation(program, 'u_time'), progress);
        for (const [name, value] of Object.entries(spec.uniforms?.(passedProps, { width, height, time: progress }) ?? {})) {
          const location = gl.getUniformLocation(program, name);
          if (typeof value === 'number') gl.uniform1f(location, value);
          else if (value.length === 2) gl.uniform2fv(location, value);
          else if (value.length === 3) gl.uniform3fv(location, value);
          else gl.uniform4fv(location, value);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  };
}
