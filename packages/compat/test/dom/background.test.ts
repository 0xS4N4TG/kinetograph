// COMPAT.md §4.2: .bg-N layers (gradients and pictures), gradient and picture masks.

import { describe, expect, it } from 'vitest';
import type { BackgroundImage, ColorStop, ParsedStyle } from '../../src/css/types.js';
import { resolveStops } from '../../src/dom/paint.js';
import { div, find, hasAddon, pct, px, rgb, run, sides } from './helpers.js';

const stop = (r: number, g: number, b: number, position: ColorStop['position'] = null): ColorStop => ({ color: rgb(r, g, b), position });
const box: ParsedStyle = { width: px(200), height: px(100) };
const origin = { cx: pct(50), cy: pct(50) };

describe('resolveStops', () => {
  const fraction = (l: { unit: string; value: number }) => (l.unit === '%' ? l.value / 100 : null);
  it('places the first at 0, the last at 1 and spreads the others between their neighbours', () => {
    const stops = resolveStops([stop(255, 0, 0), stop(0, 255, 0), stop(0, 0, 255), stop(1, 1, 1)], fraction, rgb(0, 0, 0));
    expect(stops!.map((s) => s.offset)).toEqual([0, 1 / 3, 2 / 3, 1].map((n) => Math.round(n * 1e6) / 1e6));
  });
  it('never goes back', () => {
    const stops = resolveStops([stop(1, 0, 0, pct(60)), stop(2, 0, 0, pct(30)), stop(3, 0, 0)], fraction, rgb(0, 0, 0));
    expect(stops!.map((s) => s.offset)).toEqual([0.6, 0.6, 1]);
  });
  it('resolves currentcolor and keeps alpha', () => {
    const stops = resolveStops(
      [{ color: 'currentcolor', position: null }, { color: rgb(255, 255, 255, 0.5), position: null }],
      fraction,
      rgb(10, 20, 30),
    );
    expect(stops!.map((s) => s.color)).toEqual(['#0a141e', '#ffffff80']);
  });
});

