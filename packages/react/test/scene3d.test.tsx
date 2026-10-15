import { describe, expect, it } from 'vitest';
import { blur, type Keyframe, type Scene3DLayer } from '@kinetograph/scene';
import {
  AmbientLight,
  Camera3D,
  DirectionalLight,
  Extrude,
  Group3D,
  Layer,
  Mesh,
  Model,
  PointLight,
  Rect,
  Scene3D,
  Text3D,
} from '../src/index.js';
import { layersOf } from './harness.js';

const turn: Keyframe[] = [
  { frame: 0, value: 0 },
  { frame: 30, value: 90 },
];

const only = (node: Parameters<typeof layersOf>[0]) => layersOf(node)[0] as Scene3DLayer;

describe('<Scene3D>', () => {
  it('is a scene3d layer with a camera, lights and objects', () => {
    expect(
      only(
        <Scene3D id="hero" width={480} height={270} msaa={1} x={10} opacity={0.5} effects={[blur(4)]}>
          <Camera3D fov={40} position={[0, 2, 8]} target={[0, 0.5, 0]} />
          <AmbientLight intensity={0.3} color="#aab4ff" />
          <DirectionalLight direction={[-1, -1, -1]} intensity={1.5} />
          <PointLight position={[2, 3, 4]} intensity={12} range={9} />
          <Mesh id="ball" geometry={{ kind: 'sphere', radius: 1 }} material={{ color: '#e76f51', roughness: 0.3 }} position={[0, 1, 0]} />
        </Scene3D>,
      ),
    ).toEqual({
      id: 'hero',
      type: 'scene3d',
      width: 480,
      height: 270,
      msaa: 1,
      camera: { fov: 40, position: [0, 2, 8], target: [0, 0.5, 0] },
      lights: [
        { type: 'ambient', color: '#aab4ff', intensity: 0.3 },
        { type: 'directional', direction: [-1, -1, -1], intensity: 1.5 },
        { type: 'point', position: [2, 3, 4], intensity: 12, range: 9 },
      ],
      objects: [
        {
          type: 'mesh',
          id: 'ball',
          geometry: { kind: 'sphere', radius: 1 },
          material: { color: '#e76f51', roughness: 0.3 },
          position: [0, 1, 0],
        },
      ],
      transform: { x: 10 },
      opacity: 0.5,
      effects: [{ type: 'blur', radius: 4 }],
    });
  });

  it('is a layer like any other: it sits in a <Layer> and gets an automatic id', () => {
    const [group] = layersOf(
      <Layer id="g">
        <Rect width={10} height={10} fill="#fff" />
        <Scene3D width={100} height={100} />
      </Layer>,
    );
    expect((group as { children: { id: string; type: string }[] }).children[1]).toEqual({
      id: '$0.1',
      type: 'scene3d',
      width: 100,
      height: 100,
    });
  });

  it('takes animated numbers anywhere a number goes', () => {
    const layer = only(
      <Scene3D width={100} height={100}>
        <Camera3D position={[[{ frame: 0, value: 0 }, { frame: 30, value: 5 }], 0, 8]} fov={turn} />
        <Mesh geometry={{ kind: 'box' }} rotation={[0, turn, 0]} scale={turn} />
      </Scene3D>,
    );
    expect(layer.camera?.fov).toEqual(turn);
    expect(layer.objects?.[0]).toMatchObject({ rotation: [0, turn, 0], scale: turn });
  });

  it('emits models, extruded text and paths, and groups with their children', () => {
    const layer = only(
      <Scene3D width={100} height={100}>
        <Model src="media/gem.glb" material={{ color: '#f4a261' }} scale={[1, 2, 1]} />
        <Text3D font="DM Sans" size={1.2} depth={0.4} align="left" lineHeight={1.1}>
          Hi {3}
        </Text3D>
        <Extrude path="M0 0H10V10Z" fillRule="evenodd" size={2} />
        <Group3D position={[1, 0, 0]} visible={false}>
          <Mesh geometry={{ kind: 'torus' }} />
        </Group3D>
      </Scene3D>,
    );
    expect(layer.objects).toEqual([
      { type: 'model', src: 'media/gem.glb', material: { color: '#f4a261' }, scale: [1, 2, 1] },
      { type: 'text', text: 'Hi 3', font: 'DM Sans', size: 1.2, depth: 0.4, align: 'left', lineHeight: 1.1 },
      { type: 'extrude', path: 'M0 0H10V10Z', size: 2, fillRule: 'evenodd' },
      { type: 'group', children: [{ type: 'mesh', geometry: { kind: 'torus' } }], position: [1, 0, 0], visible: false },
    ]);
  });

  it('maps a font weight and style to the font key, as <Text> does', () => {
    const layer = only(
      <Scene3D width={1} height={1}>
        <Text3D font="DM Sans" weight={700}>
          Bold
        </Text3D>
      </Scene3D>,
    );
    expect(layer.objects?.[0]).toMatchObject({ type: 'text', font: 'DM Sans:700' });
  });
});

