import { describe, expect, it } from 'vitest';
import {
  blur,
  dropShadow,
  linearGradient,
  motionBlur,
  radialGradient,
  type Keyframe,
  type Layout,
} from '@kinetograph/scene';
import { Ellipse, Image, Layer, MeshGradient, Noise, Path, Rect, Shape, Text } from '../src/index.js';
import { layersOf } from './harness.js';

const ramp: Keyframe[] = [
  { frame: 0, value: 0 },
  { frame: 30, value: 100, easing: 'easeOut' },
];

describe('<Layer>', () => {
  it('is a group with its children, bottom first', () => {
    expect(
      layersOf(
        <Layer id="stack">
          <Rect id="back" width={10} height={10} fill="#f00" />
          <Rect id="front" width={5} height={5} fill="#00f" />
        </Layer>,
      ),
    ).toEqual([
      {
        id: 'stack',
        type: 'group',
        children: [
          { id: 'back', type: 'shape', shape: { kind: 'rect', width: 10, height: 10 }, fill: '#f00' },
          { id: 'front', type: 'shape', shape: { kind: 'rect', width: 5, height: 5 }, fill: '#00f' },
        ],
      },
    ]);
  });

  it('takes preserve3d and layout', () => {
    const layout: Layout = { flexDirection: 'column', justifyContent: 'center', gap: 24, padding: [0, 40, 0, 40], width: 1080 };
    expect(layersOf(<Layer id="g" preserve3d layout={layout} />)).toEqual([
      { id: 'g', type: 'group', preserve3d: true, layout, children: [] },
    ]);
  });

  it('takes passThrough, so the children blend with what is behind the layer', () => {
    expect(layersOf(<Layer id="g" passThrough />)).toEqual([{ id: 'g', type: 'group', passThrough: true, children: [] }]);
  });

  it('renders several roots in order', () => {
    expect(layersOf([<Layer key="a" id="a" />, <Layer key="b" id="b" />]).map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('common props', () => {
  it('map the transform props to transform.*', () => {
    const [layer] = layersOf(
      <Layer
        id="t"
        x={1}
        y={2}
        scale={1.5}
        rotation={30}
        anchorX={4}
        anchorY={5}
        rotateX={6}
        rotateY={7}
        z={8}
        originX={0.25}
        originY={0.75}
      />,
    );
    expect(layer).toEqual({
      id: 't',
      type: 'group',
      children: [],
      transform: { x: 1, y: 2, scale: 1.5, rotation: 30, anchorX: 4, anchorY: 5, originX: 0.25, originY: 0.75, rotateX: 6, rotateY: 7, z: 8 },
    });
  });

  it('pass keyframe lists through', () => {
    const [layer] = layersOf(<Layer id="k" x={ramp} opacity={ramp} />);
    expect(layer).toMatchObject({ transform: { x: ramp }, opacity: ramp });
  });

  it('leave out transform when no transform prop is set, and skip undefined props', () => {
    const [layer] = layersOf(<Layer id="plain" x={undefined} opacity={undefined} />);
    expect(layer).toEqual({ id: 'plain', type: 'group', children: [] });
    expect(Object.keys(layer!)).toEqual(['id', 'type', 'children']);
  });

  it('keep zero values', () => {
    const [layer] = layersOf(<Layer id="z" x={0} opacity={0} />);
    expect(layer).toMatchObject({ transform: { x: 0 }, opacity: 0 });
  });

  it("turn origin='center' into originX = originY = 0.5", () => {
    expect(layersOf(<Layer id="o" origin="center" />)[0]).toMatchObject({ transform: { originX: 0.5, originY: 0.5 } });
  });

  it('turn origin=[ox, oy] into originX and originY', () => {
    expect(layersOf(<Layer id="o" origin={[0, 1]} />)[0]).toMatchObject({ transform: { originX: 0, originY: 1 } });
  });

  it('let an explicit originX override the sugar', () => {
    expect(layersOf(<Layer id="o" origin="center" originX={0.1} />)[0]).toMatchObject({ transform: { originX: 0.1, originY: 0.5 } });
  });

  it('reject a malformed origin', () => {
    // @ts-expect-error not an allowed origin
    expect(() => layersOf(<Layer id="o" origin="middle" />)).toThrow(/origin must be 'center'/);
  });

  it('pass opacity, blendMode, clip, mask, matte and layoutItem through under the same names', () => {
    const clip = { kind: 'inset', top: 4, radius: 12 } as const;
    const mask = { mode: 'luminance', gradient: radialGradient(['#fff', '#000']) } as const;
    const matte = { layer: 'word', mode: 'alphaInverted' } as const;
    const layoutItem = { flexGrow: 1, margin: 8, position: 'absolute' } as const;
    expect(layersOf(<Layer id="c" opacity={0.5} blendMode="multiply" clip={clip} mask={mask} matte={matte} layoutItem={layoutItem} />)[0]).toEqual({
      id: 'c',
      type: 'group',
      children: [],
      opacity: 0.5,
      blendMode: 'multiply',
      clip,
      mask,
      matte,
      layoutItem,
    });
  });

  it('emit effects in order', () => {
    const effects = [dropShadow({ y: 12, blur: 24 }), blur(8)];
    expect(layersOf(<Layer id="e" effects={effects} />)[0]).toMatchObject({ effects });
  });

  it('ignore props they do not know', () => {
    // @ts-expect-error not a prop
    const [layer] = layersOf(<Layer id="u" colour="red" data-x={1} />);
    expect(layer).toEqual({ id: 'u', type: 'group', children: [] });
  });
});

describe('motion blur', () => {
  it('moves a motionBlur marker out of effects to the layer', () => {
    const [layer] = layersOf(<Layer id="m" effects={[motionBlur({ samples: 8 }), dropShadow({ y: 12, blur: 24 })]} />);
    expect(layer).toEqual({
      id: 'm',
      type: 'group',
      children: [],
      effects: [{ type: 'dropShadow', y: 12, blur: 24 }],
      motionBlur: { samples: 8 },
    });
  });

  it('leaves no effects array when the marker was the only entry', () => {
    const [layer] = layersOf(<Layer id="m" effects={[motionBlur({ samples: 12, shutter: 1 })]} />);
    expect(layer).toEqual({ id: 'm', type: 'group', children: [], motionBlur: { samples: 12, shutter: 1 } });
  });

  it('takes the motionBlur prop', () => {
    expect(layersOf(<Layer id="m" motionBlur={{ samples: 4, shutter: 0.25 }} />)[0]).toMatchObject({ motionBlur: { samples: 4, shutter: 0.25 } });
    expect(layersOf(<Layer id="m" motionBlur={{}} />)[0]).toMatchObject({ motionBlur: {} });
  });

  it('merges a marker with the prop, the prop winning field by field', () => {
    const [layer] = layersOf(<Layer id="m" effects={[motionBlur({ samples: 8, shutter: 1 })]} motionBlur={{ samples: 16 }} />);
    expect(layer).toMatchObject({ motionBlur: { samples: 16, shutter: 1 } });
  });

  it('works on leaf layers', () => {
    expect(layersOf(<Rect id="r" width={1} height={1} effects={[motionBlur()]} />)[0]).toMatchObject({ motionBlur: {} });
  });

  it('keeps a keyframed shutter given through a marker', () => {
    expect(layersOf(<Layer id="m" effects={[motionBlur({ shutter: ramp })]} />)[0]).toMatchObject({ motionBlur: { shutter: ramp } });
  });
});

describe('shapes', () => {
  it('<Shape kind> covers the four kinds', () => {
    expect(layersOf(<Shape id="a" kind="rect" width={10} height={20} fill="#f00" />)[0]).toEqual({
      id: 'a',
      type: 'shape',
      shape: { kind: 'rect', width: 10, height: 20 },
      fill: '#f00',
    });
    expect(layersOf(<Shape id="b" kind="roundedRect" width={10} height={20} radius={4} />)[0]).toMatchObject({
      shape: { kind: 'roundedRect', width: 10, height: 20, radius: 4 },
    });
    expect(layersOf(<Shape id="c" kind="ellipse" width={10} height={20} />)[0]).toMatchObject({
      shape: { kind: 'ellipse', width: 10, height: 20 },
    });
    expect(layersOf(<Shape id="d" kind="path" d="M0 0L10 10" stroke={{ color: '#fff', width: 2 }} />)[0]).toEqual({
      id: 'd',
      type: 'shape',
      shape: { kind: 'path', d: 'M0 0L10 10' },
      stroke: { color: '#fff', width: 2 },
    });
  });

  it('<Shape kind="roundedRect"> without a radius has radius 0', () => {
    expect(layersOf(<Shape id="b" kind="roundedRect" width={1} height={1} />)[0]).toMatchObject({
      shape: { kind: 'roundedRect', width: 1, height: 1, radius: 0 },
    });
  });

  it('<Shape> rejects an unknown kind', () => {
    // @ts-expect-error not a kind
    expect(() => layersOf(<Shape id="x" kind="star" />)).toThrow(/kind must be rect/);
  });

  it('<Rect> is a rect, or a roundedRect when radius > 0', () => {
    expect(layersOf(<Rect id="r" width={400} height={240} fill="#f6c177" />)[0]).toEqual({
      id: 'r',
      type: 'shape',
      shape: { kind: 'rect', width: 400, height: 240 },
      fill: '#f6c177',
    });
    expect(layersOf(<Rect id="r" width={400} height={240} radius={24} />)[0]).toMatchObject({
      shape: { kind: 'roundedRect', width: 400, height: 240, radius: 24 },
    });
    expect(layersOf(<Rect id="r" width={400} height={240} radius={0} />)[0]).toMatchObject({ shape: { kind: 'rect' } });
  });

  it('<Rect> with an animated radius is a roundedRect when any keyframe rounds it', () => {
    expect(layersOf(<Rect id="r" width={1} height={1} radius={ramp} />)[0]).toMatchObject({
      shape: { kind: 'roundedRect', radius: ramp },
    });
    expect(layersOf(<Rect id="r" width={1} height={1} radius={[{ frame: 0, value: 0 }, { frame: 9, value: 0 }]} />)[0]).toMatchObject({
      shape: { kind: 'rect' },
    });
  });

  it('<Rect> takes animated sizes, a gradient fill and a stroke', () => {
    const fill = linearGradient(['#ff4d4d', '#2f6bff'], { angle: 135 });
    expect(layersOf(<Rect id="r" width={ramp} height={5} fill={fill} stroke={{ color: '#fff', width: 4 }} />)[0]).toEqual({
      id: 'r',
      type: 'shape',
      shape: { kind: 'rect', width: ramp, height: 5 },
      fill,
      stroke: { color: '#fff', width: 4 },
    });
  });

  it('<Ellipse> and <Path>', () => {
    expect(layersOf(<Ellipse id="e" width={20} height={10} fill="#0f0" />)[0]).toEqual({
      id: 'e',
      type: 'shape',
      shape: { kind: 'ellipse', width: 20, height: 10 },
      fill: '#0f0',
    });
    expect(layersOf(<Path id="p" d="M0 0L5 5Z" fill="#00f" />)[0]).toEqual({
      id: 'p',
      type: 'shape',
      shape: { kind: 'path', d: 'M0 0L5 5Z' },
      fill: '#00f',
    });
  });

  it('shape elements cannot have children', () => {
    // @ts-expect-error Rect takes no children
    expect(() => layersOf(<Rect id="r" width={1} height={1}><Rect width={1} height={1} /></Rect>)).toThrow(/<Rect> cannot have children/);
  });
});

describe('<Text>', () => {
  it('is a text layer, the font through fontKey', () => {
    expect(layersOf(<Text id="t" font="DM Sans" size={64} color="#ffffff">Hello</Text>)[0]).toEqual({
      id: 't',
      type: 'text',
      text: 'Hello',
      font: 'DM Sans',
      size: 64,
      color: '#ffffff',
    });
  });

  it('concatenates string and number children, however they are split', () => {
    const n = 3;
    expect(layersOf(<Text id="t" font="Inter" size={10}>Round {n} of {n * 2}</Text>)[0]).toMatchObject({ text: 'Round 3 of 6' });
    expect(layersOf(<Text id="t" font="Inter" size={10}>{['a', 'b', 1]}{null}{false}{'c'}</Text>)[0]).toMatchObject({ text: 'ab1c' });
    expect(layersOf(<Text id="t" font="Inter" size={10}>{'Hello\nworld'}</Text>)[0]).toMatchObject({ text: 'Hello\nworld' });
    expect(layersOf(<Text id="t" font="Inter" size={10} />)[0]).toMatchObject({ text: '' });
  });

  it('turns font, weight and fontStyle into the font key', () => {
    const key = (props: { weight?: number | string; fontStyle?: 'normal' | 'italic' }) =>
      (layersOf(<Text id="t" font="Inter" size={10} {...props}>x</Text>)[0] as { font: string }).font;
    expect(key({})).toBe('Inter');
    expect(key({ weight: 400 })).toBe('Inter');
    expect(key({ weight: 700 })).toBe('Inter:700');
    expect(key({ weight: 'bold' })).toBe('Inter:700');
    expect(key({ fontStyle: 'italic' })).toBe('Inter:400i');
    expect(key({ weight: 700, fontStyle: 'italic' })).toBe('Inter:700i');
  });

  it('takes color or its alias fill, color winning', () => {
    const gradient = linearGradient(['#f9a', '#fc6']);
    expect(layersOf(<Text id="t" font="Inter" size={64} fill={gradient}>gets better</Text>)[0]).toMatchObject({ color: gradient });
    expect(layersOf(<Text id="t" font="Inter" size={64} color="#fff" fill="#000">x</Text>)[0]).toMatchObject({ color: '#fff' });
    expect('color' in layersOf(<Text id="t" font="Inter" size={64}>x</Text>)[0]!).toBe(false);
  });

  it('takes lineHeight, maxWidth and align', () => {
    expect(layersOf(<Text id="t" font="Inter" size={64} lineHeight={1.2} maxWidth={600} align="center">x</Text>)[0]).toMatchObject({
      lineHeight: 1.2,
      maxWidth: 600,
      align: 'center',
    });
  });

  it('passes a chars array through, undefined entries becoming null', () => {
    const chars = [{ y: -4, opacity: 0.5 }, null, undefined, { color: '#f00', scale: 1.2, rotation: 5, x: 1 }];
    expect(layersOf(<Text id="t" font="Inter" size={10} chars={chars as never}>abcd</Text>)[0]).toMatchObject({
      chars: [{ y: -4, opacity: 0.5 }, null, null, { color: '#f00', scale: 1.2, rotation: 5, x: 1 }],
    });
  });

  it('evaluates a chars function over the code points', () => {
    const calls: [string, number, number][] = [];
    const [layer] = layersOf(
      <Text
        id="t"
        font="Inter"
        size={10}
        chars={(char, index, count) => {
          calls.push([char, index, count]);
          return index % 2 === 0 ? { y: index * 10 } : null;
        }}
      >
        abc
      </Text>,
    );
    expect(calls).toEqual([
      ['a', 0, 3],
      ['b', 1, 3],
      ['c', 2, 3],
    ]);
    expect(layer).toMatchObject({ chars: [{ y: 0 }, null, { y: 20 }] });
  });

  it('counts code points, not UTF-16 units, and gives \\n an entry', () => {
    const seen: string[] = [];
    const [layer] = layersOf(
      <Text id="t" font="Inter" size={10} chars={(char) => { seen.push(char); return undefined; }}>{'a😀\nb'}</Text>,
    );
    expect(seen).toEqual(['a', '😀', '\n', 'b']);
    expect((layer as { chars: unknown[] }).chars).toEqual([null, null, null, null]);
  });

  it('evaluates chars for the text of the current render', () => {
    const [layer] = layersOf(<Text id="t" font="Inter" size={10} chars={(_c, i, n) => ({ x: i / n })}>{`ab${'c'}`}</Text>);
    expect(layer).toMatchObject({ text: 'abc', chars: [{ x: 0 }, { x: 1 / 3 }, { x: 2 / 3 }] });
  });

  it('rejects an element inside <Text>', () => {
    expect(() => layersOf(<Text id="t" font="Inter" size={10}>hi <Rect width={1} height={1} /></Text>)).toThrow(
      /<Rect> cannot be inside <Text>/,
    );
  });
});

describe('<Image>, <Noise>, <MeshGradient>', () => {
  it('<Image> maps src, width, height and fit', () => {
    expect(layersOf(<Image id="i" src="/abs/model.jpg" fit="cover" />)[0]).toEqual({ id: 'i', type: 'image', src: '/abs/model.jpg', fit: 'cover' });
    expect(layersOf(<Image id="i" src="a.png" width={256} height={ramp} />)[0]).toEqual({
      id: 'i',
      type: 'image',
      src: 'a.png',
      width: 256,
      height: ramp,
    });
  });

  it('<Noise> maps its fields', () => {
    const turbulence = { type: 'fractalNoise', baseFrequency: 0.01, numOctaves: 4, seed: 3 } as const;
    expect(layersOf(<Noise id="n" width={480} height={270} turbulence={turbulence} channels="gray" />)[0]).toEqual({
      id: 'n',
      type: 'noise',
      width: 480,
      height: 270,
      turbulence,
      channels: 'gray',
    });
  });

  it('<MeshGradient> maps its fields', () => {
    const colors = ['#f00', '#0f0', '#00f', '#fff'];
    const points: [number, number][] = [[0, 0], [480, 0], [0, 270], [480, 270]];
    expect(layersOf(<MeshGradient id="m" width={480} height={270} columns={2} rows={2} points={points} colors={colors} />)[0]).toEqual({
      id: 'm',
      type: 'meshGradient',
      width: 480,
      height: 270,
      columns: 2,
      rows: 2,
      points,
      colors,
    });
    expect(layersOf(<MeshGradient id="m" width={4} height={4} colors={colors} />)[0]).toEqual({
      id: 'm',
      type: 'meshGradient',
      width: 4,
      height: 4,
      colors,
    });
  });

  it('carry the common props too', () => {
    expect(layersOf(<Image id="i" src="a.png" x={5} opacity={0.5} effects={[blur(4)]} />)[0]).toMatchObject({
      transform: { x: 5 },
      opacity: 0.5,
      effects: [{ type: 'blur', radius: 4 }],
    });
  });
});
