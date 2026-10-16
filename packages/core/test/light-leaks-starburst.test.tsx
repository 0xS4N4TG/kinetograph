// `@remotion/light-leaks` and `@remotion/starburst`: what the components emit (a shader group with a recorded WebGL
// draw), their timing and their validation, and the effects.

import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createSceneRoot, TimelineContext } from '@kinetograph/react';
import type { GlslDraw, GroupLayer, LayerJson } from '@kinetograph/scene';
import { LightLeak, LightLeakInternals, lightLeak, lightLeakEffectSchema } from '../src/light-leaks.js';
import { Starburst, StarburstInternals, starburst, starburstEffectSchema } from '../src/starburst.js';
import { Sequence } from '../src/timeline.js';
import { timeline } from './scene-harness.js';

const config = { id: 'T', width: 640, height: 360, fps: 30, durationInFrames: 91, defaultProps: {}, props: {} };

function render(node: ReactNode, frame = 0): LayerJson[] {
  const root = createSceneRoot();
  try {
    return root.render(<TimelineContext.Provider value={timeline(frame, { config, durationInFrames: 91 })}>{node}</TimelineContext.Provider>).layers as LayerJson[];
  } finally {
    root.unmount();
  }
}

/** The shader group the component made: the wrapper of the Sequence holds it. */
function passOf(layers: LayerJson[]): GroupLayer {
  const find = (list: LayerJson[]): GroupLayer | undefined => {
    for (const layer of list) {
      if (layer.type !== 'group') continue;
      if (layer.glsl !== undefined) return layer;
      const inside = find(layer.children);
      if (inside) return inside;
    }
    return undefined;
  };
  return find(layers)!;
}

const draw = (pass: GroupLayer) => pass.glsl!.ops!.find((op): op is { op: 'draw' } & GlslDraw => op.op === 'draw')!;
const uniform = (pass: GroupLayer, name: string) => draw(pass).uniforms[name]![0]!.value;

describe('<LightLeak>', () => {
  it('is one shader draw of the composition size, blended as a canvas that is not premultiplied', () => {
    const pass = passOf(render(<LightLeak />));
    expect(pass.glsl).toMatchObject({ width: 640, height: 360, premultipliedAlpha: false, alpha: true });
    expect(draw(pass)).toMatchObject({ mode: 'triangleStrip', count: 4, viewport: [0, 0, 640, 360] });
    expect(draw(pass).blend).toMatchObject({ srcRgb: 'SRC_ALPHA', dstRgb: 'ONE_MINUS_SRC_ALPHA' });
    expect(uniform(pass, 'resolution')).toEqual([640, 360]);
  });

  it('grows over the first half of its duration and retracts over the second', () => {
    const at = (frame: number) => {
      const pass = passOf(render(<LightLeak />, frame));
      return [uniform(pass, 'evolveProgress')[0]!, uniform(pass, 'retractProgress')[0]!];
    };
    expect(at(0)).toEqual([0, 0]);
    expect(at(45)).toEqual([1, 0]);
    expect(at(90)).toEqual([1, 1]);
    const [grow, retract] = at(30);
    expect(grow).toBeCloseTo(60 / 90, 12);
    expect(retract).toBe(0);
    expect(at(60)[1]).toBeCloseTo(30 / 90, 12);
  });

  it('takes its time from its own sequence', () => {
    const layers = render(<LightLeak from={10} durationInFrames={21} />, 20);
    expect(uniform(passOf(layers), 'evolveProgress')).toEqual([1]);
    expect(layers).toHaveLength(1);
    expect(render(<LightLeak from={10} durationInFrames={21} />, 5)).toEqual([]);
  });

  it('passes the seed and hue shift, and moves the retracting half\'s seed by 42', () => {
    const pass = passOf(render(<LightLeak seed={3} hueShift={120} />));
    expect(uniform(pass, 'seed')).toEqual([3]);
    expect(uniform(pass, 'retractSeed')).toEqual([45]);
    expect(uniform(pass, 'hueShift')).toEqual([120]);
  });

  it('applies the opacity and blend mode of its style', () => {
    const layers = render(<LightLeak style={{ mixBlendMode: 'screen', opacity: 0.5 }} />);
    expect(passOf(layers)).toMatchObject({ opacity: 0.5, blendMode: 'screen' });
  });

  it('refuses what the published package refuses', () => {
    expect(() => render(<LightLeak seed={Number.NaN} />)).toThrow('"seed" must be a finite number, but got null');
    expect(() => render(<LightLeak hueShift={Infinity} />)).toThrow(/"hueShift" must be a finite number/);
    expect(() => render(<LightLeak hueShift={361} />)).toThrow('"hueShift" must be between 0 and 360, but got 361');
  });

  it('lasts as long as the sequence around it', () => {
    const layers = render(
      <Sequence from={0} durationInFrames={31}>
        <LightLeak />
      </Sequence>,
      30,
    );
    expect(uniform(passOf(layers), 'retractProgress')).toEqual([1]);
  });
});

