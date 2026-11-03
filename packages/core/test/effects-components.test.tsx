// Remotion's `effects` on `<Img>`, `<Video>`, `<Gif>` and the shapes: each draws its picture as a layer of the chain's
// size, runs the effects over it (effect-chain.tsx) and shows the last picture. Without an effect that is not disabled
// the component is what it was.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupLayer, LayerJson } from '@kinetographdev/scene';
import {
  Arrow, Callout, Circle, Ellipse, Heart, Pie, Polygon, Rect, Spark, Star, Triangle,
  makeArrow, makeCallout, makeCircle, makeEllipse, makeHeart, makePie, makePolygon, makeRect, makeSpark, makeStar, makeTriangle,
} from '../src/shapes.js';
import { Gif, Img, Video } from '../src/index.js';
import { Video as MediaVideo } from '../src/media.js';
import { setMediaProbe } from '../src/media-utils.js';
import { clearReportedUnsupported } from '../src/unsupported.js';
import { resetWarnings } from '../src/warn.js';
import { renderDom, sent, useFakeDom } from './dom-harness.js';
import { filtered, shaded } from './effect-fixtures.js';
import { renderAt } from './scene-harness.js';

useFakeDom();

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWarnings();
  clearReportedUnsupported();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setMediaProbe(
    (path) =>
      ({ kind: path.endsWith('.gif') ? 'gif' : 'video', width: 320, height: 180, durationInSeconds: 2, fps: 30 }) as never,
  );
});
afterEach(() => {
  warn.mockRestore();
  setMediaProbe(null);
});

function walk(layers: LayerJson[], out: LayerJson[] = []): LayerJson[] {
  for (const layer of layers) {
    out.push(layer);
    if (layer.type === 'group') walk(layer.children, out);
  }
  return out;
}

/** The groups that carry a pass of the chain, outermost first. */
const chainOf = (layers: LayerJson[]): GroupLayer[] => walk(layers).filter((l): l is GroupLayer => l.type === 'group' && (l.glsl !== undefined || l.canvas !== undefined));
const invert = () => [filtered({ filter: 'invert(1)' })];

describe('<Img effects>', () => {
  it('is a canvas image run through the effects, at the size of the image props', () => {
    const tree = renderAt(<Img src="/p/cat.png" width={40} height={30} style={{ objectFit: 'cover' }} effects={invert()} />);
    const [pass, ...rest] = chainOf(tree.layers);
    expect(rest).toEqual([]);
    expect(pass!.canvas).toMatchObject({ width: 40, height: 30 });
    expect(walk(tree.layers).find((l) => l.type === 'image')).toMatchObject({ src: '/p/cat.png', width: 40, height: 30, fit: 'cover' });
  });

  it('takes the canvas size from style.width and style.height, and keeps the other CSS on a box', () => {
    const tree = renderDom(<Img src="/p/cat.png" style={{ width: 64, height: 32, borderRadius: 4 }} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 64, height: 32 });
  });

  it('is the plain image without effects, or with all of them disabled', () => {
    expect(renderAt(<Img src="/p/cat.png" width={4} height={4} />).layers[0]).toMatchObject({ type: 'image' });
    const tree = renderAt(<Img src="/p/cat.png" width={4} height={4} effects={[shaded({ disabled: true } as never)]} />);
    expect(chainOf(tree.layers)).toEqual([]);
    expect(tree.layers[0]).toMatchObject({ type: 'image' });
  });

  it('refuses a width that is not a number, as Remotion does', () => {
    expect(() => renderAt(<Img src="/p/cat.png" width={'50%' as never} effects={invert()} />)).toThrow(/must be numbers on <Img> when effects are passed/);
  });

  it('honours effectsOutputSize', () => {
    const tree = renderDom(<Img src="/p/cat.png" width={40} height={30} effectsOutputSize={{ width: 80, height: 60 }} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 80, height: 60 });
  });
});

describe('<Video effects>', () => {
  const clips = (tree: ReturnType<typeof renderAt>) => tree.audio.length;

  it('draws the video at its own size and runs the effects over it, keeping its sound', () => {
    const tree = renderAt(<Video src="/p/clip.mp4" effects={invert()} />);
    const [pass] = chainOf(tree.layers);
    expect(pass!.canvas).toMatchObject({ width: 320, height: 180 });
    expect(walk(tree.layers).find((l) => l.type === 'video')).toMatchObject({ src: '/p/clip.mp4', width: 320, height: 180, fit: 'fill' });
    expect(clips(tree)).toBe(1);
  });

  it('is the same component from @remotion/media', () => {
    expect(chainOf(renderAt(<MediaVideo src="/p/clip.mp4" effects={invert()} />).layers)).toHaveLength(1);
  });

  it('fits the picture to the box the props give, with objectFit', () => {
    const tree = renderDom(<Video src="/p/clip.mp4" width={160} height={160} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 320, height: 180 });
    // contain (the default): 320 x 180 into 160 x 160 is half the size, centred.
    expect(JSON.stringify(sent)).toContain('translate(0px, 35px) scale(0.5, 0.5)');
  });

  it('uses effectsOutputSize for the canvas', () => {
    const tree = renderDom(<Video src="/p/clip.mp4" effectsOutputSize={{ width: 64, height: 36 }} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 64, height: 36 });
  });

  it('keeps the engine\'s own effects on a layer around the chain, and its position', () => {
    const tree = renderAt(<Video src="/p/clip.mp4" x={10} y={20} effects={[...invert(), { type: 'blur', radius: 4 } as never]} />);
    const outer = tree.layers[0] as GroupLayer;
    expect(outer).toMatchObject({ type: 'group', effects: [{ type: 'blur', radius: 4 }], transform: { x: 10, y: 20 } });
    expect(chainOf(outer.children)).toHaveLength(1);
  });

  it('is the native video without Remotion\'s effects', () => {
    const tree = renderAt(<Video src="/p/clip.mp4" effects={[{ type: 'blur', radius: 4 } as never]} />);
    expect(chainOf(tree.layers)).toEqual([]);
    expect(tree.layers[0]).toMatchObject({ type: 'video', effects: [{ type: 'blur', radius: 4 }] });
  });
});