describe('<Scene3D> errors', () => {
  it('needs a size', () => {
    // @ts-expect-error width and height are required
    expect(() => layersOf(<Scene3D height={1} />)).toThrow(/<Scene3D> needs a width/);
  });

  it('takes one camera', () => {
    expect(() =>
      layersOf(
        <Scene3D width={1} height={1}>
          <Camera3D />
          <Camera3D />
        </Scene3D>,
      ),
    ).toThrow(/one <Camera3D>/);
  });

  it('keeps the 3D elements inside a <Scene3D>', () => {
    expect(() => layersOf(<Mesh geometry={{ kind: 'box' }} />)).toThrow(/<Mesh> must be inside a <Scene3D>/);
    expect(() => layersOf(<Layer id="l"><AmbientLight /></Layer>)).toThrow(/<AmbientLight> must be inside a <Scene3D>/);
  });

  it('keeps 2D elements out of a <Scene3D>', () => {
    expect(() =>
      layersOf(
        <Scene3D width={1} height={1}>
          <Rect width={1} height={1} />
        </Scene3D>,
      ),
    ).toThrow(/<Rect> cannot be inside <Scene3D>/);
    expect(() =>
      layersOf(
        <Scene3D width={1} height={1}>
          <Group3D>
            <Layer id="x" />
          </Group3D>
        </Scene3D>,
      ),
    ).toThrow(/<Layer> cannot be inside <Group3D>/);
  });

  it('checks what each element needs', () => {
    const scene = (child: React.ReactNode) =>
      layersOf(
        <Scene3D width={1} height={1}>
          {child}
        </Scene3D>,
      );
    // @ts-expect-error a bad kind
    expect(() => scene(<Mesh geometry={{ kind: 'teapot' }} />)).toThrow(/geometry.kind must be box/);
    // @ts-expect-error a missing position
    expect(() => scene(<PointLight />)).toThrow(/<PointLight> needs a position/);
    // @ts-expect-error a missing src
    expect(() => scene(<Model />)).toThrow(/<Model> needs a src/);
    // @ts-expect-error a missing font
    expect(() => scene(<Text3D>x</Text3D>)).toThrow(/<Text3D> needs a font/);
    // @ts-expect-error a missing path
    expect(() => scene(<Extrude />)).toThrow(/<Extrude> needs a path/);
  });

  it('does not take raw text', () => {
    expect(() =>
      layersOf(
        <Scene3D width={1} height={1}>
          loose
        </Scene3D>,
      ),
    ).toThrow(/Raw text "loose" is not allowed inside <Scene3D>/);
  });

  it('keeps elements out of <Text3D>', () => {
    expect(() =>
      layersOf(
        <Scene3D width={1} height={1}>
          <Text3D font="DM Sans">
            <Mesh geometry={{ kind: 'box' }} />
          </Text3D>
        </Scene3D>,
      ),
    ).toThrow(/<Mesh> cannot be inside <Text>/);
  });
});
