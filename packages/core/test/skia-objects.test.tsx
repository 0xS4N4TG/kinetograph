// What a project makes with `Skia.*` and hooks rather than JSX (packages/cli/skills/kinetograph/references/AUTHORING.md
// §7.7): shared values, FitBox, surfaces and drawn elements, data, typefaces, animated pictures, paragraph
// measurement, paints with shaders and filters, and the text of an SVG. Skipped when `@kinetographdev/skia` is not built.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFonts, registerFont } from '../src/font-registry.js';
import { useCurrentFrame } from '../src/index.js';
import {
  Canvas,
  Circle,
  drawAsImage,
  drawAsPicture,
  FitBox,
  fitbox,
  hasSkiaAddon,
  Image,
  ImageSVG,
  matchFont,
  Picture,
  Rect,
  rect2rect,
  Skia,
  Text,
  useAnimatedImageValue,
  useClock,
  useVideo,
  usePathInterpolation,
} from '../src/skia/index.js';
import { renderNodes } from '../src/skia/host.js';
import { interpolate, useDerivedValue, useSharedValue, withTiming } from '../src/skia/reanimated.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { renderDom } from './dom-harness.js';
import { pixel, readPng } from './skia-png.js';

const FONT = join(import.meta.dirname, '../../../assets/fonts/DMSans-Medium.ttf');

function draw(children: React.ReactNode, frame = 0) {
  const tree = renderDom(<Canvas width={64} height={48}>{children}</Canvas>, frame);
  const layer = tree.layers[0] as { src: string };
  return { src: layer.src, picture: readPng(layer.src) };
}

const inked = (p: { width: number; height: number; rgba: Uint8Array }) =>
  Array.from({ length: p.width * p.height }, (_, i) => p.rgba[i * 4 + 3]!).filter((a) => a > 100).length;

/** A 2 x 2 GIF with one solid frame per colour, `delayCs` hundredths of a second each (LZW: a clear code before every pixel). */
function gif(colors: [number, number, number][], delayCs: number): Uint8Array {
  const out: number[] = [...Buffer.from('GIF89a'), 2, 0, 2, 0, 0x81, 0, 0];
  for (let i = 0; i < 4; i += 1) out.push(...(colors[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  colors.forEach((_, index) => {
    out.push(0x21, 0xf9, 4, 0x04, delayCs & 255, delayCs >> 8, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0);
    const codes = [4, index, 4, index, 4, index, 4, index, 5];
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += 3;
      while (bits >= 8) {
        bytes.push(acc & 255);
        acc >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) bytes.push(acc);
    out.push(2, bytes.length, ...bytes, 0);
  });
  out.push(0x3b);
  return Uint8Array.from(out);
}

beforeEach(() => clearReportedUnsupported());
afterEach(() => clearFonts());

describe('without the addon', () => {
  it('fits a box as RN-Skia does: rect2rect, fitbox and FitBox', () => {
    const src = { x: 0, y: 0, width: 10, height: 10 };
    const dst = { x: 0, y: 0, width: 40, height: 20 };
    expect(rect2rect(src, dst)).toEqual([{ translateX: 0 }, { translateY: 0 }, { scaleX: 4 }, { scaleY: 2 }]);
    expect(fitbox('contain', src, dst)).toEqual([{ translateX: 10 }, { translateY: 0 }, { scaleX: 2 }, { scaleY: 2 }]);
    const [group] = renderNodes(<FitBox src={src} dst={dst}><Rect x={0} y={0} width={10} height={10} /></FitBox>);
    expect(group!.type).toBe('Group');
    expect(group!.props.transform).toEqual([{ translateX: 10 }, { translateY: 0 }, { scaleX: 2 }, { scaleY: 2 }]);
  });

  it('serialises a paint with a shader and filters as a Paint node with declaration children', () => {
    const paint = Skia.Paint();
    paint.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 10, y: 0 }, ['red', 'blue'], null, 0));
    paint.setColorFilter(Skia.ColorFilter.MakeCompose(Skia.ColorFilter.MakeMatrix(new Array(20).fill(0)), Skia.ColorFilter.MakeLumaColorFilter()));
    paint.setImageFilter(Skia.ImageFilter.MakeBlur(2, 3, 'decal', Skia.ImageFilter.MakeOffset(1, 1)));
    paint.setMaskFilter(Skia.MaskFilter.MakeBlur(0, 4, true));
    paint.setPathEffect(Skia.PathEffect.MakeDash([2, 2], 0));
    const made = JSON.parse(JSON.stringify(paint));
    expect(made.children.map((c: { type: string }) => c.type)).toEqual([
      'LinearGradient',
      'MatrixColorFilter',
      'BlurImageFilter',
      'BlurMaskFilter',
      'DashPathEffect',
    ]);
    expect(made.children[0].props).toMatchObject({ start: { x: 0, y: 0 }, colors: [[1, 0, 0, 1], [0, 0, 1, 1]], mode: 'clamp' });
    expect(made.children[1].children[0].type).toBe('LumaColorFilter');
    expect(made.children[2].props).toEqual({ blur: { x: 2, y: 3 }, mode: 'decal' });
    expect(made.children[2].children[0]).toMatchObject({ type: 'OffsetImageFilter', props: { x: 1, y: 1 } });
    expect(made.children[3].props).toEqual({ style: 'normal', blur: 4, respectCTM: true });
  });

  it('turns shared values into their values, read after the effects ran', () => {
    function Grow() {
      const width = useSharedValue(10);
      const x = useDerivedValue(() => width.value / 2);
      useEffect(() => {
        width.value = 20;
      });
      return <Rect x={x} y={0} width={width} height={4} transform={[{ translateX: useDerivedLike(3) }]} />;
    }
    const [rect] = renderNodes(<Grow />);
    expect(rect!.props).toMatchObject({ x: 10, width: 20, transform: [{ translateX: 3 }] });
  });

  it('jumps a clock animation to its end and reports it', () => {
    expect(withTiming(5, { duration: 300 })).toBe(5);
    expect(reportedUnsupported().map((u) => u.property)).toContain('withTiming');
    expect(interpolate(2, [0, 1], [0, 10])).toBe(20);
    expect(interpolate(2, [0, 1], [0, 10], 'clamp')).toBe(10);
  });
});