describe('<Gif effects>', () => {
  it('is drawn on a canvas of the GIF\'s size and run through the effects', () => {
    const tree = renderAt(<Gif src="/p/a.gif" effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 320, height: 180 });
    expect(walk(tree.layers).find((l) => l.type === 'gif')).toMatchObject({ src: '/p/a.gif', width: 320, height: 180 });
  });

  it('takes width and height from the props', () => {
    const tree = renderAt(<Gif src="/p/a.gif" width={50} height={40} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 50, height: 40 });
  });

  it('is the native GIF without an effect', () => {
    expect(renderAt(<Gif src="/p/a.gif" width={50} height={40} />).layers[0]).toMatchObject({ type: 'gif' });
  });
});

describe('shapes with effects', () => {
  const shapes: [string, () => React.ReactElement, { width: number; height: number }][] = [
    ['Rect', () => <Rect width={40} height={20} fill="#f00" effects={invert()} />, makeRect({ width: 40, height: 20 })],
    ['Circle', () => <Circle radius={10} fill="#f00" effects={invert()} />, makeCircle({ radius: 10 })],
    ['Ellipse', () => <Ellipse rx={12} ry={6} fill="#f00" effects={invert()} />, makeEllipse({ rx: 12, ry: 6 })],
    ['Triangle', () => <Triangle length={30} direction="up" fill="#f00" effects={invert()} />, makeTriangle({ length: 30, direction: 'up' })],
    ['Star', () => <Star points={5} innerRadius={5} outerRadius={10} fill="#f00" effects={invert()} />, makeStar({ points: 5, innerRadius: 5, outerRadius: 10 })],
    ['Polygon', () => <Polygon points={6} radius={10} fill="#f00" effects={invert()} />, makePolygon({ points: 6, radius: 10 })],
    ['Pie', () => <Pie radius={10} progress={0.5} fill="#f00" effects={invert()} />, makePie({ radius: 10, progress: 0.5 })],
    ['Heart', () => <Heart height={20} fill="#f00" effects={invert()} />, makeHeart({ height: 20 })],
    ['Arrow', () => <Arrow length={40} headWidth={20} headLength={10} shaftWidth={6} fill="#f00" effects={invert()} />, makeArrow({ length: 40, headWidth: 20, headLength: 10, shaftWidth: 6 })],
    ['Callout', () => <Callout width={40} height={20} pointerLength={8} pointerBaseWidth={8} fill="#f00" effects={invert()} />, makeCallout({ width: 40, height: 20, pointerLength: 8, pointerBaseWidth: 8 })],
    ['Spark', () => <Spark width={30} height={20} fill="#f00" effects={invert()} />, makeSpark({ width: 30, height: 20 })],
  ];

  it.each(shapes)('%s runs its effects over the shape drawn on a canvas of its size', (_name, element, info) => {
    const tree = renderAt(element());
    const [pass, ...rest] = chainOf(tree.layers);
    expect(rest).toEqual([]);
    expect(pass!.canvas).toMatchObject({ width: Math.ceil(info.width), height: Math.ceil(info.height) });
    expect(walk(tree.layers).filter((l) => l.type === 'shape')).toHaveLength(1);
  });

  it('scales the shape to pixelDensity', () => {
    const tree = renderDom(<Rect width={40} height={20} fill="#f00" pixelDensity={2} effects={invert()} />);
    expect(chainOf(tree.layers)[0]!.canvas).toMatchObject({ width: 80, height: 40 });
    const picture = walk(tree.layers).find((l) => l.type === 'group' && l.transform?.scaleX === 2);
    expect(picture).toBeDefined();
  });

  it('puts the position on a layer around the chain, and the engine\'s own effects with it', () => {
    const tree = renderAt(<Rect width={40} height={20} fill="#f00" x={5} y={6} effects={[...invert(), { type: 'blur', radius: 2 } as never]} />);
    expect(tree.layers[0]).toMatchObject({ type: 'group', transform: { x: 5, y: 6 }, effects: [{ type: 'blur', radius: 2 }] });
  });

  it('is the plain path without Remotion\'s effects, with the engine\'s own kept', () => {
    const tree = renderAt(<Rect width={40} height={20} fill="#f00" x={5} effects={[{ type: 'blur', radius: 2 } as never]} />);
    expect(chainOf(tree.layers)).toEqual([]);
    expect(tree.layers[0]).toMatchObject({ type: 'shape', effects: [{ type: 'blur', radius: 2 }] });
    expect(renderAt(<Rect width={40} height={20} fill="#f00" effects={[shaded({ disabled: true } as never)]} />).layers[0]).toMatchObject({ type: 'shape' });
  });

  it('refuses a pixelDensity that is not positive', () => {
    expect(() => renderAt(<Rect width={4} height={4} pixelDensity={0} effects={invert()} />)).toThrow(/pixelDensity/);
  });
});
