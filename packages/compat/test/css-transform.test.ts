import { describe, expect, it } from 'vitest';
import { parseStyle, parseTransform, type Diagnostic, type TransformOp } from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });
const pct = (value: number) => ({ unit: '%' as const, value });
const ok = (value: string): TransformOp[] => {
  const r = parseTransform(value);
  if (!Array.isArray(r)) throw new Error(`${value}: ${r.reason}`);
  return r;
};
const bad = (value: string): Diagnostic => {
  const r = parseTransform(value);
  if (Array.isArray(r)) throw new Error(`${value} parsed`);
  return r;
};

describe('parseTransform', () => {
  it('reads none as the empty list', () => {
    expect(ok('none')).toEqual([]);
  });

  it('reads the translate family', () => {
    expect(ok('translate(-50%, -50%)')).toEqual([{ op: 'translate', x: pct(-50), y: pct(-50), z: px(0) }]);
    expect(ok('translate(10px)')).toEqual([{ op: 'translate', x: px(10), y: px(0), z: px(0) }]);
    expect(ok('translateX(2em)')).toEqual([{ op: 'translate', x: { unit: 'em', value: 2 }, y: px(0), z: px(0) }]);
    expect(ok('translateY(30%)')).toEqual([{ op: 'translate', x: px(0), y: pct(30), z: px(0) }]);
    expect(ok('translateZ(100px)')).toEqual([{ op: 'translate', x: px(0), y: px(0), z: px(100) }]);
    expect(ok('translate3d(1px, 2%, 3px)')).toEqual([{ op: 'translate', x: px(1), y: pct(2), z: px(3) }]);
    expect(ok('translate(0, 0)')).toEqual([{ op: 'translate', x: px(0), y: px(0), z: px(0) }]);
  });

  it('reads the scale family', () => {
    expect(ok('scale(1.5)')).toEqual([{ op: 'scale', x: 1.5, y: 1.5, z: 1 }]);
    expect(ok('scale(2, 0.5)')).toEqual([{ op: 'scale', x: 2, y: 0.5, z: 1 }]);
    expect(ok('scale(50%)')).toEqual([{ op: 'scale', x: 0.5, y: 0.5, z: 1 }]);
    expect(ok('scaleX(-1)')).toEqual([{ op: 'scale', x: -1, y: 1, z: 1 }]);
    expect(ok('scaleY(3)')).toEqual([{ op: 'scale', x: 1, y: 3, z: 1 }]);
    expect(ok('scaleZ(2)')).toEqual([{ op: 'scale', x: 1, y: 1, z: 2 }]);
    expect(ok('scale3d(1, 2, 3)')).toEqual([{ op: 'scale', x: 1, y: 2, z: 3 }]);
  });

  it('reads rotations and converts angles to degrees', () => {
    expect(ok('rotate(45deg)')).toEqual([{ op: 'rotate', axis: 'z', angle: 45 }]);
    expect(ok('rotateZ(-90deg)')).toEqual([{ op: 'rotate', axis: 'z', angle: -90 }]);
    expect(ok('rotateX(0.25turn)')).toEqual([{ op: 'rotate', axis: 'x', angle: 90 }]);
    expect(ok('rotateY(100grad)')).toEqual([{ op: 'rotate', axis: 'y', angle: 90 }]);
    const [rad] = ok('rotate(3.141592653589793rad)');
    expect(rad).toMatchObject({ op: 'rotate', axis: 'z' });
    expect((rad as { angle: number }).angle).toBeCloseTo(180);
    expect(ok('rotate(0)')).toEqual([{ op: 'rotate', axis: 'z', angle: 0 }]);
  });

  it('reduces rotate3d about an axis to a plain rotation, else a matrix', () => {
    expect(ok('rotate3d(0, 1, 0, 30deg)')).toEqual([{ op: 'rotate', axis: 'y', angle: 30 }]);
    expect(ok('rotate3d(0, 0, -2, 30deg)')).toEqual([{ op: 'rotate', axis: 'z', angle: -30 }]);
    const [m] = ok('rotate3d(1, 1, 0, 180deg)');
    expect(m!.op).toBe('matrix');
    const v = (m as { values: number[] }).values;
    expect(v).toHaveLength(16);
    // A half turn about (1,1,0)/sqrt2 swaps x and y and negates z.
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(1);
    expect(v[4]).toBeCloseTo(1);
    expect(v[10]).toBeCloseTo(-1);
  });

  it('reads skew', () => {
    expect(ok('skew(10deg)')).toEqual([{ op: 'skew', x: 10, y: 0 }]);
    expect(ok('skew(10deg, 20deg)')).toEqual([{ op: 'skew', x: 10, y: 20 }]);
    expect(ok('skewX(-15deg)')).toEqual([{ op: 'skew', x: -15, y: 0 }]);
    expect(ok('skewY(5deg)')).toEqual([{ op: 'skew', x: 0, y: 5 }]);
  });

  it('reads matrix, matrix3d and perspective', () => {
    expect(ok('matrix(1, 0, 0, 1, 10, 20)')).toEqual([{ op: 'matrix', values: [1, 0, 0, 1, 10, 20] }]);
    const m3 = '1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1';
    expect(ok(`matrix3d(${m3})`)).toEqual([{ op: 'matrix', values: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] }]);
    expect(ok('perspective(800px)')).toEqual([{ op: 'perspective', length: px(800) }]);
  });

  it('keeps the order of a list and reads mixed case', () => {
    expect(ok('translate(-50%, -50%) rotate(10deg) scale(2)  TranslateX(5px)')).toEqual([
      { op: 'translate', x: pct(-50), y: pct(-50), z: px(0) },
      { op: 'rotate', axis: 'z', angle: 10 },
      { op: 'scale', x: 2, y: 2, z: 1 },
      { op: 'translate', x: px(5), y: px(0), z: px(0) },
    ]);
  });

  it('gives a reason for what does not parse', () => {
    expect(bad('translate(10)')).toMatchObject({ property: 'transform', value: 'translate(10)' });
    expect(bad('translate(10)').reason).toMatch(/needs a unit/);
    expect(bad('translate(10px 20px)').reason).toMatch(/commas/);
    expect(bad('translate()').reason).toMatch(/needs arguments/);
    expect(bad('translate(1px, 2px, 3px)').reason).toMatch(/1 to 2 arguments/);
    expect(bad('rotate(45)').reason).toMatch(/expected an angle/);
    expect(bad('rotate(45px)').reason).toMatch(/expected an angle/);
    expect(bad('scale(1px)').reason).toMatch(/number or percentage/);
    expect(bad('translateZ(10%)').reason).toMatch(/percentage/);
    expect(bad('perspective(-1px)').reason).toMatch(/negative/);
    expect(bad('perspective(none)').reason).toMatch(/not supported/);
    expect(bad('matrix(1, 0, 0, 1, 0)').reason).toMatch(/6 arguments/);
    expect(bad('skew(1px)').reason).toMatch(/angle/);
    expect(bad('wiggle(1)').reason).toMatch(/wiggle\(\) is not supported/);
    expect(bad('translate(10px) banana').reason).toMatch(/expected a transform function/);
    expect(bad('translate(10px, 20px').reason).toMatch(/unclosed/);
  });

  it('refuses calc, var and CSS-wide keywords', () => {
    expect(bad('translateX(calc(100% - 10px))').reason).toBe('calc() is not supported');
    expect(bad('translateX(var(--x))').reason).toBe('var() is not supported');
    expect(bad('translateX(env(safe-area-inset-left))').reason).toBe('env() is not supported');
    expect(bad('inherit').reason).toMatch(/CSS-wide keyword/);
  });

  it('ignores !important', () => {
    expect(ok('scale(2) !important')).toEqual([{ op: 'scale', x: 2, y: 2, z: 1 }]);
  });
});

