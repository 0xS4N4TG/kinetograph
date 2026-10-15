// COMPAT.md §4.3 and §5.2: transforms, the camera, paint order.

import { describe, expect, it } from 'vitest';
import type { Length, TransformOp } from '../../src/css/types.js';
import { reduceTransform } from '../../src/dom/transform.js';
import { div, find, hasAddon, ids, pct, px, rgb, run } from './helpers.js';

const env = { fontSize: 16, viewport: { width: 1000, height: 800 } };
const box = { width: 200, height: 100 };
const translate = (x: Length, y: Length, z = px(0)): TransformOp => ({ op: 'translate', x, y, z });
const rotate = (angle: number, axis: 'x' | 'y' | 'z' = 'z'): TransformOp => ({ op: 'rotate', axis, angle });
const scale = (s: number): TransformOp => ({ op: 'scale', x: s, y: s, z: 1 });

describe('reduceTransform', () => {
  it('reduces translate, rotateX, rotateY, rotate and scale in the order the layer applies them', () => {
    expect(reduceTransform([translate(pct(50), px(10), px(5)), rotate(20, 'x'), rotate(30, 'y'), rotate(40), scale(2)], box, env)).toEqual({
      tx: 100, ty: 10, tz: 5, rotateX: 20, rotateY: 30, rotation: 40, scale: 2,
    });
  });

  it('sums translations, multiplies scales, and lets a scale and a turn about z swap', () => {
    expect(reduceTransform([translate(px(1), px(2)), translate(px(3), px(4)), scale(2), rotate(10), scale(3)], box, env)).toMatchObject({
      tx: 4, ty: 6, rotation: 10, scale: 6,
    });
  });

  it('reports what the layer transform cannot express', () => {
    const error = (list: TransformOp[]) => (reduceTransform(list, box, env) as { error: string }).error;
    expect(error([{ op: 'scale', x: 2, y: 1, z: 1 }])).toMatch(/uniform/);
    expect(error([{ op: 'skew', x: 10, y: 0 }])).toBe('skew');
    expect(error([rotate(10), translate(px(1), px(1))])).toMatch(/translation after/);
    expect(error([scale(2), rotate(10, 'x')])).toMatch(/rotateX/);
    expect(error([{ op: 'perspective', length: px(500) }])).toMatch(/perspective/);
    expect(error([{ op: 'matrix', values: [1, 0, 0.5, 1, 0, 0] }])).toMatch(/matrix/);
  });

  it('decomposes a matrix that is a translation, a rotation and a uniform scale', () => {
    const a = (Math.cos(Math.PI / 6) * 2);
    const b = (Math.sin(Math.PI / 6) * 2);
    const r = reduceTransform([{ op: 'matrix', values: [a, b, -b, a, 10, 20] }], box, env) as { scale: number; rotation: number; tx: number };
    expect(r.scale).toBeCloseTo(2, 9);
    expect(r.rotation).toBeCloseTo(30, 9);
    expect([r.tx, (r as any).ty]).toEqual([10, 20]);
  });
});