describe.skipIf(!hasAddon)('background layers', () => {
  const red = stop(255, 0, 0);
  const blue = stop(0, 0, 255);

  it('fills the border box with a linear gradient along the CSS angle', () => {
    const image: BackgroundImage = { kind: 'linear', angle: 90, stops: [red, blue], repeating: false };
    const { root, unsupported } = run(div({ ...box, backgroundImage: [image] }));
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.bg-0')).toEqual({
      id: '$0.bg-0',
      type: 'shape',
      shape: { kind: 'rect', width: 200, height: 100 },
      fill: {
        type: 'linear', x0: 0, y0: 50, x1: 200, y1: 50,
        stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
      },
    });
  });

  it('uses the gradient line length of the angle, and the corners for "to top right"', () => {
    const at = (angle: BackgroundImage extends { angle: infer A } ? never : never) => angle;
    void at;
    const diagonal = run(div({ ...box, backgroundImage: [{ kind: 'linear', angle: 180, stops: [red, blue], repeating: false }] }));
    expect(find(diagonal.root, '$0.bg-0').fill).toMatchObject({ x0: 100, y0: 0, x1: 100, y1: 100 });
    const corner = run(div({ ...box, backgroundImage: [{ kind: 'linear', angle: 'top right', stops: [red, blue], repeating: false }] }));
    const g = find(corner.root, '$0.bg-0').fill;
    // The 50% point is the centre and the line is perpendicular to the diagonal from the top-left corner.
    expect((g.x0 + g.x1) / 2).toBeCloseTo(100, 2);
    expect((g.y0 + g.y1) / 2).toBeCloseTo(50, 2);
    const direction = [g.x1 - g.x0, g.y1 - g.y0];
    expect(direction[0]! * 200 + direction[1]! * 100).toBeCloseTo(0, 2);
    expect(direction[0]!).toBeGreaterThan(0);
    expect(direction[1]!).toBeLessThan(0);
  });

  it('repeats a repeating gradient, and draws radial and conic ones', () => {
    const repeating = run(div({ ...box, backgroundImage: [{ kind: 'linear', angle: 90, stops: [red, stop(0, 0, 255, px(20))], repeating: true }] }));
    expect(find(repeating.root, '$0.bg-0').fill).toMatchObject({ extend: 'repeat', stops: [{ offset: 0 }, { offset: 0.1 }] });

    const circle = run(div({ ...box, backgroundImage: [{ kind: 'radial', shape: 'circle', size: 'farthest-side', ...origin, stops: [red, blue], repeating: false }] }));
    expect(find(circle.root, '$0.bg-0').fill).toMatchObject({ type: 'radial', cx: 100, cy: 50, r: 100 });

    // The default ellipse at the centre has the box's own shape: a circle in box units.
    const ellipse = run(div({ ...box, backgroundImage: [{ kind: 'radial', shape: 'ellipse', size: 'farthest-corner', ...origin, stops: [red, blue], repeating: false }] }));
    const fill = find(ellipse.root, '$0.bg-0').fill;
    expect(fill).toMatchObject({ type: 'radial', units: 'box', cx: 0.5, cy: 0.5 });
    expect(fill.r).toBeCloseTo(Math.SQRT1_2, 5);

    const stretched = run(div({ ...box, backgroundImage: [{ kind: 'radial', shape: 'ellipse', size: [px(30), px(80)], ...origin, stops: [red, blue], repeating: false }] }));
    expect(stretched.unsupported).toEqual([expect.objectContaining({ property: 'background', value: 'radial' })]);

    const conic = run(div({ ...box, backgroundImage: [{ kind: 'conic', angle: 45, ...origin, stops: [red, blue], repeating: false }] }));
    expect(find(conic.root, '$0.bg-0').fill).toMatchObject({ type: 'conic', cx: 100, cy: 50, angle: 45 });
  });

  it('puts the last background layer at the bottom, over the colour, with the border box rounded', () => {
    const { root } = run(
      div({
        ...box,
        backgroundColor: rgb(1, 2, 3),
        borderRadius: [[px(8), px(8)], [px(8), px(8)], [px(8), px(8)], [px(8), px(8)]],
        backgroundImage: [
          { kind: 'linear', angle: 0, stops: [red, blue], repeating: false },
          { kind: 'linear', angle: 90, stops: [blue, red], repeating: false },
        ],
      }),
    );
    expect(root.children.map((c: any) => c.id)).toEqual(['$0.bg', '$0.bg-1', '$0.bg-0']);
    expect(find(root, '$0.bg-1').shape).toEqual({ kind: 'roundedRect', width: 200, height: 100, radius: 8 });
  });

  it('measures the gradient from the padding box and covers the border with it only where the border hides it', () => {
    const bordered: ParsedStyle = {
      ...box,
      boxSizing: 'border-box',
      borderWidth: sides(px(10)),
      borderStyle: sides('solid'),
      borderColor: sides(rgb(255, 255, 255)),
      backgroundImage: [{ kind: 'linear', angle: 90, stops: [red, blue], repeating: false }],
    };
    const opaque = run(div(bordered));
    expect(opaque.unsupported).toEqual([]);
    expect(find(opaque.root, '$0.bg-0').fill).toMatchObject({ x0: 10, x1: 190 });
    const translucent = run(div({ ...bordered, borderColor: sides(rgb(255, 255, 255, 0.5)) }));
    expect(translucent.unsupported).toEqual([expect.objectContaining({ property: 'backgroundRepeat' })]);
    const clipped = run(div({ ...bordered, borderColor: sides(rgb(255, 255, 255, 0.5)), backgroundClip: 'padding-box' }));
    expect(clipped.unsupported).toEqual([]);
    expect(find(clipped.root, '$0.bg-0').transform).toEqual({ x: 10, y: 10 });
  });

  it('draws a smaller tile once with no-repeat', () => {
    const { root, unsupported } = run(
      div({
        ...box,
        backgroundImage: [{ kind: 'linear', angle: 90, stops: [red, blue], repeating: false }],
        backgroundSize: [[px(50), px(40)]],
        backgroundPosition: [[px(20), px(10)]],
        backgroundRepeat: ['no-repeat'],
      }),
    );
    expect(unsupported).toEqual([]);
    const layer = find(root, '$0.bg-0');
    expect(layer.shape).toEqual({ kind: 'rect', width: 50, height: 40 });
    expect(layer.transform).toEqual({ x: 20, y: 10 });
    expect(layer.fill).toMatchObject({ x0: 0, x1: 50 });
    // The same tile with the default repeat would repeat.
    const repeated = run(div({ ...box, backgroundImage: [{ kind: 'linear', angle: 90, stops: [red, blue], repeating: false }], backgroundSize: [[px(50), px(40)]] }));
    expect(repeated.unsupported).toEqual([expect.objectContaining({ property: 'backgroundRepeat' })]);
  });

  it('draws a url() as an image layer: cover and contain centred, natural size once', () => {
    const url: BackgroundImage = { kind: 'url', url: '/pic.png' };
    const cover = run(div({ ...box, backgroundImage: [url], backgroundSize: ['cover'], backgroundPosition: [[pct(50), pct(50)]], backgroundRepeat: ['no-repeat'] }));
    expect(cover.unsupported).toEqual([]);
    expect(find(cover.root, '$0.bg-0')).toEqual({ id: '$0.bg-0', type: 'image', src: '/pic.png', width: 200, height: 100, fit: 'cover' });
    const off = run(div({ ...box, backgroundImage: [url], backgroundSize: ['contain'] }));
    expect(off.unsupported).toEqual([expect.objectContaining({ property: 'backgroundPosition' })]);
    const natural = run(div({ ...box, backgroundImage: [url], backgroundRepeat: ['no-repeat'], backgroundPosition: [[px(5), px(6)]] }));
    expect(find(natural.root, '$0.bg-0')).toMatchObject({ type: 'image', src: '/pic.png', transform: { x: 5, y: 6 } });
    expect(find(natural.root, '$0.bg-0').width).toBeUndefined();
    const repeating = run(div({ ...box, backgroundImage: [url] }));
    expect(repeating.unsupported).toEqual([expect.objectContaining({ property: 'backgroundRepeat' })]);
  });

  it('rounds an image to the box', () => {
    const { root } = run(
      div({
        ...box,
        borderRadius: [[px(10), px(10)], [px(10), px(10)], [px(10), px(10)], [px(10), px(10)]],
        backgroundImage: [{ kind: 'url', url: '/pic.png' }],
        backgroundSize: ['cover'],
        backgroundPosition: [[pct(50), pct(50)]],
      }),
    );
    expect(find(root, '$0.bg-0').clip.kind).toBe('path');
  });
});

