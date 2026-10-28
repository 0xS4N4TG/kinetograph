// The matrices an SVG element's box goes through for getBoundingClientRect (../src/shim/svg-transform.ts). The cases
// are the ones checked against Chrome in packages/react/test/readback-native.test.tsx.
import { describe, expect, it } from 'vitest';
import { cssTransformMatrix, mapBox, parseViewBox, svgLength, viewBoxMatrix } from '../src/shim/svg-transform.js';

const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));

describe('viewBoxMatrix', () => {
  it('meets in the middle by default, and stretches for none', () => {
    close(viewBoxMatrix([0, 0, 100, 100], null, 200, 100), [1, 0, 0, 1, 50, 0]);
    close(viewBoxMatrix([0, 0, 100, 100], 'none', 200, 100), [2, 0, 0, 1, 0, 0]);
  });
  it('slices and aligns', () => {
    close(viewBoxMatrix([0, 0, 100, 100], 'xMinYMin slice', 200, 100), [2, 0, 0, 2, 0, 0]);
    close(viewBoxMatrix([0, 0, 100, 100], 'xMaxYMax meet', 200, 100), [1, 0, 0, 1, 100, 0]);
    close(viewBoxMatrix([10, 20, 100, 100], 'defer xMidYMax slice', 100, 200), [2, 0, 0, 2, -70, -40]);
  });
  it('reads a viewBox, and refuses an empty one', () => {
    expect(parseViewBox('0,0 10 20')).toEqual([0, 0, 10, 20]);
    expect(parseViewBox('0 0 0 20')).toBeNull();
    expect(parseViewBox(null)).toBeNull();
  });
});

describe('cssTransformMatrix', () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };
  it('is null for none', () => {
    expect(cssTransformMatrix('none', '0px 0px', box)).toBeNull();
  });
  it('turns about the origin, in deg, rad and turn', () => {
    const m = cssTransformMatrix('rotate(90deg)', '10px 10px', box)!;
    close(m, [0, 1, -1, 0, 20, 0]);
    close(cssTransformMatrix('rotate(0.25turn)', '10px 10px', box)!, m);
    close(cssTransformMatrix(`rotate(${Math.PI / 2}rad)`, '10px 10px', box)!, m);
  });
  it('takes percentages of the reference box', () => {
    close(cssTransformMatrix('translate(50%, 10%)', '0px 0px', box)!, [1, 0, 0, 1, 100, 10]);
    close(cssTransformMatrix('scale(2)', '50% 50%', box)!, [2, 0, 0, 2, -100, -50]);
  });
  it('composes left to right', () => {
    close(cssTransformMatrix('translate(10px) scale(2)', '0px 0px 0px', box)!, [2, 0, 0, 2, 10, 0]);
  });
});

describe('mapBox and svgLength', () => {
  it('bounds the corners', () => {
    const r = Math.SQRT1_2;
    const b = mapBox([r, r, -r, r, 0, 0], 0, 0, 30, 40);
    close([b.width, b.height], [70 * r, 70 * r]);
  });
  it('reads user units and percentages', () => {
    expect(svgLength('25%', 40)).toBe(10);
    expect(svgLength('7', 40)).toBe(7);
    expect(svgLength('auto', 40)).toBe(0);
  });
});
