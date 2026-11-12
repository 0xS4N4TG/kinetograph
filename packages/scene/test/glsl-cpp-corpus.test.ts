// The TS and the Rust preprocessors read one corpus of shader snippets (crates/core/tests/fixtures/glsl-cpp-corpus.json)
// and must agree on the uniforms each leaves declared; `crates/core/src/glsl.rs` runs the same file.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWebGLContext, GL } from '../src/index.js';

interface Case {
  name: string;
  fragment: string;
  /** The uniforms the program ends up with, by name, and the length of each (1 for a single value). */
  uniforms: Record<string, number>;
}

const corpus = JSON.parse(readFileSync(new URL('../../../crates/core/tests/fixtures/glsl-cpp-corpus.json', import.meta.url), 'utf8')) as Case[];

function uniformsOf(fragment: string): Record<string, number> {
  const es3 = fragment.includes('#version 300 es');
  const gl = createWebGLContext({ size: () => ({ width: 4, height: 4 }), version: es3 ? 2 : 1 });
  const vertex = es3 ? '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }' : 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const program = gl.createProgram();
  for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  expect(gl.getProgramParameter(program, GL.LINK_STATUS)).toBe(true);
  const out: Record<string, number> = {};
  for (let i = 0; i < (gl.getProgramParameter(program, GL.ACTIVE_UNIFORMS) as number); i++) {
    const info = gl.getActiveUniform(program, i)!;
    out[info.name.replace(/\[0\]$/, '')] = info.size;
    // A uniform the page can find by name is one the program has.
    expect(gl.getUniformLocation(program, info.name)).not.toBeNull();
  }
  return out;
}

describe('the preprocessor corpus', () => {
  for (const c of corpus) it(c.name, () => expect(uniformsOf(c.fragment)).toEqual(c.uniforms));
});
