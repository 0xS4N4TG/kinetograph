// `<GlslShader>` (docs/SCENE.md, "glsl"): a full-screen fragment shader becomes a glsl layer holding one draw of a
// quad with the uniforms the props give.

import { describe, expect, it } from 'vitest';
import type { GlslLayer } from '@kinetograph/scene';
import { GlslShader } from '../src/index.js';
import { layersOf } from './harness.js';

describe('<GlslShader>', () => {
  it('is a glsl layer with one draw of a full-screen quad', () => {
    const [layer] = layersOf(
      <GlslShader
        id="sky"
        width={64}
        height={32}
        x={4}
        fragment="precision mediump float; uniform float t; void main() { gl_FragColor = vec4(t); }"
        uniforms={{ t: 0.5 }}
      />,
    ) as GlslLayer[];
    expect(layer).toMatchObject({ id: 'sky', type: 'glsl', width: 64, height: 32, transform: { x: 4 } });
    expect(layer!.ops).toHaveLength(1);
    const draw = layer!.ops![0]!;
    if (draw.op !== 'draw') throw new Error('not a draw');
    expect(draw.uniforms.t).toEqual([{ kind: 'f', value: [0.5] }]);
    expect(draw.viewport).toEqual([0, 0, 64, 32]);
  });

  it('refuses a size that is not a number of pixels and a uniform the shader lacks', () => {
    expect(() => layersOf(<GlslShader width={-1} height={4} fragment="void main() {}" />)).toThrow(/width must be/);
    expect(() => layersOf(<GlslShader width={4} height={4} fragment="void main() {}" uniforms={{ nope: 1 }} />)).toThrow(/no uniform "nope"/);
  });
});
