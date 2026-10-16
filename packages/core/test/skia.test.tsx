// `@remotion/skia` and `@shopify/react-native-skia` (docs/AUTHORING.md §7.7) on the optional Skia addon. They run when
// `@kinetograph/skia` is built (`npm run build:addon:release -w crates/skia/node`) and are skipped when it is not, as the
// default workspace build does not compile Skia.

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFonts, registerFont } from '../src/font-registry.js';
import {
  Atlas,
  BlurMask,
  Canvas,
  Circle,
  ColorMatrix,
  Group,
  hasSkiaAddon,
  Image,
  LinearGradient,
  Mask,
  matchFont,
  Paint,
  Path,
  Rect,
  Shader,
  Skia,
  SkiaCanvas,
  Text,
  useImage,
} from '../src/skia/index.js';
import { renderNodes } from '../src/skia/host.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { renderDom } from './dom-harness.js';
import { pixel, readPng } from './skia-png.js';

const FONT = join(import.meta.dirname, '../../../assets/fonts/DMSans-Medium.ttf');

/** Draws `children` in a 64 x 48 canvas through the DOM renderer and reads the PNG the canvas became. */
function draw(children: React.ReactNode, frame = 0) {
  const tree = renderDom(<Canvas width={64} height={48}>{children}</Canvas>, frame);
  const layer = tree.layers[0] as { type: string; src: string };
  expect(layer.type).toBe('image');
  return { src: layer.src, picture: readPng(layer.src) };
}

beforeEach(() => clearReportedUnsupported());
afterEach(() => clearFonts());

describe('the nodes the components make', () => {
  it('makes the node of RN-Skia with its defaults, colours as floats and transforms as a list', () => {
    const [group] = renderNodes(
      <Group color="#ff0000" transform={[{ translate: [3, 4] }, { rotate: 1 }]}>
        <Path path="M0 0L1 1" />
      </Group>,
    );
    expect(group).toEqual({
      type: 'Group',
      props: { color: [1, 0, 0, 1], transform: [{ translateX: 3 }, { translateY: 4 }, { rotate: 1 }] },
      children: [{ type: 'Path', props: { start: 0, end: 1, path: 'M0 0L1 1' }, children: [] }],
    });
  });

  it('turns a group with a layer element into a Layer around the paint and the group', () => {
    const [layer] = renderNodes(<Group layer={<Paint blendMode="multiply" />}><Rect x={0} y={0} width={1} height={1} /></Group>);
    expect(layer!.type).toBe('Layer');
    expect(layer!.children.map((c) => c.type)).toEqual(['Paint', 'Group']);
  });

  it('serialises Skia objects: paths, paints, matrices and runtime effects', () => {
    const path = Skia.Path.Make().moveTo(0, 0).lineTo(4, 0).lineTo(4, 4).close();
    const [node] = renderNodes(<Path path={path} />);
    expect(node!.props.path).toEqual({ d: 'M0 0 L4 0 L4 4 Z', fillType: 'winding' });
    expect(JSON.parse(JSON.stringify(Skia.Paint().setColor(Skia.Color('blue')).setStrokeWidth(2)))).toEqual({
      type: 'Paint',
      props: { color: [0, 0, 1, 1], strokeWidth: 2 },
      children: [],
    });
    expect(Skia.Matrix().translate(2, 3).toJSON()).toEqual([1, 0, 2, 0, 1, 3, 0, 0, 1]);
  });

  it('refuses text outside <Text>', () => {
    expect(() => renderNodes(<Group>hello</Group>)).toThrow('Raw text "hello"');
  });
});

