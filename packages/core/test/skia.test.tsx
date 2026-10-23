// `@remotion/skia` and `@shopify/react-native-skia` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.7) on the optional Skia addon. They run when
// `@kinetograph/skia` is built (`npm run build:addon:release -w crates/skia/node`) and are skipped when it is not, as the
// default workspace build does not compile Skia.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFonts, registerFont } from '../src/font-registry.js';
import {
  Atlas,
  BlurMask,
  Canvas,
  Circle,
  ColorMatrix,
  createPicture,
  Glyphs,
  Group,
  hasSkiaAddon,
  ImageSVG,
  Image,
  LinearGradient,
  Mask,
  matchFont,
  Paint,
  Patch,
  Path,
  Picture,
  Rect,
  Shader,
  Skia,
  SkiaCanvas,
  Text,
  TextBlob,
  useImage,
  useSVG,
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

  it('serialises the objects of the six drawings: blobs, pictures, SVGs and RSXforms', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const font = matchFont({ fontFamily: 'DM Sans', fontSize: 20 });
    const blob = Skia.TextBlob.MakeFromRSXform('Hi', [Skia.RSXform(1, 0, 2, 3), Skia.RSXform(1, 0, 12, 3)], font);
    const [node] = renderNodes(<TextBlob blob={blob} x={4} />);
    expect(node!.props).toEqual({
      x: 4,
      y: 0,
      blob: {
        text: 'Hi',
        xforms: [{ scos: 1, ssin: 0, tx: 2, ty: 3 }, { scos: 1, ssin: 0, tx: 12, ty: 3 }],
        font: { file: FONT, size: 20 },
      },
    });
    expect(Skia.TextBlob.MakeFromGlyphs([3, 4], font).toJSON()).toMatchObject({ glyphs: [3, 4] });
    expect(Skia.RSXformFromRadians(2, 0, 10, 20, 1, 1)).toEqual({ scos: 2, ssin: 0, tx: 8, ty: 18 });
  });

  it('records a picture as operations, copying what it was given', () => {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 10, 10));
    const paint = Skia.Paint().setColor(Skia.Color('red'));
    canvas.save().translate(2, 3).drawRect(Skia.XYWHRect(0, 0, 4, 4), paint).restore();
    paint.setColor(Skia.Color('blue'));
    canvas.drawCircle(5, 5, 2, paint);
    const [node] = renderNodes(<Picture picture={recorder.finishRecordingAsPicture()} />);
    const picture = node!.props.picture as { ops: Record<string, any>[]; bounds: unknown };
    expect(picture.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(picture.ops.map((op) => op.op)).toEqual(['save', 'translate', 'drawRect', 'restore', 'drawCircle']);
    expect(picture.ops[2]!.paint.props.color).toEqual([1, 0, 0, 1]);
    expect(picture.ops[4]!.paint.props.color).toEqual([0, 0, 1, 1]);
    expect(createPicture((c) => c.drawColor(Skia.Color('lime'))).toJSON().ops).toEqual([
      { op: 'drawColor', color: [0, 1, 0, 1] },
    ]);
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


  it('draws an Atlas: every sprite at its transform, tinted by colors', () => {
    const { src } = draw(<Rect x={0} y={0} width={2} height={2} color="blue" />);
    const sheet = useImage(src)!;
    const sprites = [Skia.XYWHRect(0, 0, 2, 2), Skia.XYWHRect(0, 0, 2, 2)];
    const transforms = [Skia.RSXform(5, 0, 4, 4), Skia.RSXform(3, 0, 40, 30)];
    const { picture } = draw(<Atlas image={sheet} sprites={sprites} transforms={transforms} />);
    expect(pixel(picture, 8, 8)).toEqual([0, 0, 255, 255]);
    expect(pixel(picture, 43, 33)).toEqual([0, 0, 255, 255]);
    expect(pixel(picture, 25, 20)[3]).toBe(0);
    const tinted = draw(<Atlas image={sheet} sprites={sprites} transforms={transforms} colors={['red', 'lime']} colorBlendMode="dst" />);
    expect(pixel(tinted.picture, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(tinted.picture, 43, 33)).toEqual([0, 255, 0, 255]);
  });

  it('draws a Patch with the colours of its corners', () => {
    const corner = (x: number, y: number, c1: [number, number], c2: [number, number]) => ({
      pos: { x, y },
      c1: { x: c1[0], y: c1[1] },
      c2: { x: c2[0], y: c2[1] },
    });
    const patch = [
      corner(0, 0, [0, 16], [21, 0]),
      corner(64, 0, [43, 0], [64, 16]),
      corner(64, 48, [64, 32], [43, 48]),
      corner(0, 48, [21, 48], [0, 32]),
    ];
    const { picture } = draw(<Patch patch={patch} colors={['red', 'lime', 'blue', 'yellow']} />);
    expect(pixel(picture, 2, 2)[0]).toBeGreaterThan(200);
    expect(pixel(picture, 61, 2)[1]).toBeGreaterThan(200);
    expect(pixel(picture, 61, 45)[2]).toBeGreaterThan(200);
    const mid = pixel(picture, 32, 24);
    expect(mid[3]).toBe(255);
    expect(mid[0]).toBeGreaterThan(60);
  });

  it('draws TextBlob and Glyphs like Text, and a blob with transforms where they say', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const font = matchFont({ fontFamily: 'DM Sans', fontSize: 24 });
    const text = draw(<Text x={2} y={30} text="Hi" font={font} color="white" />);
    const blob = draw(<TextBlob blob={Skia.TextBlob.MakeFromText('Hi', font)} x={2} y={30} color="white" />);
    expect(blob.src).toBe(text.src);
    const widths = font.getGlyphWidths('Hi');
    const glyphs = font.getGlyphIDs('Hi').map((id, i) => ({ id, pos: { x: widths.slice(0, i).reduce((a, b) => a + b, 0), y: 0 } }));
    expect(draw(<Glyphs font={font} glyphs={glyphs} x={2} y={30} color="white" />).src).toBe(text.src);
    const moved = draw(<TextBlob blob={Skia.TextBlob.MakeFromRSXform('Hi', glyphs.map((g) => Skia.RSXform(1, 0, 2 + g.pos.x, 30)), font)} color="white" />);
    expect(moved.src).toBe(text.src);
  });

  it('draws a recorded Picture once, with the paints it was recorded with', () => {
    const picture = createPicture((canvas) => {
      canvas.save();
      canvas.translate(10, 10);
      canvas.drawRect(Skia.XYWHRect(0, 0, 20, 20), Skia.Paint().setColor(Skia.Color('red')));
      canvas.restore();
      canvas.drawCircle(50, 24, 6, Skia.Paint().setColor(Skia.Color('lime')));
    });
    const { picture: drawn } = draw(<Picture picture={picture} />);
    expect(pixel(drawn, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(drawn, 5, 5)[3]).toBe(0);
    expect(pixel(drawn, 50, 24)).toEqual([0, 255, 0, 255]);
  });

  it('draws an ImageSVG made from a string and from a file, in its rectangle', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>';
    const svg = Skia.SVG.MakeFromString(source)!;
    expect([svg.width(), svg.height()]).toEqual([10, 10]);
    const { picture } = draw(<ImageSVG svg={svg} x={4} y={4} width={30} height={30} />);
    expect(pixel(picture, 6, 6)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 32, 32)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 40, 10)[3]).toBe(0);
    const file = join(tmpdir(), 'kinetograph-skia-test.svg');
    writeFileSync(file, source);
    expect(draw(<ImageSVG svg={useSVG(file)} x={4} y={4} width={30} height={30} />).src).toBe(draw(<ImageSVG svg={svg} x={4} y={4} width={30} height={30} />).src);
    expect(Skia.SVG.MakeFromString('not an svg')).toBeNull();
  });

  it('reports what it does not draw, once, and draws the rest', () => {
    const { picture } = draw(
      <>
        <Rect x={0} y={0} width={10} height={10} color="red" />
        {createElement('Hologram')}
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