describe.skipIf(!hasAddon)('transformed boxes', () => {
  const base = { position: 'absolute' as const, inset: [px(100), 'auto', 'auto', px(50)] as [Length, 'auto', 'auto', Length], width: px(200), height: px(100), backgroundColor: rgb(0, 0, 0) };

  it('moves by a translation and turns about the origin (default: the centre)', () => {
    const { root, unsupported } = run(div({ ...base, transform: [translate(px(10), px(5)), rotate(45), scale(1.5)] }));
    expect(unsupported).toEqual([]);
    // The anchor is the origin, so the box turns about its centre: x = 50 + 10 + 100.
    expect(root.transform).toEqual({ x: 160, y: 155, anchorX: 100, anchorY: 50, rotation: 45, scale: 1.5 });
  });

  it('takes the transform-origin as the anchor', () => {
    const { root } = run(div({ ...base, transform: [rotate(90)], transformOrigin: [px(0), pct(100), px(0)] }));
    expect(root.transform).toEqual({ x: 50, y: 200, anchorX: 0, anchorY: 100, rotation: 90 });
  });

  it('maps 3D rotations and translateZ, and preserve-3d', () => {
    const { root, unsupported } = run(
      div({ ...base, transform: [translate(px(0), px(0), px(30)), rotate(20, 'x'), rotate(-10, 'y')], transformStyle: 'preserve-3d' }),
    );
    expect(unsupported).toEqual([]);
    expect(root).toMatchObject({ preserve3d: true, transform: { z: 30, rotateX: 20, rotateY: -10 } });
  });

  it('reports a transform it cannot express and draws the box where it was', () => {
    const { root, unsupported } = run(div({ ...base, transform: [{ op: 'skew', x: 10, y: 0 }] }));
    expect(unsupported).toEqual([expect.objectContaining({ property: 'transform', reason: expect.stringContaining('skew') })]);
    expect(root.transform).toEqual({ x: 50, y: 100 });
  });

  it('turns perspective into the camera at the perspective origin on the canvas', () => {
    const { camera, unsupported } = run(div({ ...base, perspective: px(800), perspectiveOrigin: [pct(0), pct(0)] }));
    expect(unsupported).toEqual([]);
    expect(camera).toEqual({ perspective: 800, x: 50, y: 100 });
    const defaulted = run(div({ ...base, perspective: px(500) }));
    expect(defaulted.camera).toEqual({ perspective: 500, x: 150, y: 150 });
  });

  it('reports a second, different perspective', () => {
    const { camera, unsupported } = run(div({}, [div({ ...base, perspective: px(500) }), div({ ...base, perspective: px(900) })]));
    expect(camera?.perspective).toBe(500);
    expect(unsupported).toEqual([expect.objectContaining({ property: 'perspective' })]);
    expect(run(div({}, [div({ ...base, perspective: px(500) }), div({ ...base, perspective: px(500) })])).unsupported).toEqual([]);
  });

  it('reports a perspective under a turned box', () => {
    const { unsupported } = run(div({ ...base, transform: [rotate(10)] }, [div({ ...base, perspective: px(500) })]));
    expect(unsupported).toEqual([expect.objectContaining({ property: 'perspective' })]);
  });
});

describe.skipIf(!hasAddon)('paint order', () => {
  const sq = (extra = {}, children: any[] = []) =>
    div({ position: 'absolute', inset: [px(0), 'auto', 'auto', px(0)], width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0), ...extra }, children);

  it('paints in-flow boxes, then positioned ones in tree order, by z-index', () => {
    const flow = div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) });
    const { root, unsupported } = run(
      div({}, [
        sq({ zIndex: 5 }),
        sq({ zIndex: -1 }),
        sq({ position: 'relative' }),
        flow,
        sq({ zIndex: 2 }),
        sq({ zIndex: 'auto' }),
      ]),
    );
    expect(unsupported).toEqual([]);
    // child numbers: 0 z5, 1 z-1, 2 relative, 3 flow, 4 z2, 5 absolute auto
    expect(root.children.filter((c: any) => c.id.match(/^\$0\.\d$/)).map((c: any) => c.id)).toEqual([
      '$0.1', '$0.3', '$0.2', '$0.5', '$0.4', '$0.0',
    ]);
  });

  it('orders the items of a flex container by order', () => {
    const { root } = run(
      div({ display: 'flex' }, [
        div({ order: 2, width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) }),
        div({ order: 1, width: px(20), height: px(10), backgroundColor: rgb(0, 0, 0) }),
      ]),
    );
    expect(ids(root).filter((i) => /^\$0\.\d$/.test(i))).toEqual(['$0.1', '$0.0']);
    expect(find(root, '$0.1').transform).toBeUndefined();
    expect(find(root, '$0.0').transform).toEqual({ x: 20 });
  });

  it('applies the z-index of a flex item without a position', () => {
    const { root } = run(
      div({ display: 'flex' }, [
        div({ zIndex: 3, width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) }),
        div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) }),
      ]),
    );
    expect(ids(root).filter((i) => /^\$0\.\d$/.test(i))).toEqual(['$0.1', '$0.0']);
  });

  it('reports a z-index that would reach out of a box that is not a stacking context', () => {
    // Two wrappers (no stacking context): the z-index of an inner box would interleave with the other wrapper's.
    const wrapper = (z: number) => div({ position: 'relative' }, [sq({ zIndex: z })]);
    const { unsupported } = run(div({}, [wrapper(1), wrapper(-1)]));
    expect(unsupported.some((u) => u.property === 'zIndex')).toBe(true);
    // Under a wrapper that is a stacking context it is fine.
    const context = (z: number) => div({ position: 'relative', zIndex: 0 }, [sq({ zIndex: z })]);
    expect(run(div({}, [context(1), context(-1)])).unsupported).toEqual([]);
  });
});