describe.skipIf(!hasSkiaAddon())('drawn by Skia', () => {
  it('fills a rect with the colour of its group', () => {
    const { picture } = draw(<Group color="red"><Rect x={4} y={4} width={20} height={20} /></Group>);
    expect(pixel(picture, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 40, 10)[3]).toBe(0);
  });

  it('is a function of the tree: equal trees are the same file, and a frame-driven prop changes it', () => {
    const at = (frame: number) => draw(<Rect x={frame} y={0} width={10} height={10} color="blue" />, frame).src;
    expect(at(0)).toBe(at(0));
    expect(at(0)).not.toBe(at(5));
  });

  it('combines paths with Skia: a union covers both, a difference leaves the first minus the second', () => {
    const square = (x: number, y: number) => Skia.Path.Make().addRect(Skia.XYWHRect(x, y, 20, 20));
    const union = Skia.Path.MakeFromOp(square(0, 0), square(10, 10), 'union');
    const minus = Skia.Path.MakeFromOp(square(0, 0), square(10, 10), 'difference');
    expect(union.getBounds()).toMatchObject({ x: 0, y: 0, width: 30, height: 30 });
    const { picture } = draw(
      <>
        <Path path={union} color="red" />
        <Group transform={[{ translateX: 32 }]}><Path path={minus} color="lime" /></Group>
      </>,
    );
    expect(pixel(picture, 25, 25)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 32 + 15, 15)[3]).toBe(0);
    expect(pixel(picture, 32 + 5, 5)).toEqual([0, 255, 0, 255]);
  });

  it('draws gradients from CSS colours', () => {
    const { picture } = draw(
      <Rect x={0} y={0} width={64} height={48}>
        <LinearGradient start={{ x: 0, y: 0 }} end={{ x: 64, y: 0 }} colors={['#ff0000', '#0000ff']} />
      </Rect>,
    );
    expect(pixel(picture, 1, 20)[0]).toBeGreaterThan(240);
    expect(pixel(picture, 62, 20)[2]).toBeGreaterThan(240);
  });

  it('runs an SkSL shader with its uniforms', () => {
    const source = Skia.RuntimeEffect.Make('uniform float3 tint; half4 main(float2 p) { return half4(tint, 1); }')!;
    expect(source.getUniformCount()).toBe(1);
    const { picture } = draw(
      <Rect x={0} y={0} width={64} height={48}>
        <Shader source={source} uniforms={{ tint: [0, 1, 0] }} />
      </Rect>,
    );
    expect(pixel(picture, 30, 20)).toEqual([0, 255, 0, 255]);
  });

  it('returns null and logs when SkSL does not compile', () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (message: unknown) => logged.push(message);
    try {
      expect(Skia.RuntimeEffect.Make('half4 main(float2 p) { return nope; }')).toBeNull();
    } finally {
      console.error = original;
    }
    expect(String(logged[0])).toContain('nope');
  });

  it('applies colour filters, blurs masks and clips with a circle', () => {
    // Swaps red and blue.
    const matrix = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    const { picture } = draw(
      <>
        <Group clip={Skia.Path.Make().addCircle(16, 24, 12)}>
          <Rect x={0} y={0} width={64} height={48} color="red"><ColorMatrix matrix={matrix} /></Rect>
        </Group>
        <Circle cx={48} cy={24} r={8} color="black"><BlurMask blur={4} style="normal" /></Circle>
      </>,
    );
    expect(pixel(picture, 16, 24)).toEqual([0, 0, 255, 255]);
    expect(pixel(picture, 2, 2)[3]).toBe(0);
    const edge = pixel(picture, 48 + 10, 24)[3];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('masks a drawing by another', () => {
    const { picture } = draw(
      <Mask mask={<Circle cx={32} cy={24} r={10} color="white" />}>
        <Rect x={0} y={0} width={64} height={48} color="red" />
      </Mask>,
    );
    expect(pixel(picture, 32, 24)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 2, 2)[3]).toBe(0);
  });

  it('draws text with a registered font, measures it, and refuses an unregistered one', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const font = matchFont({ fontFamily: 'DM Sans', fontSize: 24 });
    expect(font.getTextWidth('Hi')).toBeGreaterThan(15);
    expect(font.getMetrics().ascent).toBeLessThan(0);
    const { picture } = draw(<Text x={2} y={30} text="HHH" font={font} color="white" />);
    const inked = Array.from({ length: picture.width * picture.height }, (_, i) => picture.rgba[i * 4 + 3]!).filter((a) => a > 0).length;
    expect(inked).toBeGreaterThan(100);
    expect(() => matchFont({ fontFamily: 'Nope' })).toThrow('No font is registered as "Nope"');
  });

  it('reads a picture with useImage and draws it', () => {
    const { src } = draw(<Rect x={0} y={0} width={64} height={48} color="lime" />);
    const image = useImage(src)!;
    expect([image.width(), image.height()]).toEqual([64, 48]);
    const { picture } = draw(<Image image={image} x={0} y={0} width={64} height={48} />);
    expect(pixel(picture, 10, 10)).toEqual([0, 255, 0, 255]);
  });

  it('reports what it does not draw, once, and draws the rest', () => {
    const { picture } = draw(
      <>
        <Rect x={0} y={0} width={10} height={10} color="red" />
        <Atlas />
      </>,
    );
    expect(pixel(picture, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(reportedUnsupported().length).toBeGreaterThan(0);
  });

  it('takes its size from SkiaCanvas and from style', () => {
    const tree = renderDom(<SkiaCanvas width={30} height={20}><Rect x={0} y={0} width={5} height={5} color="red" /></SkiaCanvas>);
    const layer = tree.layers[0] as { width: number; height: number; src: string };
    expect([layer.width, layer.height]).toEqual([30, 20]);
    expect([readPng(layer.src).width, readPng(layer.src).height]).toEqual([30, 20]);
  });
});
