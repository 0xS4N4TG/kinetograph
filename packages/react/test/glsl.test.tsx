// `<GlslShader>` (packages/cli/skills/kinetograph/references/SCENE.md, "glsl"): a full-screen fragment shader becomes a glsl layer holding one draw of a
// quad with the uniforms the props give.

import { describe, expect, it } from 'vitest';
import type { GlslLayer, GroupLayer } from '@kinetographdev/scene';
import { GlslShader, Layer, Rect } from '../src/index.js';
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

  it('moves the layers a shader group names into it, wherever they are in the tree', () => {
    const glsl = { width: 64, height: 32, textures: { out: { layer: 'out' }, gone: { layer: 'gone' } } };
    const layers = layersOf(
      <>
        <Layer id="scene-a">
          <Layer id="out">
            <Rect id="a" width={4} height={4} />
          </Layer>
        </Layer>
        <Layer id="scene-b">
          <Layer id="pass" glsl={glsl}>
            <Layer id="in" />
          </Layer>
        </Layer>
      </>,
    );
    const [a, b] = layers as [GroupLayer, GroupLayer];
    // The scene it was taken from is left empty; the group has its own child, then the ones it took.
    expect(a.children).toEqual([]);
    const pass = b.children[0] as GroupLayer;
    expect(pass.children.map((c) => c.id)).toEqual(['in', 'out', 'gone']);
    expect((pass.children[1] as GroupLayer).children.map((c) => c.id)).toEqual(['a']);
    // A name that no layer has is a transparent picture: an empty group.
    expect(pass.children[2]).toEqual({ id: 'gone', type: 'group', children: [] });
  });

  it('copies a layer that two shader groups name, under new ids', () => {
    const textures = { t: { layer: 'src' } };
    const layers = layersOf(
      <>
        <Layer id="src">
          <Rect id="r" width={4} height={4} matte={{ layer: 'm' }} />
          <Rect id="m" width={2} height={2} />
        </Layer>
        <Layer id="one" glsl={{ width: 8, height: 8, textures }} />
        <Layer id="two" glsl={{ width: 8, height: 8, textures }} />
      </>,
    ) as GroupLayer[];
    const [one, two] = layers as [GroupLayer, GroupLayer];
    expect(layers.map((l) => l.id)).toEqual(['one', 'two']);
    expect(one.children.map((c) => c.id)).toEqual(['src']);
    const copy = two.children[0] as GroupLayer;
    expect(copy.id).toBe('src~1');
    expect(two.glsl!.textures!.t).toEqual({ layer: 'src~1' });
    expect(copy.children.map((c) => c.id)).toEqual(['r~1', 'm~1']);
    expect(copy.children[0]!.matte).toEqual({ layer: 'm~1' });
    // The first group's recording is as it was.
    expect(one.glsl!.textures!.t).toEqual({ layer: 'src' });
  });

  it('refuses a size that is not a number of pixels and a uniform the shader lacks', () => {
    expect(() => layersOf(<GlslShader width={-1} height={4} fragment="void main() {}" />)).toThrow(/width must be/);
    expect(() => layersOf(<GlslShader width={4} height={4} fragment="void main() {}" uniforms={{ nope: 1 }} />)).toThrow(/no uniform "nope"/);
  });
});