describe.skipIf(!hasAddon)('masks', () => {
  it('turns a gradient mask-image into a mask over the border box', () => {
    const { root, unsupported } = run(
      div({ ...box, backgroundColor: rgb(0, 0, 0), maskImage: [{ kind: 'linear', angle: 180, stops: [stop(0, 0, 0), { color: rgb(0, 0, 0, 0), position: null }], repeating: false }] }),
    );
    expect(unsupported).toEqual([]);
    expect(root.mask).toMatchObject({ mode: 'alpha', gradient: { type: 'linear', x0: 100, y0: 0, x1: 100, y1: 100 } });
  });

  it('turns a url mask-image into a sibling image the content is matted by', () => {
    const { root, unsupported } = run(
      div({
        ...box,
        backgroundColor: rgb(0, 0, 0),
        maskImage: [{ kind: 'url', url: '/mask.png' }],
        maskSize: ['cover'],
        maskPosition: [[pct(50), pct(50)]],
        maskRepeat: ['no-repeat'],
      }),
    );
    expect(unsupported).toEqual([]);
    expect(root.children.map((c: any) => c.id)).toEqual(['$0.mask', '$0.masked']);
    expect(find(root, '$0.masked').matte).toEqual({ layer: '$0.mask', mode: 'alpha' });
    expect(find(root, '$0.masked').children.map((c: any) => c.id)).toEqual(['$0.bg']);
  });

  it('reports a sized gradient mask, and a second mask layer', () => {
    const g: BackgroundImage = { kind: 'linear', angle: 0, stops: [stop(0, 0, 0), stop(1, 1, 1)], repeating: false };
    expect(run(div({ ...box, maskImage: [g], maskSize: ['cover'] })).unsupported[0]).toMatchObject({ property: 'maskSize' });
    expect(run(div({ ...box, maskImage: [g, g] })).unsupported[0]).toMatchObject({ property: 'maskImage' });
  });
});