/** A shared value made outside a component, for a check of the host alone. */
function useDerivedLike(value: number) {
  return { value, [Symbol.for('kinetograph.sharedValue')]: true };
}

describe.skipIf(!hasSkiaAddon())('drawn by Skia', () => {
  it('draws a frame-driven derived value and a clock', () => {
    function Moving() {
      const frame = useCurrentFrame();
      const x = useDerivedValue(() => frame * 4);
      const clock = useClock();
      return (
        <>
          <Rect x={x} y={0} width={8} height={8} color="red" />
          <Rect x={useDerivedValue(() => clock.value / 100)} y={20} width={4} height={4} color="lime" />
        </>
      );
    }
    const at5 = draw(<Moving />, 5).picture;
    expect(pixel(at5, 22, 4)).toEqual([255, 0, 0, 255]);
    expect(pixel(at5, 2, 4)[3]).toBe(0);
    // 5 frames at the harness's frame rate, in ms, over 100.
    expect(inked(at5)).toBeGreaterThan(64);
    expect(draw(<Moving />, 5).src).toBe(draw(<Moving />, 5).src);
  });

  it('draws FitBox children scaled into the box', () => {
    const { picture } = draw(
      <FitBox src={{ x: 0, y: 0, width: 10, height: 10 }} dst={{ x: 0, y: 0, width: 64, height: 48 }}>
        <Rect x={0} y={0} width={10} height={10} color="red" />
      </FitBox>,
    );
    expect(pixel(picture, 32, 24)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 4, 24)[3]).toBe(0);
  });

  it('snapshots an offscreen surface and reads its pixels', () => {
    const surface = Skia.Surface.MakeOffscreen(16, 16)!;
    surface.getCanvas().drawRect(Skia.XYWHRect(0, 0, 8, 16), Skia.Paint().setColor(Skia.Color('red')));
    surface.flush();
    const image = surface.makeImageSnapshot();
    expect([image.width(), image.height()]).toEqual([16, 16]);
    const pixels = image.readPixels();
    expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(pixels[(8 * 4) + 3]).toBe(0);
    const { picture } = draw(<Image image={image} x={0} y={0} width={64} height={48} fit="fill" />);
    expect(pixel(picture, 10, 24)).toEqual([255, 0, 0, 255]);
    expect(pixel(picture, 50, 24)[3]).toBe(0);
  });

  it('draws an element as an image and as a picture', () => {
    const image = drawAsImage(<Circle cx={8} cy={8} r={8} color="lime" />, { width: 16, height: 16 });
    const { picture } = draw(<Image image={image} x={0} y={0} width={32} height={32} fit="fill" />);
    expect(pixel(picture, 16, 16)).toEqual([0, 255, 0, 255]);
    const recorded = drawAsPicture(<Rect x={4} y={4} width={8} height={8} color="blue" />);
    expect(pixel(draw(<Picture picture={recorded} />).picture, 8, 8)).toEqual([0, 0, 255, 255]);
  });

  it('makes pictures from data: encoded bytes and raw pixels', () => {
    const surface = Skia.Surface.Make(4, 4)!;
    surface.getCanvas().drawColor(Skia.Color('blue'));
    const png = surface.makeImageSnapshot().encodeToBytes();
    const decoded = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(png))!;
    expect([decoded.width(), decoded.height()]).toEqual([4, 4]);
    expect(pixel(draw(<Image image={decoded} x={0} y={0} width={64} height={48} fit="fill" />).picture, 30, 20)).toEqual([0, 0, 255, 255]);
    expect(Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(Uint8Array.from([1, 2, 3])))).toBeNull();
    const raw = Skia.Image.MakeImage(
      { width: 2, height: 2, colorType: 4, alphaType: 3 },
      Skia.Data.fromBytes(Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255])),
      8,
    )!;
    expect(pixel(draw(<Image image={raw} x={0} y={0} width={64} height={48} fit="fill" />).picture, 30, 20)).toEqual([255, 0, 0, 255]);
  });

  it('makes fonts from data and from the font manager of the registered fonts', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(Skia.Data.fromBytes(readFileSync(FONT)))!;
    const fromData = draw(<Text x={2} y={30} text="Hi" font={Skia.Font(typeface, 24)} color="white" />);
    const fromFile = draw(<Text x={2} y={30} text="Hi" font={matchFont({ fontFamily: 'DM Sans', fontSize: 24 })} color="white" />);
    expect(fromData.src).toBe(fromFile.src);
    const manager = Skia.FontMgr.System();
    expect(manager.countFamilies()).toBe(1);
    expect(manager.getFamilyName(0)).toBe('DM Sans');
    const matched = manager.matchFamilyStyle('DM Sans', { weight: 700 })!;
    expect(draw(<Text x={2} y={30} text="Hi" font={Skia.Font(matched, 24)} color="white" />).src).toBe(fromFile.src);
    expect(manager.matchFamilyStyle('Nope')).toBeNull();
  });

  it('shows the frame of an animated picture for the time of the frame, looping', () => {
    const data = Skia.Data.fromBytes(gif([[255, 0, 0], [0, 255, 0], [0, 0, 255]], 10));
    function Player() {
      const image = useAnimatedImageValue(data);
      return <Image image={image} x={0} y={0} width={64} height={48} fit="fill" />;
    }
    // The harness renders at 30 fps: a frame of the GIF (100 ms) is 3 frames of the film.
    const colour = (frame: number) => pixel(draw(<Player />, frame).picture, 30, 20);
    expect(colour(0)).toEqual([255, 0, 0, 255]);
    expect(colour(3)).toEqual([0, 255, 0, 255]);
    expect(colour(6)).toEqual([0, 0, 255, 255]);
    expect(colour(9)).toEqual([255, 0, 0, 255]);
    const animated = Skia.AnimatedImage.MakeAnimatedImageFromEncoded(data)!;
    expect(animated.getFrameCount()).toBe(3);
    expect(animated.decodeNextFrame()).toBe(100);
    expect(pixel(draw(<Image image={animated.getCurrentFrame()} x={0} y={0} width={64} height={48} fit="fill" />).picture, 30, 20)).toEqual([0, 255, 0, 255]);
  });

  it('measures a paragraph laid out at a width', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const paragraph = Skia.ParagraphBuilder.Make({ textStyle: { fontSize: 20, color: 'white' } })
      .addText('one two three four five six')
      .build();
    paragraph.layout(1000);
    const oneLine = paragraph.getHeight();
    expect(paragraph.getLineMetrics()).toHaveLength(1);
    expect(paragraph.getMaxIntrinsicWidth()).toBeGreaterThan(150);
    paragraph.layout(80);
    expect(paragraph.getLineMetrics().length).toBeGreaterThan(2);
    expect(paragraph.getHeight()).toBeGreaterThan(oneLine * 2);
    expect(paragraph.getLongestLine()).toBeLessThanOrEqual(80);
    expect(paragraph.getRectsForRange(0, 3)[0]!.width).toBeGreaterThan(10);
    expect(paragraph.getGlyphPositionAtCoordinate(1, 5)).toBe(0);
  });

  it('draws with a Skia.Paint() that holds a shader and filters', () => {
    const paint = Skia.Paint();
    paint.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 64, y: 0 }, ['red', 'blue'], null, 'clamp'));
    const { picture } = draw(<Rect x={0} y={0} width={64} height={48} paint={paint} />);
    expect(pixel(picture, 1, 20)[0]).toBeGreaterThan(230);
    expect(pixel(picture, 62, 20)[2]).toBeGreaterThan(230);
    const swap = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    const filtered = Skia.Paint().setColor(Skia.Color('red')).setColorFilter(Skia.ColorFilter.MakeMatrix(swap));
    const recorded = Skia.PictureRecorder();
    recorded.beginRecording().drawRect(Skia.XYWHRect(0, 0, 10, 10), filtered);
    expect(pixel(draw(<Picture picture={recorded.finishRecordingAsPicture()} />).picture, 5, 5)).toEqual([0, 0, 255, 255]);
    const effect = Skia.RuntimeEffect.Make('uniform float3 tint; half4 main(float2 p) { return half4(tint, 1); }')!;
    const shaded = Skia.Paint().setShader(effect.makeShader([0, 1, 0]));
    expect(pixel(draw(<Rect x={0} y={0} width={64} height={48} paint={shaded} />).picture, 30, 20)).toEqual([0, 255, 0, 255]);
  });

  it('draws the text of an SVG in the registered font, and reports a font that is not registered', () => {
    registerFont({ family: 'DM Sans', path: FONT });
    const svg = (family: string) =>
      Skia.SVG.MakeFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><text x="2" y="36" font-size="30" font-family="${family}" fill="white">HH</text></svg>`,
      )!;
    const drawn = draw(<ImageSVG svg={svg('DM Sans')} x={0} y={0} width={64} height={48} />);
    expect(inked(drawn.picture)).toBeGreaterThan(80);
    expect(reportedUnsupported()).toEqual([]);
    const fallback = draw(<ImageSVG svg={svg('Nope Sans')} x={0} y={0} width={64} height={48} />);
    expect(inked(fallback.picture)).toBeGreaterThan(80);
    expect(reportedUnsupported().map((u) => u.reason).join()).toContain('Nope Sans');
  });

  const CLIP = fileURLToPath(new URL('../../../crates/core/tests/scenes/media/clip.mp4', import.meta.url)); // 64 x 36, 24 fps, 2 s
  const hasVideoRead = (() => {
    try {
      return typeof (createRequire(import.meta.url)('@kinetographdev/native') as Record<string, unknown>).readCanvasPicture === 'function';
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasVideoRead)('draws useVideo frames for the time of the frame, looping, with the size and duration of the file', () => {
    const seen: { duration: number; size: unknown; time: number }[] = [];
    function Player({ speed = 1, looping }: { speed?: number; looping?: boolean }) {
      const video = useVideo(CLIP, { playbackSpeed: speed, looping });
      seen.push({ duration: video.duration, size: video.size, time: video.currentTime.value });
      return <Image image={video.currentFrame} x={0} y={0} width={64} height={48} fit="fill" />;
    }
    const at = (frame: number, props: { speed?: number; looping?: boolean } = {}) => draw(<Player {...props} />, frame);
    const first = at(0);
    expect(inked(first.picture)).toBeGreaterThan(1000);
    expect(seen[0]).toMatchObject({ size: { width: 64, height: 36 }, time: 0 });
    expect(seen[0]!.duration).toBeCloseTo(2000, -2);
    expect(at(30).src).not.toBe(first.src);
    expect(at(30).src).toBe(at(30).src);
    // 2 s at 30 fps is 60 frames: frame 60 loops to the start; without looping it holds the last picture.
    expect(at(60).src).toBe(first.src);
    expect(at(60, { looping: false }).src).not.toBe(first.src);
    // Twice the speed: frame 15 shows what frame 30 does.
    expect(at(15, { speed: 2 }).src).toBe(at(30).src);
  });

  it('interpolates paths between those of an output range', () => {
    const a = Skia.Path.Make().moveTo(0, 0).lineTo(10, 0);
    const b = Skia.Path.Make().moveTo(0, 20).lineTo(30, 20);
    expect(b.interpolate(a, 0.5)!.getBounds()).toEqual({ x: 0, y: 10, width: 20, height: 0 });
    function Morph({ t }: { t: number }) {
      const path = usePathInterpolation(t, [0, 1], [a, b]);
      return <Rect x={useDerivedValue(() => path.value.getBounds().y)} y={0} width={4} height={4} color="red" />;
    }
    expect(pixel(draw(<Morph t={0.5} />).picture, 12, 2)).toEqual([255, 0, 0, 255]);
  });
});