describe('lightLeak()', () => {
  it('is a shader effect whose progress splits into the two halves', () => {
    const effect = lightLeak({ seed: 2, hueShift: 90, progress: 0.75 });
    expect(effect).toMatchObject({ type: 'shader', uniforms: { seed: 2, hue_shift: 90, evolve: 1, retract: 0.5 } });
    expect(lightLeak().uniforms).toMatchObject({ evolve: 1, retract: 0 });
    expect(lightLeak({ disabled: true }).uniforms).toMatchObject({ evolve: 0, retract: 0 });
  });

  it('refuses what the published package refuses', () => {
    expect(() => lightLeak({ hueShift: -1 })).toThrow('"hueShift" must be >= 0, but got -1');
    expect(() => lightLeak({ hueShift: 361 })).toThrow('"hueShift" must be <= 360, but got 361');
    expect(() => lightLeak({ progress: 2 })).toThrow('"progress" must be <= 1, but got 2');
    expect(() => lightLeak({ seed: 'x' as never })).toThrow('"seed" must be a finite number, but got "x"');
    expect(() => lightLeak(null as never)).toThrow(/lightLeak\(\) effect requires a parameters object/);
  });

  it('has the schema and internals of the published package', () => {
    expect(Object.keys(lightLeakEffectSchema)).toEqual(['seed', 'hueShift', 'progress']);
    expect(lightLeakEffectSchema.progress).toMatchObject({ min: 0, max: 1, step: 0.01, default: 0.5 });
    expect(LightLeakInternals.lightLeak).toBe(lightLeak);
  });
});

describe('<Starburst>', () => {
  const colors = ['#ff0000', '#00ff00', 'blue'];

  it('is one shader draw with the palette as a texture one colour wide', () => {
    const layers = render(<Starburst rays={12} colors={colors} rotation={90} smoothness={0.3} vignette={0.5} originOffsetX={0.1} originOffsetY={-0.2} />);
    const pass = passOf(layers);
    expect(pass.glsl).toMatchObject({ width: 640, height: 360, premultipliedAlpha: false });
    expect(uniform(pass, 'numRays')).toEqual([12]);
    expect(uniform(pass, 'numColors')).toEqual([3]);
    expect(uniform(pass, 'rotationOffset')[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(uniform(pass, 'smoothEdge')).toEqual([0.3]);
    expect(uniform(pass, 'vignetteAmount')).toEqual([0.5]);
    expect(uniform(pass, 'originOffset')[0]).toBeCloseTo(0.1, 6);
    expect(uniform(pass, 'originOffset')[1]).toBeCloseTo(-0.2, 6);
    const unit = Object.values(draw(pass).units)[0]!;
    expect(unit).toMatchObject({ min: 'NEAREST', mag: 'NEAREST', wrapS: 'CLAMP_TO_EDGE' });
    const texture = pass.glsl!.textures![unit.texture]!;
    expect(texture).toMatchObject({ width: 3, height: 1 });
    expect([...Buffer.from(texture.pixels!, 'base64')]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  });

  it('has the defaults of the published package', () => {
    const pass = passOf(render(<Starburst rays={8} colors={colors} />));
    expect(uniform(pass, 'rotationOffset')).toEqual([0]);
    expect(uniform(pass, 'smoothEdge')).toEqual([0]);
    expect(uniform(pass, 'vignetteAmount')).toEqual([1]);
    expect(uniform(pass, 'originOffset')).toEqual([0, 0]);
  });

  it('refuses what the published package refuses', () => {
    expect(() => render(<Starburst rays={1} colors={colors} />)).toThrow('"rays" must be between 2 and 100, but got 1');
    expect(() => render(<Starburst rays={Number.NaN} colors={colors} />)).toThrow(/"rays" must be a finite number/);
    expect(() => render(<Starburst rays={5} colors={['red']} />)).toThrow('"colors" must be an array with at least 2 colors, but got ["red"]');
    expect(() => render(<Starburst rays={5} colors={colors} smoothness={2} />)).toThrow('"smoothness" must be between 0 and 1, but got 2');
    expect(() => render(<Starburst rays={5} colors={colors} vignette={-1} />)).toThrow('"vignette" must be between 0 and 1, but got -1');
    expect(() => render(<Starburst rays={5} colors={colors} rotation={Infinity} />)).toThrow(/"rotation" must be a finite number/);
  });
});

describe('starburst()', () => {
  it('is a shader effect with the palette in its code and the rest as uniforms', () => {
    const effect = starburst({ rays: 10, colors: ['#ff0000', '#0000ff'], rotation: 180, smoothness: 0.5, origin: [0.25, 0.75] });
    expect(effect).toMatchObject({ type: 'shader', uniforms: { rays: 10, smoothness: 0.5, origin_x: 0.25, origin_y: 0.75 } });
    expect(effect.uniforms!.rotation).toBeCloseTo(Math.PI, 12);
    expect(effect.code).toContain('vec3<f32>(1.000000, 0.000000, 0.000000), vec3<f32>(0.000000, 0.000000, 1.000000)');
    expect(starburst({ rays: 4, colors: ['red', 'blue'], disabled: true }).code).toContain('return layer(px)');
  });

  it('refuses what the published package refuses', () => {
    expect(() => starburst({ rays: 1, colors: ['red', 'blue'] })).toThrow('"rays" must be between 2 and 100, but got 1');
    expect(() => starburst({ rays: 5, colors: ['red'] })).toThrow(/"colors" must be an array with at least 2 colors/);
    expect(() => starburst({ rays: 5, colors: ['red', 'blue'], origin: [2, 0] })).toThrow('"origin" must contain coordinates between 0 and 1, but got [2,0]');
    expect(() => starburst({ rays: 5, colors: ['red', 'blue'], origin: [0.5] as never })).toThrow('"origin" must be a [number, number] tuple');
    expect(() => starburst({ rays: 5, colors: ['red', 'nope'] })).toThrow(/Invalid color "nope"/);
    expect(() => starburst(null as never)).toThrow(/Starburst effect requires a parameters object/);
  });

  it('has the schema and internals of the published package', () => {
    expect(Object.keys(starburstEffectSchema)).toEqual(['rays', 'colors', 'rotation', 'smoothness', 'origin']);
    expect(starburstEffectSchema.origin).toMatchObject({ type: 'uv-coordinate', default: [0.5, 0.5] });
    expect(StarburstInternals.starburst).toBe(starburst);
  });
});
