// COMPAT.md §4.5: svg as a box with a view group and path layers; path data tools.

import { describe, expect, it } from 'vitest';
import { IDENTITY, multiply, parsePath, parseSvgTransform, similarity, transformPath } from '../../src/dom/pathdata.js';
import { div, el, find, hasAddon, px, run } from './helpers.js';

describe('path data', () => {
  it('transforms absolute, relative and shorthand commands', () => {
    expect(transformPath('M0 0 h10 v10 H0 Z', [2, 0, 0, 3, 1, 1])).toBe('M1 1 L21 1 L21 31 L1 31 Z');
    expect(transformPath('m1 1 l1 0 1 1', [1, 0, 0, 1, 0, 0])).toBe('M1 1 L2 1 L3 2');
    // S and T reflect the previous control point.
    expect(transformPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0', IDENTITY)).toBe('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0');
    expect(transformPath('M0 0 Q5 5 10 0 T20 0', IDENTITY)).toBe('M0 0 Q5 5 10 0 Q15 -5 20 0');
  });

  it('turns arcs into cubic curves that end where the arc does, whatever the map', () => {
    const d = transformPath('M0 0 A10 10 0 0 1 20 0', [1, 0, 0, 2, 0, 0])!;
    const segments = parsePath(d)!;
    expect(segments[0]).toEqual({ c: 'M', p: [0, 0] });
    expect(segments.every((s) => s.c === 'C' || s.c === 'M')).toBe(true);
    const last = segments[segments.length - 1] as { p: number[] };
    expect(last.p.slice(-2)).toEqual([20, 0]);
    // The half circle bulges up by its radius, stretched by 2.
    const tops = segments.filter((s) => s.c === 'C').map((s) => (s as { p: number[] }).p[5]!);
    expect(tops.length).toBe(2);
  });

  it('reads arc flags written without separators', () => {
    expect(parsePath('M0 0a5 5 0 1010 0')).not.toBeNull();
  });

  it('rejects data that does not parse', () => {
    expect(parsePath('M0 0 L')).toBeNull();
    expect(parsePath('L1 1')).toBeNull();
    expect(parsePath('M0 0 X')).toBeNull();
  });

  it('parses SVG transform lists', () => {
    expect(parseSvgTransform('translate(10, 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    const rotated = parseSvgTransform('rotate(90 10 10)')!;
    expect(rotated.map((n) => Math.round(n * 1e9) / 1e9)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseSvgTransform('skewX(45)')![2]).toBeCloseTo(1, 9);
    expect(parseSvgTransform('wobble(1)')).toBeNull();
    expect(multiply([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 5, 0]);
  });

  it('knows a similarity from other maps', () => {
    expect(similarity([0, 2, -2, 0, 3, 4])).toEqual({ x: 3, y: 4, rotation: 90, scale: 2 });
    expect(similarity([1, 0, 0, 2, 0, 0])).toBeNull();
    expect(similarity([1, 0, 1, 1, 0, 0])).toBeNull();
  });
});

const svg = (props: Record<string, any>, children: any[] = [], style = {}) => el('svg', style, children, props);
const shape = (type: string, props: Record<string, any>, children: any[] = []) => el(type, {}, children, props);

describe.skipIf(!hasAddon)('svg', () => {
  it('maps the viewBox onto the box with meet and xMidYMid', () => {
    const { root, unsupported } = run(
      div({}, [svg({ width: 200, height: 100, viewBox: '0 0 50 50' }, [shape('path', { d: 'M0 0 L50 0 L50 50 Z', fill: '#ff0000' })])]),
    );
    expect(unsupported).toEqual([]);
    // Scale 2, centred horizontally: 50 x 2 = 100 of the 200.
    expect(find(root, '$0.0.view')).toMatchObject({ type: 'group', transform: { x: 50, scale: 2 } });
    expect(find(root, '$0.0.view.0')).toEqual({
      id: '$0.0.view.0',
      type: 'shape',
      shape: { kind: 'path', d: 'M0 0 L50 0 L50 50 Z' },
      fill: '#ff0000',
    });
  });

  it('honours the other alignments, slice (which clips) and a viewBox origin', () => {
    const sized = { width: 200, height: 100 };
    const min = run(div({}, [svg({ ...sized, viewBox: '10 20 50 50', preserveAspectRatio: 'xMinYMin meet' }, [shape('rect', { width: 5, height: 5 })])]));
    expect(find(min.root, '$0.0.view').transform).toEqual({ scale: 2, anchorX: 10, anchorY: 20 });
    const slice = run(div({}, [svg({ ...sized, viewBox: '0 0 50 50', preserveAspectRatio: 'xMidYMid slice' }, [shape('rect', { width: 5, height: 5 })])]));
    const view = find(slice.root, '$0.0.view');
    expect(view.transform).toEqual({ y: -50, scale: 4 });
    expect(view.clip).toEqual({ kind: 'path', d: 'M0 12.5 L50 12.5 L50 37.5 L0 37.5 Z' });
  });

  it('bakes a non-uniform viewBox mapping (none) into the path data', () => {
    const { root, unsupported } = run(
      div({}, [svg({ width: 100, height: 50, viewBox: '0 0 10 10', preserveAspectRatio: 'none' }, [shape('path', { d: 'M0 0 L10 10', fill: 'red' })])]),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.0.view').transform).toBeUndefined();
    expect(find(root, '$0.0.view.0').shape.d).toBe('M0 0 L100 50');
    // A stroke would be stretched unevenly.
    const stroked = run(
      div({}, [svg({ width: 100, height: 50, viewBox: '0 0 10 10', preserveAspectRatio: 'none' }, [shape('path', { d: 'M0 0 L10 10', stroke: 'red' })])]),
    );
    expect(stroked.unsupported).toEqual([expect.objectContaining({ element: 'svg > path', property: 'stroke' })]);
  });

  it('converts the basic shapes to path data', () => {
    const { root, unsupported } = run(
      div({}, [
        svg({ width: 100, height: 100, viewBox: '0 0 100 100' }, [
          shape('rect', { x: 1, y: 2, width: 30, height: 20, rx: 4 }),
          shape('circle', { cx: 50, cy: 50, r: 10 }),
          shape('ellipse', { cx: 50, cy: 50, rx: 10, ry: 5 }),
          shape('line', { x1: 0, y1: 0, x2: 10, y2: 10, stroke: '#000' }),
          shape('polyline', { points: '0,0 10,0 10,10' }),
          shape('polygon', { points: '0 0 10 0 10 10' }),
        ]),
      ]),
    );
    expect(unsupported).toEqual([]);
    const d = (i: number): string => find(root, `$0.0.view.${i}`).shape.d;
    expect(d(0)).toBe('M5 2 L27 2 A4 4 0 0 1 31 6 L31 18 A4 4 0 0 1 27 22 L5 22 A4 4 0 0 1 1 18 L1 6 A4 4 0 0 1 5 2 Z');
    expect(d(1)).toBe('M40 50 A10 10 0 1 0 60 50 A10 10 0 1 0 40 50 Z');
    expect(d(2)).toBe('M40 50 A10 5 0 1 0 60 50 A10 5 0 1 0 40 50 Z');
    expect(d(3)).toBe('M0 0 L10 10');
    expect(find(root, '$0.0.view.3')).toMatchObject({ stroke: { color: '#000000', width: 1 } });
    expect(find(root, '$0.0.view.3').fill).toBeUndefined();
    expect(d(4)).toBe('M0 0 L10 0 L10 10');
    expect(d(5)).toBe('M0 0 L10 0 L10 10 Z');
  });

  it('inherits paint through groups, with currentColor from the CSS color and opacities folded into colours', () => {
    const { root, unsupported } = run(
      div({ color: { r: 0, g: 128, b: 0, a: 1 } }, [
        svg({ width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor' }, [
          el('g', {}, [shape('rect', { width: 5, height: 5, fillOpacity: 0.5, stroke: 'blue', strokeWidth: 2, strokeOpacity: 0.25 })], { opacity: 0.8, stroke: 'red' }),
        ]),
      ]),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.0.view.0')).toMatchObject({ type: 'group', opacity: 0.8 });
    expect(find(root, '$0.0.view.0.0')).toMatchObject({ fill: '#00800080', stroke: { color: '#0000ff40', width: 2 } });
  });

  it('turns a rotation and uniform scale into the layer transform, and bakes any other transform', () => {
    const { root, unsupported } = run(
      div({}, [
        svg({ width: 100, height: 100, viewBox: '0 0 100 100' }, [
          shape('rect', { width: 10, height: 10, transform: 'translate(5 6) rotate(90) scale(2)' }),
          shape('path', { d: 'M0 0 L10 0', stroke: 'red', transform: 'matrix(1 0 0 -1 0 10)' }),
          shape('path', { d: 'M0 0 L10 0 L10 10 Z', transform: 'skewX(45)' }),
        ]),
      ]),
    );
    expect(unsupported.filter((u) => u.property !== 'stroke')).toEqual([]);
    const t = find(root, '$0.0.view.0').transform;
    expect(t.x).toBe(5);
    expect(t.y).toBe(6);
    expect(t.rotation).toBe(90);
    expect(t.scale).toBe(2);
    // A flip is baked, and a stroke under it is reported as it is not a similarity.
    expect(find(root, '$0.0.view.1').shape.d).toBe('M0 10 L10 10');
    expect(find(root, '$0.0.view.2').shape.d).toBe('M0 0 L10 0 L20 10 Z');
    expect(unsupported.some((u) => u.property === 'stroke')).toBe(true);
  });

  it('fills with gradients: box units, user space, spread and stops with opacity', () => {
    const stops = [shape('stop', { offset: '0%', stopColor: '#ff0000' }), shape('stop', { offset: 1, stopColor: '#0000ff', stopOpacity: 0.5 })];
    const { root, unsupported } = run(
      div({}, [
        svg({ width: 100, height: 100, viewBox: '0 0 100 100' }, [
          el('defs', {}, [
            shape('linearGradient', { id: 'a', x1: '0%', y1: '0%', x2: '0%', y2: '100%', spreadMethod: 'reflect' }, stops),
            shape('radialGradient', { id: 'b', gradientUnits: 'userSpaceOnUse', cx: 30, cy: 40, r: 20 }, stops),
          ]),
          shape('rect', { width: 50, height: 50, fill: 'url(#a)' }),
          shape('rect', { width: 50, height: 50, fill: 'url(#b)' }),
        ]),
      ]),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.0.view.1').fill).toEqual({
      type: 'linear', units: 'box', x0: 0, y0: 0, x1: 0, y1: 1, extend: 'reflect',
      stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff80' }],
    });
    expect(find(root, '$0.0.view.2').fill).toMatchObject({ type: 'radial', cx: 30, cy: 40, r: 20 });
    expect(find(root, '$0.0.view.2').fill.units).toBeUndefined();
  });

  it('reports the elements and properties of §4.5 it does not draw', () => {
    const { unsupported } = run(
      div({}, [
        svg({ width: 50, height: 50, viewBox: '0 0 50 50' }, [
          shape('text', {}, ['hi']),
          shape('use', { href: '#x' }),
          shape('clipPath', {}),
          shape('path', { d: 'M0 0 L5 5', stroke: 'red', strokeDasharray: '2 2', strokeLinecap: 'round', strokeLinejoin: 'bevel' }),
          shape('path', { d: 'M0 0 L5 5 L0 5 Z', fillRule: 'evenodd' }),
          shape('rect', { width: 5, height: 5, fill: 'url(#missing)' }),
        ]),
      ]),
    );
    const found = unsupported.map((u) => `${u.element}:${u.property}`).sort();
    expect(found).toEqual([
      'svg > clipPath:null',
      'svg > path:fillRule',
      'svg > path:strokeDasharray',
      'svg > path:strokeLinecap',
      'svg > path:strokeLinejoin',
      'svg > rect:fill',
      'svg > text:null',
      'svg > use:null',
    ]);
  });

  it('fills the container width when the svg has a viewBox and no size, and 300 x 150 without one', () => {
    const a = run(div({ width: px(400) }, [svg({ viewBox: '0 0 10 5' }, [shape('rect', { width: 10, height: 5 })])]));
    expect(find(a.root, '$0.0.view').transform.scale).toBe(40);
    const b = run(div({}, [svg({}, [shape('rect', { width: 10, height: 5 })])]));
    expect(find(b.root, '$0.0.view')).toBeDefined();
  });

  it('hides display: none and visibility: hidden shapes', () => {
    const { root } = run(
      div({}, [svg({ width: 10, height: 10 }, [shape('rect', { width: 5, height: 5, display: 'none' }), shape('rect', { width: 5, height: 5, visibility: 'hidden' })])]),
    );
    expect(find(root, '$0.0.view')).toBeUndefined();
  });
});
