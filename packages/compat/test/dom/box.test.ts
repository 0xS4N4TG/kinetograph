// COMPAT.md §4.2: a box is a group with .bg, .bg-N, .border and its children.

import { describe, expect, it } from 'vitest';
import { corners, div, em, find, hasAddon, ids, pct, px, rgb, run, sides } from './helpers.js';

describe.skipIf(!hasAddon)('boxes', () => {
  it('is a group at its border box with a .bg rect and its children at their laid-out places', () => {
    const { root, unsupported, layers } = run(
      div({ position: 'absolute', inset: sides(px(10), 'auto', 'auto', px(20)), width: px(300), height: px(100), backgroundColor: rgb(255, 0, 0) }, [
        div({ width: px(50), height: px(20), backgroundColor: rgb(0, 0, 255) }),
        div({ width: px(50), height: px(30), backgroundColor: rgb(0, 255, 0) }),
      ]),
    );
    expect(unsupported).toEqual([]);
    expect(layers).toHaveLength(1);
    expect(root).toMatchObject({ id: '$0', type: 'group', transform: { x: 20, y: 10 } });
    expect(find(root, '$0.bg')).toEqual({
      id: '$0.bg',
      type: 'shape',
      shape: { kind: 'rect', width: 300, height: 100 },
      fill: '#ff0000',
    });
    // Block flow: the second child under the first.
    expect(find(root, '$0.0').transform).toBeUndefined();
    expect(find(root, '$0.1').transform).toEqual({ y: 20 });
    expect(ids(root)).toEqual(['$0', '$0.bg', '$0.0', '$0.0.bg', '$0.1', '$0.1.bg']);
  });

  it('puts the layers of an island where it stands as absolute layout items', () => {
    const { layers } = run(div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) }));
    expect(layers[0]).toMatchObject({ layoutItem: { position: 'absolute' } });
  });

  it('draws a uniform radius as a roundedRect and uneven or elliptical radii as a path', () => {
    const rounded = run(div({ width: px(100), height: px(60), backgroundColor: rgb(1, 2, 3), borderRadius: corners(12) }));
    expect(find(rounded.root, '$0.bg').shape).toEqual({ kind: 'roundedRect', width: 100, height: 60, radius: 12 });
    const uneven = run(
      div({
        width: px(100),
        height: px(60),
        backgroundColor: rgb(1, 2, 3),
        borderRadius: [[px(10), px(10)], [px(0), px(0)], [px(0), px(0)], [px(10), px(20)]],
      }),
    );
    const shape = find(uneven.root, '$0.bg').shape;
    expect(shape.kind).toBe('path');
    expect(shape.d).toMatch(/^M10 0 L100 0 L100 60 L10 60 A10 20 0 0 1 0 40 L0 10 A10 10 0 0 1 10 0 Z$/);
  });

  it('scales radii that would overlap, as CSS does', () => {
    const { root } = run(div({ width: px(100), height: px(40), backgroundColor: rgb(0, 0, 0), borderRadius: corners(50) }));
    expect(find(root, '$0.bg').shape).toEqual({ kind: 'roundedRect', width: 100, height: 40, radius: 20 });
  });

  it('casts one dropShadow per outer shadow, last first, from an opaque background', () => {
    const { root, unsupported } = run(
      div({
        width: px(100),
        height: px(50),
        backgroundColor: rgb(255, 255, 255),
        boxShadow: [
          { inset: false, x: px(0), y: px(8), blur: px(24), spread: px(0), color: rgb(0, 0, 0, 0.5) },
          { inset: false, x: px(2), y: px(2), blur: px(4), spread: px(1), color: rgb(255, 0, 0) },
        ],
      }),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.bg').effects).toEqual([
      { type: 'dropShadow', x: 2, y: 2, blur: 2, spread: 1, color: '#ff0000' },
      { type: 'dropShadow', x: 0, y: 8, blur: 12, color: '#00000080' },
    ]);
  });

  it('reports a shadow under a background that is not opaque', () => {
    const { root, unsupported } = run(
      div({
        width: px(100),
        height: px(50),
        backgroundColor: rgb(255, 255, 255, 0.5),
        boxShadow: [{ inset: false, x: px(0), y: px(8), blur: px(24), spread: px(0), color: rgb(0, 0, 0) }],
      }),
    );
    expect(find(root, '$0.bg').effects).toBeUndefined();
    expect(unsupported).toEqual([expect.objectContaining({ path: '$0 <div>', element: 'div', property: 'boxShadow' })]);
  });

  it('draws an inset shadow as an insetShadow on the opaque background, and reports it elsewhere', () => {
    const inset = { inset: true, x: px(0), y: px(6), blur: px(10), spread: px(0), color: rgb(0, 0, 0, 0.7) };
    const ok = run(div({ width: px(100), height: px(50), backgroundColor: rgb(9, 9, 9), boxShadow: [inset] }));
    expect(find(ok.root, '$0.bg').effects).toEqual([{ type: 'insetShadow', x: 0, y: 6, blur: 5, color: '#000000b3' }]);
    expect(ok.unsupported).toEqual([]);
    const bordered = run(
      div({
        width: px(100),
        height: px(50),
        backgroundColor: rgb(9, 9, 9),
        borderWidth: sides(px(2)),
        borderStyle: sides('solid'),
        borderColor: sides(rgb(1, 1, 1)),
        boxShadow: [inset],
      }),
    );
    expect(bordered.unsupported).toEqual([expect.objectContaining({ property: 'boxShadow', value: 'inset' })]);
  });

  it('draws a border as a stroked outline on the centre line of the border', () => {
    const { root, unsupported } = run(
      div({
        width: px(100),
        height: px(50),
        boxSizing: 'border-box',
        borderWidth: sides(px(4)),
        borderStyle: sides('solid'),
        borderColor: sides(rgb(255, 255, 255)),
        borderRadius: corners(10),
      }),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.border')).toEqual({
      id: '$0.border',
      type: 'shape',
      shape: { kind: 'roundedRect', width: 96, height: 46, radius: 8 },
      stroke: { color: '#ffffff', width: 4 },
      transform: { x: 2, y: 2 },
    });
  });

  it('reports borders that differ by side, that are not solid, and leaves none for style none', () => {
    const base = { width: px(100), height: px(50) };
    const uneven = run(div({ ...base, borderWidth: sides(px(1), px(2), px(1), px(2)), borderStyle: sides('solid'), borderColor: sides(rgb(0, 0, 0)) }));
    expect(uneven.unsupported[0]).toMatchObject({ property: 'borderWidth' });
    const dashed = run(div({ ...base, borderWidth: sides(px(2)), borderStyle: sides('dashed'), borderColor: sides(rgb(0, 0, 0)) }));
    expect(dashed.unsupported[0]).toMatchObject({ property: 'borderStyle', value: 'dashed' });
    const colours = run(
      div({ ...base, borderWidth: sides(px(2)), borderStyle: sides('solid'), borderColor: [rgb(0, 0, 0), rgb(255, 0, 0), rgb(0, 0, 0), rgb(0, 0, 0)] }),
    );
    expect(colours.unsupported[0]).toMatchObject({ property: 'borderColor' });
    const none = run(div({ ...base, borderWidth: sides(px(3)), borderStyle: sides('none'), borderColor: sides(rgb(0, 0, 0)) }));
    expect(none.unsupported).toEqual([]);
    expect(find(none.root, '$0.border')).toBeUndefined();
  });

  it('puts opacity, blend mode and filters on the group', () => {
    const { root, unsupported } = run(
      div({
        width: px(10),
        height: px(10),
        backgroundColor: rgb(0, 0, 0),
        opacity: 0.5,
        mixBlendMode: 'soft-light',
        filter: [
          { op: 'blur', radius: px(4) },
          { op: 'brightness', amount: 1.2 },
          { op: 'hue-rotate', angle: 30 },
          { op: 'opacity', amount: 0.5 },
          { op: 'drop-shadow', x: px(1), y: px(2), blur: px(6), color: rgb(0, 0, 0) },
        ],
      }),
    );
    expect(unsupported).toEqual([]);
    expect(root.opacity).toBe(0.25);
    expect(root.blendMode).toBe('softLight');
    expect(root.effects).toEqual([
      { type: 'blur', radius: 4 },
      { type: 'brightness', amount: 1.2 },
      { type: 'hueRotate', angle: 30 },
      { type: 'dropShadow', x: 1, y: 2, blur: 3, color: '#000000' },
    ]);
  });

  it('does not report what is not on screen: display none, and a hidden box keeps its place', () => {
    const bad = { diagnostics: [{ property: 'outline', value: '1px', reason: 'not supported' }] };
    const hidden = div({ display: 'none' });
    Object.assign(hidden, bad);
    const kept = div({ visibility: 'hidden', width: px(50), height: px(20), backgroundColor: rgb(255, 0, 0) });
    Object.assign(kept, bad);
    const after = div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) });
    const { root, unsupported } = run(div({}, [hidden, kept, after]));
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.0')).toBeUndefined();
    // Nothing of the hidden box is drawn, but it takes its 20 px.
    expect(find(root, '$0.1')).toBeUndefined();
    expect(find(root, '$0.2').transform).toEqual({ y: 20 });
  });

  it('reports the diagnostics of an element that is shown, once', () => {
    const shown = div({ width: px(10), height: px(10) });
    shown.diagnostics = [{ property: 'outline', value: '1px solid red', reason: 'not supported' }];
    const { unsupported } = run(div({}, [shown]));
    expect(unsupported).toEqual([
      { path: '$0.0 <div>', element: 'div', property: 'outline', value: '1px solid red', reason: 'not supported' },
    ]);
  });

  it('reports an element it does not know, and draws the rest', () => {
    const { root, unsupported } = run(
      div({}, [{ ...div(), type: 'canvas' }, div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) })]),
    );
    expect(unsupported).toEqual([expect.objectContaining({ path: '$0.0 <canvas>', element: 'canvas', property: null })]);
    expect(find(root, '$0.1.bg')).toBeDefined();
  });

  it('clips what overflow hides to the padding box, leaving the box own paint alone', () => {
    const { root } = run(
      div(
        {
          width: px(100),
          height: px(100),
          boxSizing: 'border-box',
          backgroundColor: rgb(0, 0, 0),
          overflowX: 'hidden',
          overflowY: 'hidden',
          borderWidth: sides(px(10)),
          borderStyle: sides('solid'),
          borderColor: sides(rgb(255, 255, 255)),
          borderRadius: corners(30),
        },
        [div({ width: px(200), height: px(20), backgroundColor: rgb(255, 0, 0) })],
      ),
    );
    const content = find(root, '$0.content');
    expect(content.clip.kind).toBe('path');
    // The padding box is 10..90 with the radius 30 - 10 = 20 inside.
    expect(content.clip.d).toMatch(/^M30 10 L70 10 A20 20 0 0 1 90 30/);
    expect(content.children.map((c: any) => c.id)).toEqual(['$0.0']);
    // The background and the border are not inside the clip.
    expect(root.children.map((c: any) => c.id)).toEqual(['$0.bg', '$0.border', '$0.content']);
  });

  it('cuts to clip-path shapes in the border box', () => {
    const base = { width: px(200), height: px(100), backgroundColor: rgb(0, 0, 0) };
    const circle = run(div({ ...base, clipPath: { kind: 'circle', r: px(30), cx: pct(50), cy: pct(50) } }));
    expect(circle.root.clip).toEqual({ kind: 'ellipse', cx: 100, cy: 50, rx: 30, ry: 30 });
    const polygon = run(div({ ...base, clipPath: { kind: 'polygon', points: [[pct(0), pct(0)], [pct(100), pct(0)], [pct(50), pct(100)]] } }));
    expect(polygon.root.clip).toEqual({ kind: 'polygon', points: [[0, 0], [200, 0], [100, 100]] });
    const inset = run(div({ ...base, clipPath: { kind: 'inset', sides: sides(px(10), px(20), px(10), px(20)), radius: corners(0) } }));
    expect(inset.root.clip).toEqual({ kind: 'path', d: 'M20 10 L180 10 L180 90 L20 90 Z' });
    const ellipse = run(div({ ...base, clipPath: { kind: 'ellipse', rx: pct(50), ry: 'closest-side', cx: pct(50), cy: pct(50) } }));
    expect(ellipse.root.clip).toEqual({ kind: 'ellipse', cx: 100, cy: 50, rx: 100, ry: 50 });
  });

  it('resolves em, rem and viewport lengths', () => {
    const { root } = run(div({ width: em(10), height: { unit: 'vh', value: 5 }, fontSize: px(20), backgroundColor: rgb(0, 0, 0) }));
    expect(find(root, '$0.bg').shape).toEqual({ kind: 'rect', width: 200, height: 40 });
  });
});