describe('transformOrigin, perspective and perspectiveOrigin in parseStyle', () => {
  const origin = (v: string | number) => parseStyle({ transformOrigin: v });
  it('reads keywords and lengths', () => {
    expect(origin('center').style.transformOrigin).toEqual([pct(50), pct(50), px(0)]);
    expect(origin('left').style.transformOrigin).toEqual([pct(0), pct(50), px(0)]);
    expect(origin('top').style.transformOrigin).toEqual([pct(50), pct(0), px(0)]);
    expect(origin('bottom right').style.transformOrigin).toEqual([pct(100), pct(100), px(0)]);
    expect(origin('right bottom').style.transformOrigin).toEqual([pct(100), pct(100), px(0)]);
    expect(origin('top left').style.transformOrigin).toEqual([pct(0), pct(0), px(0)]);
    expect(origin('20px 30%').style.transformOrigin).toEqual([px(20), pct(30), px(0)]);
    expect(origin('left 10px').style.transformOrigin).toEqual([pct(0), px(10), px(0)]);
    expect(origin('10px bottom').style.transformOrigin).toEqual([px(10), pct(100), px(0)]);
    expect(origin('50% 50% 20px').style.transformOrigin).toEqual([pct(50), pct(50), px(20)]);
    expect(origin('center center 0').style.transformOrigin).toEqual([pct(50), pct(50), px(0)]);
    expect(origin(10).style.transformOrigin).toEqual([px(10), pct(50), px(0)]);
  });

  it('refuses edge offsets, bad pairs and percentage depths', () => {
    expect(origin('right 10px bottom 20px').unsupported[0]!.reason).toMatch(/edge-offset/);
    expect(origin('left 10px top').unsupported[0]!.reason).toMatch(/edge-offset/);
    expect(origin('10px left').unsupported[0]!.reason).toMatch(/horizontal|valid position/);
    expect(origin('top bottom').unsupported[0]!.reason).toMatch(/valid position/);
    expect(origin('left left').unsupported[0]!.reason).toMatch(/valid position/);
    expect(origin('50% 50% 10%').unsupported[0]!.reason).toMatch(/edge-offset/);
    expect(origin('middle').unsupported[0]!.reason).toMatch(/not a position keyword/);
  });

  it('reads perspective and perspectiveOrigin', () => {
    expect(parseStyle({ perspective: 1200 }).style.perspective).toEqual(px(1200));
    expect(parseStyle({ perspective: 'none' }).style.perspective).toBe('none');
    expect(parseStyle({ perspective: '-5px' }).unsupported).toHaveLength(1);
    expect(parseStyle({ perspectiveOrigin: '50% 100%' }).style.perspectiveOrigin).toEqual([pct(50), pct(100)]);
    expect(parseStyle({ transformStyle: 'preserve-3d' }).style.transformStyle).toBe('preserve-3d');
    expect(parseStyle({ transformStyle: 'flat' }).style.transformStyle).toBe('flat');
    expect(parseStyle({ transformStyle: 'curved' }).unsupported[0]!.reason).toMatch(/not one of/);
  });
});
